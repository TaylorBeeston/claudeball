/**
 * The Web Audio side: one AudioContext, four buses (sfx, crowd, organ+PA, master), a stadium reverb send, a capped voice pool and
 * cached AudioBuffers rendered once from `synth.ts` (a few variants per sound, generated a chunk at a time after unlock so no
 * frame ever stalls for long).
 *
 *   sfx voices -> [pan] -> [lowpass] -> sfxBus -> sfxFilter -> master
 *   crowd bed / reactions -> crowdBus -> master           organ / PA chime -> organBus -> master (+ reverb send)
 *   master -> compressor -> analyser -> destination
 *
 * Everything is optional: with no AudioContext (old browser, node) `unlock()` returns false and every play call is a no-op.
 */
import type { Cue, CrowdId, SfxId, Vec3 } from './types';
import { DEFAULT_LISTENER, spatialize, type Listener } from './spatial';
import { CROWD_IDS, SFX_DEFS, crowdLoop, renderCrowd, renderSfx } from './synth';
import { mulberry32, type Rendered } from './dsp';

export const MAX_VOICES = 32;
/** output makeup gain ahead of the compressor (the synthesised buffers are normalised conservatively) */
const MAKEUP = 2;
/** park music at the full slider: sits a little under the crowd bed and the PA */
const MUSIC_LEVEL = 1.0;

/** the organ bus at full slider: organ notes are summed chords, so this sits them level with the crowd bed and effects */
const ORGAN_LEVEL = 1.0;
/** PA bus gain at slider 1 (the default slider 0.55 is about 4-5 dB under the old fixed level) */
const PA_LEVEL = 2.0;

export interface Settings {
  master: number;
  sfx: number;
  crowd: number;
  announcer: number;
  /** the stadium PA announcer's own volume (field channel); the umpire shares it */
  paVolume: number;
  /** camera-transition whooshes, replay stings and graphic blips (`broadcastfx.ts`) */
  fxVolume: number;
  /** park music (`parkmusic.ts`): the level and the on / off switch */
  musicVolume: number;
  music: boolean;
  muted: boolean;
  /** PA announcer + umpire calls */
  pa: boolean;
  /** play-by-play + colour commentary */
  commentary: boolean;
  /** the stadium organ on/off (the app menu) */
  organ: boolean;
  /** organ volume 0..1 */
  organVolume: number;
  /** how much the commentators say: `low` keeps only the big plays (no chatter); `high` talks more and banters more */
  chatter: 'low' | 'normal' | 'high';
  /** HD (neural) voices switched on (the model must have been downloaded) */
  hd: boolean;
}

export const DEFAULT_SETTINGS: Settings = { master: 0.8, sfx: 0.8, crowd: 0.7, organVolume: 0.85, announcer: 0.7, paVolume: 0.55, fxVolume: 0.5, musicVolume: 0.5, music: true, muted: false, pa: true, commentary: true, organ: true, chatter: 'normal', hd: false };

interface Voice {
  src: AudioBufferSourceNode;
  nodes: AudioNode[];
  id: string;
  imp: number;
  start: number;
}

/** Minimum seconds between two plays of the same sound (keeps 2x/4x play and rapid-fire events from turning into a buzz). */
const MIN_GAP: Partial<Record<string, number>> = {
  footstep: 0.11,
  base_thud: 0.15,
  glove_pop: 0.05,
  throw_whip: 0.08,
  swing_whoosh: 0.2,
  pitch_whoosh: 0.3,
  ground_bounce: 0.06,
  dirt_thud: 0.06,
  slide_scuff: 0.25,
};

/** Minimum seconds between two plays of the same crowd sound (a clap pattern needs short gaps; the rest must not stack up). */
const CROWD_GAP: Partial<Record<string, number>> = { clap_burst: 0.1, clap_single: 0.12, whistle: 1.5, shout: 1.2, shout2: 1.2, kid: 6, vendor: 4, chatter: 2, aww: 0.5, ooh: 0.3, gasp: 0.5, oh_relief: 0.6 };

export class Mixer {
  ctx: AudioContext | null = null;
  settings: Settings;
  listener: Listener = DEFAULT_LISTENER;
  readonly buffers = new Map<string, AudioBuffer[]>();
  private voices = new Set<Voice>();
  private crowdVoices = new Set<AudioBufferSourceNode>();
  private last = new Map<string, number>();
  private rnd = mulberry32(1234);
  master!: GainNode;
  sfxBus!: GainNode;
  crowdBus!: GainNode;
  /** broadcast stings (camera whooshes, replay sting, graphic blips): their own level, unaffected by the replay filter */
  fxBus!: GainNode;
  /** park music (`park/player.ts`): the stadium PA layer's music, under the voices */
  musicBus!: GainNode;
  private musicDuck = 1;
  /** the bed and the one-shots of the crowd enter here; the camera's distance to the stands sets its gain */
  crowdProx!: GainNode;
  /** phone-class device: fewer simultaneous crowd voices */
  lowPower = false;
  organBus!: GainNode;
  private sfxFilter!: BiquadFilterNode;
  reverbIn!: GainNode;
  /** neural (HD) voices: dry booth voices and the processed PA voice come in here */
  voiceBus!: GainNode;
  /** the stadium PA and the umpire (field channel) and the broadcast booth, separate so they can overlap and duck each other */
  paBus!: GainNode;
  boothBus!: GainNode;
  private duck = { pa: 1, booth: 1 };
  analyser: AnalyserNode | null = null;
  ready = false;
  prepared = 0;
  totalToPrepare = 0;
  replay = false;
  paused = false;
  /** someone is speaking: the organ and crowd sit back */
  speaking = false;
  droppedVoices = 0;
  stolenVoices = 0;
  /** counters per sound id, for debug and tests */
  readonly played: Record<string, number> = {};

  constructor(settings: Settings = { ...DEFAULT_SETTINGS }, private factory: () => AudioContext = () => new AudioContext({ latencyHint: 'interactive' })) {
    this.settings = settings;
  }

  get state(): string {
    return this.ctx?.state ?? 'none';
  }

  /** Create (first call) and resume the context. Must be called from a user gesture. Returns whether audio is running. */
  async unlock(): Promise<boolean> {
    try {
      if (!this.ctx) {
        this.ctx = this.factory();
        this.build(this.ctx);
      }
      if (this.ctx.state !== 'running') await this.ctx.resume();
      if (this.ctx.state === 'running' && !this.ready) this.prepare();
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  private build(ctx: AudioContext) {
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master.connect(comp);
    try {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      comp.connect(this.analyser);
      this.analyser.connect(ctx.destination);
    } catch {
      comp.connect(ctx.destination);
    }
    this.sfxBus = ctx.createGain();
    this.sfxFilter = ctx.createBiquadFilter();
    this.sfxFilter.type = 'lowpass';
    this.sfxFilter.frequency.value = 20000;
    this.sfxBus.connect(this.sfxFilter);
    this.sfxFilter.connect(this.master);
    this.crowdBus = ctx.createGain();
    this.crowdBus.connect(this.master);
    this.fxBus = ctx.createGain();
    this.fxBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.crowdProx = ctx.createGain();
    this.crowdProx.connect(this.crowdBus);
    this.organBus = ctx.createGain();
    this.organBus.connect(this.master);
    this.voiceBus = ctx.createGain();
    this.voiceBus.connect(this.master);
    this.paBus = ctx.createGain();
    this.paBus.connect(this.voiceBus);
    this.boothBus = ctx.createGain();
    this.boothBus.connect(this.voiceBus);
    // stadium reverb: a synthetic decaying-noise impulse
    this.reverbIn = ctx.createGain();
    this.reverbIn.gain.value = 1;
    try {
      const conv = ctx.createConvolver();
      conv.buffer = this.impulse(ctx, 1.9);
      const ret = ctx.createGain();
      ret.gain.value = 0.32;
      this.reverbIn.connect(conv);
      conv.connect(ret);
      ret.connect(this.master);
      this.organBus.connect(this.reverbIn);
      const msend = ctx.createGain();
      msend.gain.value = 0.12; // a little stadium room on the music
      this.musicBus.connect(msend);
      msend.connect(this.reverbIn);
    } catch {
      /* no reverb */
    }
    this.applySettings();
  }

  private impulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const b = ctx.createBuffer(2, n, sr);
    const r = mulberry32(99);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const k = 0.5 + 0.45 * Math.exp(-t * 2.2); // darker as it decays
        lp += (r() * 2 - 1 - lp) * k;
        d[i] = lp * Math.exp(-t * 2.6) * (i < 200 ? i / 200 : 1);
      }
    }
    return b;
  }

  applySettings() {
    if (!this.ctx) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    const m = s.muted ? 0 : s.master * s.master * MAKEUP;
    this.master.gain.setTargetAtTime(m, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(this.paused ? 0 : s.sfx * s.sfx * (this.replay ? 0.6 : 1), t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.paused || !s.music ? 0 : s.musicVolume * s.musicVolume * MUSIC_LEVEL * this.musicDuck, t, 0.15);
    this.fxBus.gain.setTargetAtTime(this.paused ? 0 : s.fxVolume * s.fxVolume * 1.3, t, 0.05);
    this.crowdBus.gain.setTargetAtTime(s.crowd * s.crowd * (this.paused ? 0.5 : this.speaking ? 0.8 : 1), t, 0.25);
    this.organBus.gain.setTargetAtTime(this.paused ? 0 : (s.organ ? s.organVolume * s.organVolume : 0) * ORGAN_LEVEL * (this.speaking ? 0.4 : 1), t, this.speaking ? 0.15 : 0.4);
    this.sfxFilter.frequency.setTargetAtTime(this.replay ? 900 : 20000, t, 0.08);
    this.voiceBus.gain.setTargetAtTime(s.announcer * 1.6, t, 0.05);
    this.paBus.gain.setTargetAtTime(s.paVolume * s.paVolume * PA_LEVEL * this.duck.pa, t, 0.12);
    this.boothBus.gain.setTargetAtTime(this.duck.booth, t, 0.12);
  }

  /** the PA is ducked (about -5 dB) while the booth talks, the booth a little (about -2 dB) under the PA: neither is muted */
  setVoiceDuck(pa: number, booth: number) {
    if (pa === this.duck.pa && booth === this.duck.booth) return;
    this.duck = { pa, booth };
    this.applySettings();
  }

  /** the music sits under the booth (-6 dB) and the PA, and under big crowd moments: 0..1 (the controller works it out) */
  setMusicDuck(d: number) {
    if (Math.abs(d - this.musicDuck) < 0.01) return;
    this.musicDuck = d;
    this.applySettings();
  }

  /** camera closer to the stands = a louder crowd (0.7 .. 1.4, smoothed) */
  setCrowdProximity(g: number) {
    if (!this.ctx) return;
    this.crowdProx.gain.setTargetAtTime(g, this.ctx.currentTime, 0.6);
  }

  /** slow-motion replay: SFX go dull and slow, the crowd carries on. Pause: the field goes quiet, the murmur stays. */
  setMode(o: { replay?: boolean; paused?: boolean; speaking?: boolean }) {
    if (o.replay !== undefined) this.replay = o.replay;
    if (o.paused !== undefined) this.paused = o.paused;
    if (o.speaking !== undefined) this.speaking = o.speaking;
    this.applySettings();
  }

  setListener(l: Listener) {
    this.listener = l;
  }

  // ---- buffers -------------------------------------------------------------------------------------------------------

  private toBuffer(r: Rendered): AudioBuffer {
    const b = this.ctx!.createBuffer(r.ch.length, r.ch[0].length, r.sr);
    for (let c = 0; c < r.ch.length; c++) b.copyToChannel(r.ch[c] as Float32Array<ArrayBuffer>, c);
    return b;
  }

  /** Render every sound a chunk per timer tick so no frame stalls; `onDone` fires when the last one is ready. */
  prepare(onDone?: () => void) {
    if (!this.ctx || this.ready) return;
    const jobs: (() => void)[] = [];
    const ids = Object.keys(SFX_DEFS) as SfxId[];
    // most common sounds first
    const order: SfxId[] = ['mitt_pop', 'bat_crack', 'glove_pop', 'swing_whoosh', 'pitch_whoosh', 'throw_whip', ...ids];
    for (const id of new Set(order)) {
      const d = SFX_DEFS[id];
      for (let b = 0; b < d.buckets; b++)
        for (let a = 0; a < d.alts; a++)
          jobs.push(() => {
            const list = this.buffers.get(id) ?? [];
            list[b * d.alts + a] = this.toBuffer(renderSfx(id, b, a));
            this.buffers.set(id, list);
          });
    }
    for (const id of CROWD_IDS) jobs.push(() => this.buffers.set(`crowd:${id}`, [this.toBuffer(renderCrowd(id))]));
    jobs.push(() => this.buffers.set('loop:murmur', [this.toBuffer(crowdLoop('murmur'))]));
    jobs.push(() => this.buffers.set('loop:roar', [this.toBuffer(crowdLoop('roar'))]));
    jobs.push(() => this.buffers.set('loop:claps', [this.toBuffer(crowdLoop('claps'))]));
    this.totalToPrepare = jobs.length;
    let i = 0;
    const next = () => {
      const t0 = performance.now();
      while (i < jobs.length && performance.now() - t0 < 6) {
        try {
          jobs[i]();
        } catch {
          /* a failed recipe only loses that sound */
        }
        i++;
        this.prepared = i;
      }
      if (i < jobs.length) setTimeout(next, 0);
      else {
        this.ready = true;
        onDone?.();
        void this.loadSamples();
      }
    };
    setTimeout(next, 0);
  }

  /** Real recordings that replace the synthesised version of a crowd sound: only what `audio/manifest.json` lists (so nothing 404s). */
  samples: string[] = [];

  async loadSamples(base: string = import.meta.env?.BASE_URL ?? '/'): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || typeof fetch === 'undefined') return;
    try {
      const res = await fetch(`${base}audio/manifest.json`);
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return;
      const man = (await res.json()) as Record<string, string[]>;
      for (const [key, files] of Object.entries(man)) {
        if (!key.startsWith('crowd:') || !Array.isArray(files)) continue;
        const decoded: AudioBuffer[] = [];
        for (const f of files) {
          try {
            const r = await fetch(`${base}audio/${f}`);
            if (!r.ok) continue;
            decoded.push(await ctx.decodeAudioData(await r.arrayBuffer()));
            this.samples.push(f);
          } catch {
            /* a file that fails to load or decode leaves the synthesised sound in place */
          }
        }
        if (decoded.length) this.buffers.set(key, decoded);
      }
    } catch {
      /* no manifest: synthesised sounds only */
    }
  }

  // ---- playing -------------------------------------------------------------------------------------------------------

  private allow(id: string, now: number): boolean {
    const gap = MIN_GAP[id];
    if (gap === undefined) return true;
    const l = this.last.get(id) ?? -9;
    if (now - l < gap) return false;
    this.last.set(id, now);
    return true;
  }

  /** Play a positional sound effect cue. Returns true if a voice was started. */
  playSfx(c: Extract<Cue, { kind: 'sfx' }>): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.ready || ctx.state !== 'running') return false;
    const list = this.buffers.get(c.id);
    const def = SFX_DEFS[c.id];
    if (!list || !def) return false;
    const now = ctx.currentTime;
    if (!this.allow(c.id, now)) return false;
    const bucket = Math.min(def.buckets - 1, Math.max(0, c.bucket ?? 0));
    const alt = Math.floor(this.rnd() * def.alts);
    const buffer = list[bucket * def.alts + alt] ?? list.find(Boolean);
    if (!buffer) return false;
    if (this.voices.size >= MAX_VOICES && !this.stealFor(c.imp)) {
      this.droppedVoices++;
      return false;
    }
    const sp = c.pos ? spatialize(this.listener, c.pos as Vec3) : { gain: 1, pan: 0, cutoff: 20000, dist: 0 };
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const fx = c.id.startsWith('bfx_');
    const slow = this.replay && !fx ? 0.6 : 1;
    src.playbackRate.value = (c.rate ?? 1) * (0.96 + this.rnd() * 0.08) * slow;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1.5, (c.gain ?? 1) * sp.gain);
    const nodes: AudioNode[] = [gain];
    let tail: AudioNode = gain;
    src.connect(gain);
    if (sp.cutoff < 15000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = sp.cutoff;
      tail.connect(lp);
      tail = lp;
      nodes.push(lp);
    }
    if (ctx.createStereoPanner && Math.abs(sp.pan) > 0.01) {
      const p = ctx.createStereoPanner();
      p.pan.value = sp.pan;
      tail.connect(p);
      tail = p;
      nodes.push(p);
    }
    tail.connect(fx ? this.fxBus : this.sfxBus);
    const v: Voice = { src, nodes, id: c.id, imp: c.imp, start: now };
    this.voices.add(v);
    src.onended = () => {
      this.voices.delete(v);
      try {
        src.disconnect();
        for (const n of nodes) n.disconnect();
      } catch {
        /* already gone */
      }
    };
    src.start(now + Math.max(0, c.delay ?? 0));
    this.played[c.id] = (this.played[c.id] ?? 0) + 1;
    return true;
  }

  /** free a voice for a more important cue: drop the oldest voice that is less important */
  private stealFor(imp: number): boolean {
    let victim: Voice | null = null;
    for (const v of this.voices) if (v.imp < imp && (!victim || v.imp < victim.imp || (v.imp === victim.imp && v.start < victim.start))) victim = v;
    if (!victim) return false;
    try {
      victim.src.stop();
    } catch {
      /* not started yet */
    }
    this.voices.delete(victim);
    try {
      victim.src.disconnect();
      for (const n of victim.nodes) n.disconnect();
    } catch {
      /* ignore */
    }
    this.stolenVoices++;
    return true;
  }

  /**
   * Non-positional crowd reaction (stereo one-shot on the crowd bus). `o.pan` places it in the stands, `o.sweep` moves it across them
   * (the wave), `o.rate` changes pitch and length. At the voice cap only louder sounds get through.
   */
  playCrowd(id: CrowdId, gain = 1, delay = 0, o: { pan?: number; rate?: number; sweep?: { from: number; to: number; dur: number } } = {}): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.ready || ctx.state !== 'running') return false;
    const list = this.buffers.get(`crowd:${id}`);
    const b = list?.[Math.floor(this.rnd() * list.length)];
    if (!b) return false;
    const now = ctx.currentTime;
    const key = `crowd:${id}`;
    if (now - (this.last.get(key) ?? -9) < (CROWD_GAP[id] ?? 0.8)) return false;
    const cap = this.lowPower ? 3 : 6;
    if (this.crowdVoices.size >= cap && !(gain > 0.6 && this.crowdVoices.size < cap + 2)) return false;
    this.last.set(key, now);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = (o.rate ?? 1) * (0.98 + this.rnd() * 0.04);
    const g = ctx.createGain();
    g.gain.value = Math.min(1.4, gain);
    src.connect(g);
    let pan: StereoPannerNode | null = null;
    if ((o.pan !== undefined || o.sweep) && typeof ctx.createStereoPanner === 'function') {
      pan = ctx.createStereoPanner();
      const from = o.sweep ? o.sweep.from : o.pan!;
      pan.pan.setValueAtTime(Math.max(-1, Math.min(1, from)), now + Math.max(0, delay));
      if (o.sweep) pan.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, o.sweep.to)), now + Math.max(0, delay) + o.sweep.dur);
      g.connect(pan);
      pan.connect(this.crowdProx);
    } else g.connect(this.crowdProx);
    this.crowdVoices.add(src);
    src.onended = () => {
      this.crowdVoices.delete(src);
      try {
        src.disconnect();
        g.disconnect();
        pan?.disconnect();
      } catch {
        /* ignore */
      }
    };
    src.start(now + Math.max(0, delay));
    this.played[key] = (this.played[key] ?? 0) + 1;
    return true;
  }

  get voiceCount() {
    return this.voices.size + this.crowdVoices.size;
  }

  /** RMS and peak of the last 2048 output samples (0 when there is no analyser). */
  level(): { rms: number; peak: number } {
    const a = this.analyser;
    if (!a) return { rms: 0, peak: 0 };
    const d = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(d);
    let s = 0;
    let p = 0;
    for (let i = 0; i < d.length; i++) {
      s += d[i] * d[i];
      p = Math.max(p, Math.abs(d[i]));
    }
    return { rms: Math.sqrt(s / d.length), peak: p };
  }

  /** stop everything and release the context */
  dispose() {
    for (const v of [...this.voices]) this.stealFor(99);
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.ready = false;
  }
}

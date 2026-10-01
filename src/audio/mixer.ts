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

export interface Settings {
  master: number;
  sfx: number;
  crowd: number;
  announcer: number;
  muted: boolean;
  /** PA announcer + umpire calls */
  pa: boolean;
  /** play-by-play + colour commentary */
  commentary: boolean;
  /** the stadium organ */
  organ: boolean;
  /** how much the commentators say: `low` keeps only the big plays (no colour commentary) */
  chatter: 'low' | 'normal' | 'high';
}

export const DEFAULT_SETTINGS: Settings = { master: 0.8, sfx: 0.8, crowd: 0.7, announcer: 0.7, muted: false, pa: true, commentary: true, organ: true, chatter: 'normal' };

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
  organBus!: GainNode;
  private sfxFilter!: BiquadFilterNode;
  private reverbIn!: GainNode;
  analyser: AnalyserNode | null = null;
  ready = false;
  prepared = 0;
  totalToPrepare = 0;
  replay = false;
  paused = false;
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
    this.organBus = ctx.createGain();
    this.organBus.connect(this.master);
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
    this.crowdBus.gain.setTargetAtTime(s.crowd * s.crowd * (this.paused ? 0.5 : 1), t, 0.2);
    this.organBus.gain.setTargetAtTime(this.paused ? 0 : s.crowd * s.crowd * 0.55, t, 0.1);
    this.sfxFilter.frequency.setTargetAtTime(this.replay ? 900 : 20000, t, 0.08);
  }

  /** slow-motion replay: SFX go dull and slow, the crowd carries on. Pause: the field goes quiet, the murmur stays. */
  setMode(o: { replay?: boolean; paused?: boolean }) {
    if (o.replay !== undefined) this.replay = o.replay;
    if (o.paused !== undefined) this.paused = o.paused;
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
    const slow = this.replay ? 0.6 : 1;
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
    tail.connect(this.sfxBus);
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

  /** Non-positional crowd reaction (stereo one-shot on the crowd bus). */
  playCrowd(id: CrowdId, gain = 1, delay = 0): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.ready || ctx.state !== 'running') return false;
    const list = this.buffers.get(`crowd:${id}`);
    const b = list?.[Math.floor(this.rnd() * list.length)];
    if (!b) return false;
    const now = ctx.currentTime;
    const key = `crowd:${id}`;
    if (now - (this.last.get(key) ?? -9) < 0.8) return false;
    if (this.crowdVoices.size >= 4) return false;
    this.last.set(key, now);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = 0.97 + this.rnd() * 0.06;
    const g = ctx.createGain();
    g.gain.value = Math.min(1.4, gain);
    src.connect(g);
    g.connect(this.crowdBus);
    this.crowdVoices.add(src);
    src.onended = () => {
      this.crowdVoices.delete(src);
      try {
        src.disconnect();
        g.disconnect();
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

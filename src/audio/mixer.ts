/**
 * The Web Audio side: one AudioContext, the park soundscape picked up by a fixed microphone array and the broadcast mix
 * (`venue/graph.ts`), a capped voice pool and cached AudioBuffers rendered once from `synth.ts` (a few variants per sound, generated a
 * chunk at a time after unlock so no frame ever stalls for long).
 *
 *   field effects (positional) -> mic array (K pickups with propagation delays) -> park bus -> duck -> master
 *   crowd (zones, diffuse roars) -> mic array                organ / park music / PA voice -> organBus / musicBus / paBus -> PA system -> mic array
 *   umpire voice -> umpireBus (at the plate) -> mic array    booth voices -> boothIn(role) -> booth chain -> voiceBus (announcer) -> master
 *   broadcast stings -> fxBus -> master (dry)                replay effects -> replay path (slowed, dulled) -> park bus
 *   master -> HP 60 Hz -> glue -> limiter -> soft clip -> analyser -> destination
 *
 * The active camera does not change the mix: a broadcast never uses camera audio.
 * Everything is optional: with no AudioContext (old browser, node) `unlock()` returns false and every play call is a no-op.
 */
import type { Cue, CrowdId, SfxId, Vec3 } from './types';
import { CROWD_IDS, SFX_DEFS } from './synth';
import { runJob, type SynthJob } from './synthJobs';
import { mulberry32, type Rendered } from './dsp';
import { TRIM, VenueGraph, type Perspective, type Played } from './venue/graph';
import type { VenuePreset } from './venue/ir';
import { WAVE_ORDER, LOW_FOLD, zone as zoneOf, zoneForPan, type ZoneId } from './venue/mics';
import type { CrowdShot } from './crowd';
import { perf } from '../engine/perf';

export const MAX_VOICES = 32;
/** master gain at the full slider, ahead of the master chain (sets the loudness: about -16 LUFS integrated at the default volume) */
const MAKEUP = 4.9;
/** park music at the full slider (into the PA system) */
const MUSIC_LEVEL = 0.1;
/** the organ at the full slider (into the PA system) */
const ORGAN_LEVEL = 0.1;
/** PA voice at slider 1 (into the PA system) */
const PA_LEVEL = 0.72;
/** booth voices at the full announcer slider (after the booth's compressor) */
const BOOTH_LEVEL = 1.23;
/** duck depth (dB) and presence cut (dB) per setting */
export const DUCK_LEVELS = { light: { depth: 4, eqDepth: 2.5 }, normal: { depth: 7, eqDepth: 4 }, strong: { depth: 10, eqDepth: 5 } } as const;

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
  /** the ballpark's acoustics: reverb length and level, slap-back (`venue/ir.ts`) */
  venue: VenuePreset;
  /** the A1's balance: the broadcast mix, or the field mics up and the crowd back ("close") */
  micPerspective: Perspective;
  /** how far the park sits back under the booth (4 / 7 / 10 dB) */
  duck: 'light' | 'normal' | 'strong';
}

export const DEFAULT_SETTINGS: Settings = { master: 0.8, sfx: 0.8, crowd: 0.7, organVolume: 0.85, announcer: 0.7, paVolume: 0.55, fxVolume: 0.5, musicVolume: 0.5, music: true, muted: false, pa: true, commentary: true, organ: true, chatter: 'normal', hd: false, venue: 'normal', micPerspective: 'broadcast', duck: 'normal' };

interface Voice {
  srcs: AudioBufferSourceNode[];
  nodes: AudioNode[];
  id: string;
  imp: number;
  start: number;
  /** sources still playing */
  left: number;
  /** when its last copy ends on the audio clock (the cap counts by this, not by when `onended` reaches a busy main thread) */
  end: number;
  done?: boolean;
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
  readonly buffers = new Map<string, AudioBuffer[]>();
  private voices = new Set<Voice>();
  private crowdVoices = new Set<Voice>();
  private last = new Map<string, number>();
  private rnd = mulberry32(1234);
  /** the park, the mic array and the broadcast chains (`venue/graph.ts`) */
  graph: VenueGraph | null = null;
  /** the master volume (into the master chain) */
  master!: GainNode;
  /** broadcast stings (camera whooshes, replay sting, graphic blips): dry and centred, straight to the master, not ducked */
  fxBus!: GainNode;
  /** park music (`park/player.ts`): plays through the PA system */
  musicBus!: GainNode;
  private musicDuck = 1;
  /** a stadium-wide crowd input (the diffuse bed / old callers): the house pair and the crowd mics */
  crowdBus!: GainNode;
  /** kept for older callers: same as `crowdBus` (the camera no longer changes the crowd) */
  crowdProx!: GainNode;
  /** phone-class device: fewer mics, pickups, zones and simultaneous crowd voices */
  lowPower = false;
  /** the organ (plays through the PA system) */
  organBus!: GainNode;
  reverbIn!: GainNode;
  /** booth voices after their dynamics: the announcer slider (and the sidechain key is taken here) */
  voiceBus!: GainNode;
  /** the PA announcer's raw voice: into the PA system (band-limited horns, clusters, slap-back, the bowl's reverb) */
  paBus!: GainNode;
  /** the umpire's raw voice: a source at the plate, heard by the field mics */
  umpireBus!: GainNode;
  /** the booth chain's input (per-voice EQ first: use `boothIn(role)`) */
  boothBus!: GainNode;
  private duck = { pa: 1, booth: 1 };
  /** booth / PA activity from the speech gate (`setVoices`) */
  private talk = { pa: false, booth: false, routed: false };
  private crowdEnergy = 0;
  get analyser(): AnalyserNode | null {
    return this.graph?.analyser ?? null;
  }
  ready = false;
  prepared = 0;
  totalToPrepare = 0;
  replay = false;
  paused = false;
  /** someone is speaking (older callers): the organ sits back under the PA */
  speaking = false;
  droppedVoices = 0;
  stolenVoices = 0;
  /** level meters on every mic strip (`?audiodebug=1`) */
  meters = false;
  /** rendering offline (the render tool): no real-time timers */
  private offline = false;
  private duckTimer: ReturnType<typeof setInterval> | null = null;
  private debugFlags = { boothSilent: false, noReverb: false, noConvolver: false, noOversample: false, noWorklet: false, linearShapers: false };
  /** counters per sound id, for debug and tests */
  readonly played: Record<string, number> = {};

  constructor(settings: Settings = { ...DEFAULT_SETTINGS }, private factory: () => AudioContext = () => newContext(this.lowPower)) {
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
    const g = new VenueGraph(ctx, { lowPower: this.lowPower, venue: this.settings.venue, perspective: this.settings.micPerspective, meters: this.meters, ir: this.irFromWorker, profile: { noConvolver: this.debugFlags.noConvolver, noOversample: this.debugFlags.noOversample, noWorklet: this.debugFlags.noWorklet, linearShapers: this.debugFlags.linearShapers } });
    this.graph = g;
    const gain = () => ctx.createGain();
    // the master volume is the master chain's input: the park bus, the booth and the stings all sum there
    this.master = g.master;
    this.fxBus = gain();
    this.fxBus.connect(g.master);
    this.organBus = gain();
    this.organBus.connect(g.paIn);
    this.musicBus = gain();
    this.musicBus.connect(g.paIn);
    this.paBus = gain();
    this.paBus.connect(g.paIn);
    this.umpireBus = gain();
    this.umpireBus.connect(g.umpireIn);
    this.boothBus = g.boothBus;
    // the analyser duck (phones / no worklet) reads the booth ~50 times a second (a few microseconds; nothing to do when quiet); with
    // the worklet there is no timer at all
    void g.ready.then(() => {
      if (g.needsPump && !this.offline && this.graph === g && typeof setInterval !== 'undefined') this.duckTimer = setInterval(() => {
        const t = perf.t();
        this.graph?.pumpDuck();
        if (perf.on) perf.outside('audio.duck', t);
      }, 20);
    });
    this.voiceBus = g.boothFader;
    this.reverbIn = g.reverbIn;
    // crowd bed (diffuse): the house pair and the side crowd mics
    this.crowdBus = gain();
    this.crowdProx = this.crowdBus;
    for (const id of ['house_l', 'house_r', 'crowd_3b', 'crowd_1b'] as const) {
      const s = g.strips.get(id);
      if (s) this.crowdBus.connect(s.input);
    }
    this.applySettings();
  }

  /** resolves when the reverb IR and the duck worklet are in place */
  whenReady(): Promise<void> {
    return this.graph?.ready ?? Promise.resolve();
  }

  /** the render tool: an OfflineAudioContext, stepped by the caller */
  setOffline(on: boolean) {
    this.offline = on;
  }

  /** the render tool's step (offline: no timers): the analyser duck in `dt` slices of 20 ms */
  offlineTick(dt: number) {
    for (let t = 0; t < dt - 1e-6; t += 0.02) this.graph?.pumpDuck(0.02);
  }

  setDebug(f: Partial<{ boothSilent: boolean; noReverb: boolean; noConvolver: boolean; noOversample: boolean; noWorklet: boolean; linearShapers: boolean }>) {
    this.debugFlags = { ...this.debugFlags, ...f };
    this.applySettings();
  }

  applySettings() {
    if (!this.ctx || !this.graph) return;
    const s = this.settings;
    const g = this.graph;
    const t = this.ctx.currentTime;
    const m = s.muted ? 0 : s.master * s.master * MAKEUP;
    this.master.gain.setTargetAtTime(m, t, 0.03);
    this.musicBus.gain.setTargetAtTime(this.paused || !s.music ? 0 : s.musicVolume * s.musicVolume * MUSIC_LEVEL * this.musicDuck, t, 0.15);
    this.fxBus.gain.setTargetAtTime(this.paused ? 0 : s.fxVolume * s.fxVolume * 1.3, t, 0.05);
    this.crowdBus.gain.setTargetAtTime(this.crowdLevel(), t, 0.25);
    // the organist lays out under the PA announcer (the booth is handled by the sidechain duck)
    const paTalking = this.talk.pa || (this.speaking && !this.talk.booth);
    this.organBus.gain.setTargetAtTime(this.paused ? 0 : (s.organ ? s.organVolume * s.organVolume : 0) * ORGAN_LEVEL * (paTalking ? 0.5 : 1), t, paTalking ? 0.15 : 0.4);
    const pa = s.paVolume * s.paVolume * PA_LEVEL * s.announcer;
    this.paBus.gain.setTargetAtTime(pa, t, 0.12);
    this.umpireBus.gain.setTargetAtTime(pa, t, 0.12);
    this.voiceBus.gain.setTargetAtTime(s.announcer * BOOTH_LEVEL * this.duck.booth, t, 0.05);
    g.boothOut.gain.setValueAtTime(this.debugFlags.boothSilent ? 0 : 1, t);
    g.setVenue(s.venue);
    g.setPerspective(s.micPerspective);
    g.setDuck(DUCK_LEVELS[s.duck] ?? DUCK_LEVELS.normal);
    if (this.debugFlags.noReverb) g.reverbRet.gain.setValueAtTime(0, t);
  }

  /** the crowd's level into the mic array (slider, pause) */
  crowdLevel(): number {
    const s = this.settings;
    return s.crowd * s.crowd * TRIM.bed * (this.paused ? 0.5 : 1);
  }

  /** the booth sits a little (about -2 dB) under the PA; the PA's duck under the booth is the sidechain's (`setVoices`) */
  setVoiceDuck(pa: number, booth: number) {
    if (pa === this.duck.pa && booth === this.duck.booth) return;
    this.duck = { pa, booth };
    this.applySettings();
  }

  /**
   * Who is talking (from the speech gate). `routed`: the voices play through Web Audio (HD / custom voice), so the duck follows the
   * booth's real envelope; browser speech is outside Web Audio, so the gate's flag keys the duck instead.
   */
  setVoices(v: { pa: boolean; booth: boolean; routed: boolean }) {
    const changed = v.pa !== this.talk.pa || v.booth !== this.talk.booth || v.routed !== this.talk.routed;
    this.talk = { ...v };
    if (!this.graph) return;
    this.graph.setKey(v.booth && !v.routed ? 1 : 0);
    if (changed) this.applySettings();
  }

  /** big crowd moments: the music sits back and the duck under the booth gets shallower (a home-run roar stays big under the call) */
  setCrowdEnergy(e: number) {
    this.crowdEnergy = e;
    this.graph?.setDuckScale(1 - 0.55 * Math.min(1, Math.max(0, (e - 0.55) / 0.4)));
  }

  /** the music sits under big crowd moments: 0..1 (the controller works it out) */
  setMusicDuck(d: number) {
    if (Math.abs(d - this.musicDuck) < 0.01) return;
    this.musicDuck = d;
    this.applySettings();
  }

  /** no-op: the camera does not change the mix (kept for older callers) */
  setCrowdProximity(_g: number) {}

  /** slow-motion replay: SFX go dull and slow, the crowd carries on. Pause: the field goes quiet, the murmur stays. */
  setMode(o: { replay?: boolean; paused?: boolean; speaking?: boolean }) {
    if (o.replay !== undefined) this.replay = o.replay;
    if (o.paused !== undefined) this.paused = o.paused;
    if (o.speaking !== undefined) this.speaking = o.speaking;
    this.applySettings();
  }

  /** a booth voice's way in: its own EQ, then the booth chain */
  boothIn(role: string): AudioNode {
    return this.graph ? this.graph.boothIn(role) : this.boothBus;
  }

  // ---- buffers -------------------------------------------------------------------------------------------------------

  private toBuffer(r: Rendered): AudioBuffer {
    const b = this.ctx!.createBuffer(r.ch.length, r.ch[0].length, r.sr);
    for (let c = 0; c < r.ch.length; c++) b.copyToChannel(r.ch[c] as Float32Array<ArrayBuffer>, c);
    return b;
  }

  /**
   * Synthesise every sound (`synthJobs.ts`); `onDone` fires when the last one is ready. In a worker when there is one (about a second of
   * maths, single jobs up to ~100 ms on a fast desktop: run on the main thread they froze frames as the game started), otherwise on the
   * main thread a slice per timer tick (the offline render tool, tests). Results land as they come, most common sounds first.
   */
  prepare(onDone?: () => void) {
    if (!this.ctx || this.ready || this.preparing) return;
    this.preparing = true;
    const sr = this.ctx.sampleRate;
    const jobs: { job: SynthJob; put: (b: AudioBuffer) => void }[] = [];
    const ids = Object.keys(SFX_DEFS) as SfxId[];
    // most common sounds first
    const order: SfxId[] = ['mitt_pop', 'bat_crack', 'glove_pop', 'swing_whoosh', 'pitch_whoosh', 'throw_whip', ...ids];
    for (const id of new Set(order)) {
      const d = SFX_DEFS[id];
      // park sounds go into mono mic strips: mono at the context's rate (no resampling per copy on the audio thread); the broadcast
      // stings stay as rendered (stereo, dry)
      for (let b = 0; b < d.buckets; b++)
        for (let a = 0; a < d.alts; a++)
          jobs.push({
            job: { k: 'sfx', id, b, a },
            put: (buf) => {
              const list = this.buffers.get(id) ?? [];
              list[b * d.alts + a] = buf;
              this.buffers.set(id, list);
            },
          });
    }
    for (const id of CROWD_IDS) jobs.push({ job: { k: 'crowd', id }, put: (b) => this.buffers.set(`crowd:${id}`, [b]) });
    // the bed loops play all the time in every zone: mono (the zones and the mics make the width) at the context's own rate
    for (const k of ['murmur', 'roar', 'claps'] as const) jobs.push({ job: { k: 'loop', kind: k }, put: (b) => this.buffers.set(`loop:${k}`, [b]) });
    this.totalToPrepare = jobs.length;
    const ctx = this.ctx;
    let done = 0;
    const finish = () => {
      this.ready = true;
      this.preparing = false;
      onDone?.();
      void this.loadSamples();
    };
    const land = (k: number, r: Rendered) => {
      if (this.ctx !== ctx) return;
      try {
        jobs[k].put(this.toBuffer(r));
      } catch {
        /* a failed recipe only loses that sound */
      }
      this.prepared = ++done;
      if (done === jobs.length) finish();
    };
    // main-thread fallback: from job `from` on, a slice of at most 6 ms per timer tick
    const local = (from: number) => {
      let i = from;
      const next = () => {
        const t0 = performance.now();
        while (i < jobs.length && performance.now() - t0 < 6) {
          let r: Rendered | null = null;
          try {
            r = runJob(jobs[i].job, sr);
          } catch {
            /* a failed recipe only loses that sound */
          }
          if (r) land(i, r);
          else this.prepared = ++done;
          i++;
        }
        if (i < jobs.length) setTimeout(next, 0);
        else if (done >= jobs.length && !this.ready) finish();
      };
      setTimeout(next, 0);
    };
    const w = this.offline ? null : this.synthWorker();
    if (!w) return local(0);
    let next = 0;
    w.onmessage = (e: MessageEvent<{ n: number; sr: number; ch?: Float32Array[]; error?: string }>) => {
      const m = e.data;
      if (m.n < 0) return; // an IR job (see `irFromWorker`)
      if (m.ch) land(m.n, { sr: m.sr, ch: m.ch });
      else this.prepared = ++done;
      next = Math.max(next, m.n + 1);
      if (done === jobs.length && !this.ready) finish();
    };
    w.onerror = () => {
      // the worker could not run (CSP, an old browser): the rest on the main thread
      this.dropWorker();
      local(next);
    };
    jobs.forEach((j, n) => w.postMessage({ n, job: j.job, sr }));
  }

  private preparing = false;
  private levelBuf: Float32Array<ArrayBuffer> | null = null;
  private hiddenSuspended = false;

  /** the page is hidden / shown again: suspend the context (no rendering at all) and resume it only if it was running before */
  async setHidden(hidden: boolean) {
    const c = this.ctx;
    if (!c || this.offline) return;
    try {
      if (hidden && c.state === 'running') {
        this.hiddenSuspended = true;
        await c.suspend();
      } else if (!hidden && this.hiddenSuspended) {
        this.hiddenSuspended = false;
        await c.resume();
      }
    } catch {
      /* the next gesture unlocks it again */
    }
  }
  private worker: Worker | null = null;
  private irJobs = new Map<number, (r: Rendered | null) => void>();
  private irSeq = -1;

  /** the synthesis worker (one per mixer, closed with it), or null where workers do not exist */
  private synthWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;
    try {
      this.worker = new Worker(new URL('./synthWorker.ts', import.meta.url), { type: 'module' });
      this.worker.addEventListener('message', (e: MessageEvent<{ n: number; sr: number; ch?: Float32Array[] }>) => {
        const cb = this.irJobs.get(e.data.n);
        if (!cb) return;
        this.irJobs.delete(e.data.n);
        cb(e.data.ch ? { sr: e.data.sr, ch: e.data.ch } : null);
      });
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private dropWorker() {
    this.worker?.terminate();
    this.worker = null;
    for (const cb of this.irJobs.values()) cb(null);
    this.irJobs.clear();
  }

  /** the stadium IR made in the worker (null: make it here) */
  private irFromWorker = (venue: VenuePreset, sr: number, lowPower: boolean): Promise<Rendered | null> => {
    const w = this.offline ? null : this.synthWorker();
    if (!w) return Promise.resolve(null);
    const n = this.irSeq--;
    return new Promise((res) => {
      this.irJobs.set(n, res);
      w.postMessage({ n, job: { k: 'ir', venue, lowPower }, sr });
    });
  };

  /** Real recordings that replace the synthesised version of a crowd sound: only what `audio/manifest.json` lists (so nothing 404s). */
  samples: string[] = [];

  async loadSamples(base: string = import.meta.env?.BASE_URL ?? '/'): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || typeof fetch === 'undefined' || this.offline) return;
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

  /**
   * A voice counts until its end on the audio clock (`prune`), not until `onended` reaches the main thread (late on a busy phone, and
   * the count would then depend on frame timing); `onended` of the last copy only releases the nodes early.
   */
  private track(set: Set<Voice>, v: Voice) {
    set.add(v);
    // offline (the render tool) the clean-up waits for `prune` at a fixed audio time: `onended` arrives whenever the main thread gets
    // to it, and disconnecting a filter then cuts its last few samples of ringing at a different point on every run
    if (this.offline) return;
    const end = () => {
      if (--v.left > 0) return;
      this.release(v);
    };
    for (const s of v.srcs) s.onended = end;
  }

  /** voices whose sound is over by the audio clock leave the count now (their `onended` cleans up again, harmlessly) */
  private prune(set: Set<Voice>, now: number) {
    for (const v of set)
      if (v.end <= now) {
        set.delete(v);
        this.release(v);
      }
  }

  private release(v: Voice) {
    if (v.done) return;
    v.done = true;
    try {
      for (const s of v.srcs) s.disconnect();
      for (const n of v.nodes) n.disconnect();
    } catch {
      /* already gone */
    }
  }

  /** a single source into one node (broadcast stings, the replay path, the PA) */
  private single(buffer: AudioBuffer, gain: number, rate: number, when: number, dest: AudioNode): Played {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start(when);
    return { srcs: [src], nodes: [g], end: when + (buffer.duration || 0) / rate };
  }

  /**
   * Play a sound effect cue. Field sounds are positioned in the park and picked up by the mic array (`venue/mics.ts`): the same buffer
   * reaches up to three mics, each after its own flight time. One logical voice counts against the cap however many mics hear it.
   * Returns true if a voice was started.
   */
  playSfx(c: Extract<Cue, { kind: 'sfx' }>): boolean {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g || !this.ready || ctx.state !== 'running') return false;
    const list = this.buffers.get(c.id);
    const def = SFX_DEFS[c.id];
    if (!list || !def) return false;
    const now = ctx.currentTime;
    if (!this.allow(c.id, now)) return false;
    // broadcast-layer sounds (camera stings, the replay whoosh): dry, centred, not in the park
    const fx = c.id.startsWith('bfx_') || c.id === 'replay_whoosh';
    if (this.paused && !fx) return false;
    const bucket = Math.min(def.buckets - 1, Math.max(0, c.bucket ?? 0));
    const alt = Math.floor(this.rnd() * def.alts);
    const buffer = list[bucket * def.alts + alt] ?? list.find(Boolean);
    if (!buffer) return false;
    this.prune(this.voices, now);
    if (this.voices.size >= MAX_VOICES && !this.stealFor(c.imp)) {
      this.droppedVoices++;
      return false;
    }
    // one buffer, one rate for every copy (the copies are the same sound at different mics)
    const jitter = 0.96 + this.rnd() * 0.08;
    const slow = this.replay && !fx ? 0.6 : 1;
    const rate = (c.rate ?? 1) * jitter * slow;
    const when = now + Math.max(0, c.delay ?? 0);
    const s = this.settings;
    let r: Played;
    if (fx) r = this.single(buffer, Math.min(1.5, c.gain ?? 1), rate, when, this.fxBus);
    else if (c.id === 'pa_click') r = this.single(buffer, (c.gain ?? 1) * 2, rate, when, this.paBus);
    else if (this.replay) r = this.single(buffer, Math.min(1.5, (c.gain ?? 1) * s.sfx * s.sfx * 0.6), rate, when, g.replayBus);
    else r = g.playAt(buffer, (c.pos as Vec3 | undefined) ?? DEFAULT_POS, Math.min(1.5, c.gain ?? 1) * s.sfx * s.sfx * TRIM.sfx, when, rate);
    if (!r.srcs.length) return false;
    this.track(this.voices, { srcs: r.srcs, nodes: r.nodes, id: c.id, imp: c.imp, start: now, left: r.srcs.length, end: r.end });
    this.played[c.id] = (this.played[c.id] ?? 0) + 1;
    return true;
  }

  /** free a voice for a more important cue: drop the oldest voice that is less important */
  private stealFor(imp: number): boolean {
    let victim: Voice | null = null;
    for (const v of this.voices) if (v.imp < imp && (!victim || v.imp < victim.imp || (v.imp === victim.imp && v.start < victim.start))) victim = v;
    if (!victim) return false;
    for (const s of victim.srcs) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* not started yet */
      }
    }
    this.voices.delete(victim);
    this.release(victim);
    this.stolenVoices++;
    return true;
  }

  /**
   * A crowd one-shot in the stands: `zone` places it (one section of seats, picked up by the crowd mic over it and, later and darker, by
   * the others); `diffuse` is the whole bowl (big roars: the house pair, the crowd mics and the reverb). With neither, `pan` picks the
   * zone; a `sweep` (the wave) becomes the same sound section after section around the bowl. At the voice cap only louder sounds get in.
   */
  playCrowd(id: CrowdId, gain = 1, delay = 0, o: { pan?: number; rate?: number; sweep?: { from: number; to: number; dur: number }; zone?: ZoneId; diffuse?: boolean } = {}): boolean {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g || !this.ready || ctx.state !== 'running') return false;
    const list = this.buffers.get(`crowd:${id}`);
    const b = list?.[Math.floor(this.rnd() * list.length)];
    if (!b) return false;
    const now = ctx.currentTime;
    const key = `crowd:${id}`;
    if (now - (this.last.get(key) ?? -9) < (CROWD_GAP[id] ?? 0.8)) return false;
    this.prune(this.crowdVoices, now);
    const cap = this.lowPower ? 3 : 6;
    if (this.crowdVoices.size >= cap && !(gain > 0.6 && this.crowdVoices.size < cap + 2)) return false;
    this.last.set(key, now);
    const rate = (o.rate ?? 1) * (0.98 + this.rnd() * 0.04);
    const level = Math.min(1.4, gain) * this.crowdLevel() * (TRIM.crowd / TRIM.bed);
    const when = now + Math.max(0, delay);
    let r: Played;
    if (o.sweep) {
      // the wave: section after section, a cheer rising and moving on
      const order = o.sweep.from > o.sweep.to ? WAVE_ORDER : [...WAVE_ORDER].reverse();
      const zs = this.lowPower ? order.filter((_, i) => i % 2 === 0) : order;
      r = { srcs: [], nodes: [], end: when };
      zs.forEach((z, i) => {
        const p = this.seat(z);
        const part = g.playAt(b, p, level * 0.8, when + (o.sweep!.dur * i) / zs.length, rate, this.lowPower ? 1 : 2);
        r.srcs.push(...part.srcs);
        r.nodes.push(...part.nodes);
        r.end = Math.max(r.end, part.end);
      });
    } else if (o.diffuse || (o.zone === undefined && o.pan === undefined)) r = g.playDiffuse(b, level, when, rate, 0.15 + 0.25 * Math.min(1, gain));
    else r = g.playAt(b, this.seat(o.zone ?? zoneForPan(o.pan ?? 0, this.rnd() < 0.25)), level, when, rate, this.lowPower ? 1 : 2);
    if (!r.srcs.length) return false;
    this.track(this.crowdVoices, { srcs: r.srcs, nodes: r.nodes, id, imp: 0, start: now, left: r.srcs.length, end: r.end });
    this.played[key] = (this.played[key] ?? 0) + 1;
    return true;
  }

  /** a seat somewhere in a zone (on phones, the zone it folds into) */
  private seat(z: ZoneId): Vec3 {
    const zz = zoneOf(this.lowPower ? LOW_FOLD[z] : z);
    const r = () => (this.rnd() * 2 - 1) * zz.spread * 0.5;
    return { x: zz.pos.x + r(), y: zz.pos.y + Math.abs(r()) * 0.3, z: zz.pos.z + r() };
  }

  /** a crowd model shot (`crowd.ts`): its zone / pan / sweep, or a seat banging somewhere */
  playCrowdShot(s: CrowdShot): boolean {
    if (s.id === 'seat_thump') return this.playSfx({ kind: 'sfx', id: 'seat_thump', pos: this.seat(s.zone ?? zoneForPan(s.pan ?? 0)), gain: s.gain, imp: 0, delay: s.delay });
    return this.playCrowd(s.id, s.gain, s.delay, { pan: s.pan, rate: s.rate, sweep: s.sweep, zone: s.zone, diffuse: s.diffuse });
  }

  /** voices sounding now (by the audio clock) */
  get voiceCount() {
    const now = this.ctx?.currentTime ?? 0;
    this.prune(this.voices, now);
    this.prune(this.crowdVoices, now);
    return this.voices.size + this.crowdVoices.size;
  }

  /** RMS and peak of the last 2048 output samples (0 when there is no analyser). */
  level(): { rms: number; peak: number } {
    const a = this.analyser;
    if (!a) return { rms: 0, peak: 0 };
    if (this.levelBuf?.length !== a.fftSize) this.levelBuf = new Float32Array(a.fftSize);
    const d = this.levelBuf;
    a.getFloatTimeDomainData(d);
    let s = 0;
    let p = 0;
    for (let i = 0; i < d.length; i++) {
      s += d[i] * d[i];
      p = Math.max(p, Math.abs(d[i]));
    }
    return { rms: Math.sqrt(s / d.length), peak: p };
  }

  /** for the debug panel / render tool */
  debugInfo() {
    const g = this.graph;
    return {
      voices: this.voices.size,
      crowdVoices: this.crowdVoices.size,
      sources: [...this.voices, ...this.crowdVoices].reduce((n, v) => n + v.left, 0),
      dropped: this.droppedVoices,
      stolen: this.stolenVoices,
      played: this.played,
      graph: g ? { ...g.stats, mics: g.mics.length, venue: g.venue, perspective: g.perspective, duck: g.duck } : null,
      talk: this.talk,
      crowdEnergy: this.crowdEnergy,
    };
  }

  /** stop everything and release the context */
  dispose() {
    this.dropWorker();
    this.preparing = false;
    if (this.duckTimer) clearInterval(this.duckTimer);
    this.duckTimer = null;
    for (const _ of [...this.voices]) this.stealFor(99);
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.graph = null;
    this.ready = false;
  }
}

export { monoAt } from './synthJobs';

/**
 * The context's sample rate: the device's own (48 kHz on most). `?audiorate=32000` (an experiment, measured in tools/perf/FINDINGS.md, pass 2):
 * the phone graph's audio thread -24 % with the output resampler included, but the mix moves (organ -0.56 LUFS, the duck engages a little
 * earlier, true peak +0.5 dB), so it is not the default. `lowPower` is where a default for phones would go.
 */
export function contextRate(lowPower: boolean, q = typeof location !== 'undefined' ? location.search : ''): number | undefined {
  void lowPower;
  const f = new URLSearchParams(q).get('audiorate');
  if (f && Number(f) >= 8000 && Number(f) <= 96000) return Number(f);
  return undefined;
}
function newContext(lowPower: boolean): AudioContext {
  const sampleRate = contextRate(lowPower);
  try {
    return new AudioContext(sampleRate ? { latencyHint: 'interactive', sampleRate } : { latencyHint: 'interactive' });
  } catch {
    return new AudioContext({ latencyHint: 'interactive' }); // a rate this browser refuses: its own
  }
}

/** where an effect with no position is: the plate */
const DEFAULT_POS: Vec3 = { x: 0, y: 1, z: 0 };

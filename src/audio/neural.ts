/**
 * Optional neural ("HD") voices: Kokoro-82M running in the browser, played through Web Audio so the PA voice can get stadium
 * processing (which browser speech synthesis cannot). Strictly opt-in and lazily imported (this file is a separate chunk), see
 * `neuralWorker.ts` for what is fetched and from where. Not cloned from anyone: these are Kokoro's preset voices.
 *
 * `NeuralSpeechEngine` implements the same `SpeechEngine` interface as the browser voices, so there is still exactly one speech
 * queue and nothing can overlap. The queue asks it to `prefetch` the next line while the current one plays; generation runs in a
 * worker, one job at a time. If generation fails or is too slow for a line, that line falls back to the browser's voice.
 */
import type { Mixer } from './mixer';
import type { SpeakHandle, SpeakOptions, SpeechEngine } from './speech';
import { clauses } from './broadcast/text';
import type { SpeakRole } from './types';
import { HD_MODES, type HdMode } from './hdInfo';

export const HD_VOICES: Record<SpeakRole, string> = { pa: 'am_onyx', ump: 'am_adam', pbp: 'am_michael', color: 'bm_george' };

export { HD_MODES, pickMode, type HdMode } from './hdInfo';

export interface Synth {
  init(mode: HdMode, onProgress: (loaded: number, total: number) => void): Promise<void>;
  generate(text: string, voice: string, speed: number): Promise<{ samples: Float32Array; sr: number }>;
  dispose(): void;
}

/** the real synthesiser: a module worker (not used in tests) */
export class WorkerSynth implements Synth {
  private w: Worker | null = null;
  private jobs = new Map<number, { res: (v: { samples: Float32Array; sr: number }) => void; rej: (e: Error) => void }>();
  private seq = 1;

  init(mode: HdMode, onProgress: (loaded: number, total: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./neuralWorker.ts', import.meta.url), { type: 'module' });
      this.w = w;
      const files = new Map<string, { loaded: number; total: number }>();
      w.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === 'progress' && m.p?.file) {
          if (m.p.status === 'progress' || m.p.status === 'done') files.set(m.p.file, { loaded: m.p.loaded ?? m.p.total ?? 0, total: m.p.total ?? 0 });
          let l = 0;
          let t = 0;
          for (const f of files.values()) {
            l += f.loaded;
            t += f.total;
          }
          onProgress(l, t);
        } else if (m.type === 'ready') resolve();
        else if (m.type === 'error') reject(new Error(m.message));
        else if (m.type === 'audio') {
          const j = this.jobs.get(m.id);
          if (!j) return;
          this.jobs.delete(m.id);
          if (m.error) j.rej(new Error(m.error));
          else j.res({ samples: m.samples, sr: m.sr });
        }
      };
      w.onerror = (e) => reject(new Error(e.message || 'worker failed'));
      w.postMessage({ type: 'init', device: HD_MODES[mode].device, dtype: HD_MODES[mode].dtype });
    });
  }

  generate(text: string, voice: string, speed: number) {
    return new Promise<{ samples: Float32Array; sr: number }>((res, rej) => {
      if (!this.w) return rej(new Error('no worker'));
      const id = this.seq++;
      this.jobs.set(id, { res, rej });
      this.w.postMessage({ type: 'gen', id, text, voice, speed });
    });
  }

  dispose() {
    this.w?.terminate();
    this.w = null;
    for (const j of this.jobs.values()) j.rej(new Error('disposed'));
    this.jobs.clear();
  }
}

// ---- model cache (transformers.js stores downloads in the browser Cache API) -------------------------------------------------

const CACHE_NAME = 'transformers-cache';

export async function isCached(mode: HdMode): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    const c = await caches.open(CACHE_NAME);
    const keys = await c.keys();
    const want = mode === 'gpu' ? 'onnx/model.onnx' : 'onnx/model_quantized.onnx';
    return keys.some((k) => k.url.includes('Kokoro-82M') && k.url.includes(want));
  } catch {
    return false;
  }
}

export async function clearCache(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
  } catch {
    /* ignore */
  }
}

// ---- the engine --------------------------------------------------------------------------------------------------------------

interface Gen {
  p: Promise<AudioBuffer>;
  /** estimated audio seconds (for the backlog estimate) */
  est: number;
  done: boolean;
}

interface Job {
  key: string;
  text: string;
  voice: string;
  speed: number;
  prio: number;
  seq: number;
  est: number;
  resolve: (b: AudioBuffer) => void;
  reject: (e: Error) => void;
}

const MAX_CACHE = 64;
const WAIT_MS = 20000;
/** job priorities: a line being spoken now, the next line the queue will speak, background warm-up of fixed phrases */
export const PRIO = { now: 0, next: 1, warm: 2 } as const;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class NeuralSpeechEngine implements SpeechEngine {
  ready = false;
  /** Web Audio: any number of lines can play at once (PA over booth, booth over booth) */
  readonly concurrent = true;
  /** measured generation time / audio time, smoothed (starts from the mode's expectation) */
  rtf: number;
  /** lines that fell back to the browser voice, and failures (debug) */
  readonly stats = { generated: 0, played: 0, fallbacks: 0, failures: 0, lastRtf: 0, clauses: 0 };
  private cache = new Map<string, Gen>();
  private jobs: Job[] = [];
  private inflight: Job | null = null;
  private seq = 0;
  private playing = new Set<{ src: AudioBufferSourceNode; nodes: AudioNode[]; shift: number }>();
  private lines = new Set<{ stop(): void }>();
  private paused = false;

  constructor(private synth: Synth, private mixer: Mixer | null, private fallback: SpeechEngine | null, mode: HdMode = 'cpu') {
    this.rtf = mode === 'gpu' ? 0.25 : 3;
  }

  /** the audio controller of a game (or the preview's own mixer) plays the lines; generation works without one */
  setMixer(m: Mixer | null) {
    this.mixer = m;
  }

  async init(mode: HdMode, onProgress: (loaded: number, total: number) => void) {
    await this.synth.init(mode, onProgress);
    this.ready = true;
  }

  voices() {
    return this.ready ? Object.values(HD_VOICES).map((name) => ({ name, lang: 'en-US' })) : [];
  }

  voiceFor(role: SpeakRole) {
    return HD_VOICES[role];
  }

  /** estimated ms until a line requested now would be ready */
  busyMs() {
    let secs = 0;
    for (const j of this.jobs) secs += j.est;
    if (this.inflight) secs += this.inflight.est;
    return secs * this.rtf * 1000;
  }

  private key(text: string, voice: string, speed: number) {
    return `${voice}|${speed.toFixed(2)}|${text}`;
  }

  /** One generation job at a time, in priority order (a spoken line never waits behind background warm-up). */
  private request(text: string, voice: string, speed: number, prio: number): Gen | null {
    const k = this.key(text, voice, speed);
    const hit = this.cache.get(k);
    if (hit) {
      const queued = this.jobs.find((j) => j.key === k);
      if (queued && prio < queued.prio) queued.prio = prio;
      return hit;
    }
    const est = Math.max(0.6, text.length / 14);
    let job!: Job;
    const p = new Promise<AudioBuffer>((resolve, reject) => {
      job = { key: k, text, voice, speed, prio, seq: this.seq++, est, resolve, reject };
    });
    const gen: Gen = { est, done: false, p };
    const fin = () => {
      gen.done = true;
    };
    p.then(fin, fin);
    this.jobs.push(job);
    this.cache.set(k, gen);
    while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    this.pump();
    return gen;
  }

  private pump() {
    if (this.inflight || !this.jobs.length) return;
    this.jobs.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    const job = this.jobs.shift()!;
    this.inflight = job;
    const t0 = performance.now();
    this.synth
      .generate(job.text, job.voice, job.speed)
      .then((r) => {
        const ctx = this.mixer?.ctx;
        // an AudioBuffer belongs to no context: lines can be generated before any game (or context) exists
        const b = ctx ? ctx.createBuffer(1, r.samples.length, r.sr) : new AudioBuffer({ numberOfChannels: 1, length: r.samples.length, sampleRate: r.sr });
        b.copyToChannel(r.samples as Float32Array<ArrayBuffer>, 0);
        const secs = r.samples.length / r.sr;
        const ratio = (performance.now() - t0) / 1000 / Math.max(0.3, secs);
        this.stats.lastRtf = ratio;
        this.rtf += (ratio - this.rtf) * 0.4; // the worker runs one job at a time: this ratio is never inflated by a queue
        this.stats.generated++;
        job.resolve(b);
      })
      .catch((e) => {
        this.cache.delete(job.key);
        job.reject(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        this.inflight = null;
        this.pump();
      });
  }

  private params(o: Pick<SpeakOptions, 'voiceName' | 'role' | 'rate' | 'shift'>) {
    const voice = o.voiceName ?? HD_VOICES[o.role ?? 'pbp'];
    const shift = clamp(o.shift ?? 1, 0.9, 1.15);
    const speed = clamp(o.rate / shift, 0.7, 1.3);
    return { voice, shift, speed };
  }

  /** the pieces a line is synthesised in: booth lines clause by clause (the first is ready sooner and a cut can happen at a clause), other lines whole */
  private pieces(text: string, role?: SpeakRole): string[] {
    if (role !== 'pbp' && role !== 'color') return [text];
    const c = clauses(text);
    // very short clauses sound choppy on their own: merge them into the next
    const out: string[] = [];
    for (const piece of c) {
      if (out.length && (out[out.length - 1].split(/\s+/).length < 3)) out[out.length - 1] += ` ${piece}`;
      else out.push(piece);
    }
    return out.length ? out : [text];
  }

  /** start synthesising a line that will be spoken soon (the queue's next line, or a fixed phrase) */
  prefetch(text: string, o: Omit<SpeakOptions, 'onend' | 'onerror'>, prio: number = PRIO.next) {
    const { voice, speed } = this.params(o);
    for (const piece of this.pieces(text, o.role)) this.request(piece, voice, speed, prio)?.p.catch(() => this.cache.delete(this.key(piece, voice, speed)));
  }

  /** warm the cache with fixed phrases (umpire calls ...): background priority */
  warm(texts: string[], role: SpeakRole) {
    for (const t of texts) this.prefetch(t, { role, rate: 1, pitch: 1, volume: 1 }, PRIO.warm);
  }

  speak(text: string, o: SpeakOptions): SpeakHandle {
    const ctx = this.mixer?.ctx;
    const { voice, speed, shift } = this.params(o);
    const parts = this.pieces(text, o.role);
    let alive = true;
    let stopAfter = false;
    let index = 0;
    let cur: { src: AudioBufferSourceNode; nodes: AudioNode[]; shift: number } | null = null;
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      this.lines.delete(handle);
      if (alive) (ok ? o.onend : o.onerror)();
      alive = false;
    };
    const handle = {
      stop: () => {
        alive = false;
        finished = true;
        this.lines.delete(handle);
        if (cur) this.stopSource(cur);
        cur = null;
      },
      cancel: () => handle.stop(),
      cutAtClause: () => {
        stopAfter = true;
        if (!cur) finish(true);
      },
    };
    this.lines.add(handle);
    if (!ctx) {
      queueMicrotask(() => {
        this.fallbackLine(text, o);
        finish(true);
      });
      return handle;
    }
    // on a CPU slower than real time a short call would arrive seconds late: the browser voice is immediate
    if (o.role === 'ump' && this.rtf > 1) {
      queueMicrotask(() => {
        this.fallbackLine(text, o);
        finish(true);
      });
      return handle;
    }
    // request every clause now (first one at the highest priority), then play them as they become ready
    const gens = parts.map((piece, i) => this.request(piece, voice, speed, i === 0 ? PRIO.now : PRIO.now));
    const playNext = () => {
      if (!alive) return;
      if (index >= parts.length) return finish(true);
      const g = gens[index];
      if (!g) {
        this.fallbackLine(parts.slice(index).join(' '), o);
        return finish(true);
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled || !alive) return;
        settled = true;
        if (index === 0) {
          this.fallbackLine(text, o);
          finish(true);
        } else finish(true);
      }, WAIT_MS);
      g.p.then(
        (buf) => {
          clearTimeout(timer);
          if (settled || !alive) return;
          settled = true;
          cur = this.play(buf, o, shift, () => {
            cur = null;
            index++;
            this.stats.clauses++;
            if (stopAfter) return finish(true);
            playNext();
          });
          if (!cur) finish(false);
        },
        () => {
          clearTimeout(timer);
          this.stats.failures++;
          if (settled || !alive) return;
          settled = true;
          if (index === 0) {
            this.fallbackLine(text, o);
          }
          finish(true);
        },
      );
    };
    playNext();
    this.stats.played++;
    return handle;
  }

  private fallbackLine(text: string, o: SpeakOptions) {
    this.stats.fallbacks++;
    // the browser voice reports its own end; the neural line's callbacks must not fire twice, so give it no-op callbacks
    this.fallback?.speak(text, { ...o, onend: () => {}, onerror: () => {} });
  }

  private stopSource(c: { src: AudioBufferSourceNode; nodes: AudioNode[]; shift: number }) {
    try {
      c.src.onended = null;
      c.src.stop();
      c.src.disconnect();
      for (const n of c.nodes) n.disconnect();
    } catch {
      /* ignore */
    }
    this.playing.delete(c);
  }

  private play(buf: AudioBuffer, o: SpeakOptions, shift: number, onDone: () => void): { src: AudioBufferSourceNode; nodes: AudioNode[]; shift: number } | null {
    const ctx = this.mixer?.ctx;
    const mixer = this.mixer;
    if (!ctx || !mixer || ctx.state !== 'running') {
      return null;
    }
    const nodes: AudioNode[] = [];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this.paused ? 0 : shift;
    const level = ctx.createGain();
    level.gain.value = Math.max(0.05, Math.min(1.2, o.volume * 1.15));
    nodes.push(level);
    src.connect(level);
    const tail: AudioNode = level;
    if (o.role === 'pa') {
      // public-address voice: band-limited horn speaker, a touch of drive, a slap-back off the far stands and the stadium reverb
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 320;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3400;
      const drive = ctx.createWaveShaper();
      const curve = new Float32Array(512);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
      }
      drive.curve = curve;
      tail.connect(hp);
      hp.connect(lp);
      lp.connect(drive);
      const dry = ctx.createGain();
      dry.gain.value = 0.85;
      drive.connect(dry);
      dry.connect(mixer.paBus);
      const slap = ctx.createDelay(0.5);
      slap.delayTime.value = 0.19;
      const fb = ctx.createGain();
      fb.gain.value = 0.22;
      const wet = ctx.createGain();
      wet.gain.value = 0.32;
      drive.connect(slap);
      slap.connect(fb);
      fb.connect(slap);
      slap.connect(wet);
      wet.connect(mixer.paBus);
      const send = ctx.createGain();
      send.gain.value = 0.7;
      drive.connect(send);
      send.connect(mixer.reverbIn);
      nodes.push(hp, lp, drive, dry, slap, fb, wet, send);
    } else if (o.role === 'ump') {
      // the umpire is on the field: part of the stadium, in the room reverb, a little band-limited, no slap-back
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 150;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6500;
      tail.connect(hp);
      hp.connect(lp);
      lp.connect(mixer.paBus);
      const send = ctx.createGain();
      send.gain.value = 0.45;
      lp.connect(send);
      send.connect(mixer.reverbIn);
      nodes.push(hp, lp, send);
    } else {
      // booth voices stay dry and close-miked: roll off the rumble, add a little presence
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 90;
      const pres = ctx.createBiquadFilter();
      pres.type = 'peaking';
      pres.frequency.value = 3000;
      pres.gain.value = 2;
      tail.connect(hp);
      hp.connect(pres);
      pres.connect(mixer.boothBus);
      nodes.push(hp, pres);
    }
    const c = { src, nodes, shift };
    this.playing.add(c);
    src.onended = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      this.playing.delete(c);
      onDone();
    };
    src.start();
    return c;
  }

  /** cancel every line (the SwitchEngine's global cancel; the channels use per-line handles) */
  cancel() {
    for (const l of [...this.lines]) l.stop();
    for (const c of [...this.playing]) this.stopSource(c);
    this.fallback?.cancel();
  }

  pause() {
    this.paused = true;
    for (const c of this.playing) c.src.playbackRate.value = 0;
    this.fallback?.pause();
  }

  resume() {
    this.paused = false;
    for (const c of this.playing) c.src.playbackRate.value = c.shift;
    this.fallback?.resume();
  }

  dispose() {
    this.cancel();
    this.synth.dispose();
    this.ready = false;
    this.cache.clear();
    this.jobs = [];
  }
}

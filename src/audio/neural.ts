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
import type { SpeakOptions, SpeechEngine } from './speech';
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

const MAX_CACHE = 12;
const WAIT_MS = 20000;

export class NeuralSpeechEngine implements SpeechEngine {
  ready = false;
  /** measured generation time / audio time, smoothed (starts from the mode's expectation) */
  rtf: number;
  /** lines that fell back to the browser voice, and failures (debug) */
  readonly stats = { generated: 0, played: 0, fallbacks: 0, failures: 0, lastRtf: 0 };
  private cache = new Map<string, Gen>();
  private token = 0;
  private cur: { src: AudioBufferSourceNode; nodes: AudioNode[] } | null = null;
  private paused = false;
  private outstanding = 0;

  constructor(private synth: Synth, private mixer: Mixer, private fallback: SpeechEngine | null, mode: HdMode = 'cpu') {
    this.rtf = mode === 'gpu' ? 0.25 : 3;
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
    for (const g of this.cache.values()) if (!g.done) secs += g.est;
    return secs * this.rtf * 1000;
  }

  private key(text: string, voice: string, speed: number) {
    return `${voice}|${speed.toFixed(2)}|${text}`;
  }

  private request(text: string, o: { voiceName?: string; role?: SpeakRole; rate: number }): Gen | null {
    const ctx = this.mixer.ctx;
    if (!ctx) return null;
    const voice = o.voiceName ?? HD_VOICES[o.role ?? 'pbp'];
    const speed = Math.min(1.25, Math.max(0.8, o.rate));
    const k = this.key(text, voice, speed);
    const hit = this.cache.get(k);
    if (hit) return hit;
    const est = Math.max(1, text.length / 14);
    const t0 = performance.now();
    this.outstanding++;
    const gen: Gen = {
      est,
      done: false,
      p: this.synth.generate(text, voice, speed).then((r) => {
        const b = ctx.createBuffer(1, r.samples.length, r.sr);
        b.copyToChannel(r.samples as Float32Array<ArrayBuffer>, 0);
        const secs = r.samples.length / r.sr;
        const ratio = (performance.now() - t0) / 1000 / Math.max(0.3, secs);
        this.stats.lastRtf = ratio;
        // queued jobs wait for earlier ones, so only believe a ratio measured with nothing ahead of it
        if (this.outstanding <= 1) this.rtf += (ratio - this.rtf) * 0.4;
        this.stats.generated++;
        return b;
      }),
    };
    const fin = () => {
      gen.done = true;
      this.outstanding = Math.max(0, this.outstanding - 1);
    };
    gen.p.then(fin, fin);
    this.cache.set(k, gen);
    while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    return gen;
  }

  prefetch(text: string, o: Omit<SpeakOptions, 'onend' | 'onerror'>) {
    this.request(text, o)?.p.catch(() => this.cache.delete(this.key(text, o.voiceName ?? HD_VOICES[o.role ?? 'pbp'], Math.min(1.25, Math.max(0.8, o.rate)))));
  }

  speak(text: string, o: SpeakOptions) {
    const token = ++this.token;
    // on a CPU slower than real time a short call would arrive seconds late: the browser voice is immediate
    if (o.role === 'ump' && this.rtf > 1) return this.fall(text, o);
    const gen = this.request(text, o);
    if (!gen) return this.fall(text, o);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled || token !== this.token) return;
      settled = true;
      this.fall(text, o);
    }, WAIT_MS);
    gen.p.then(
      (buf) => {
        clearTimeout(timer);
        if (settled || token !== this.token) return;
        settled = true;
        this.play(buf, o, token);
      },
      () => {
        clearTimeout(timer);
        this.stats.failures++;
        if (settled || token !== this.token) return;
        settled = true;
        this.fall(text, o);
      },
    );
  }

  private fall(text: string, o: SpeakOptions) {
    this.stats.fallbacks++;
    if (this.fallback) this.fallback.speak(text, o);
    else o.onerror();
  }

  private play(buf: AudioBuffer, o: SpeakOptions, token: number) {
    const ctx = this.mixer.ctx;
    if (!ctx || ctx.state !== 'running') return o.onerror();
    const nodes: AudioNode[] = [];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const level = ctx.createGain();
    level.gain.value = Math.max(0.05, Math.min(1.2, o.volume * 1.15));
    nodes.push(level);
    src.connect(level);
    let tail: AudioNode = level;
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
      dry.connect(this.mixer.voiceBus);
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
      wet.connect(this.mixer.voiceBus);
      const send = ctx.createGain();
      send.gain.value = 0.7;
      drive.connect(send);
      send.connect(this.mixer.reverbIn);
      nodes.push(hp, lp, drive, dry, slap, fb, wet, send);
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
      pres.connect(this.mixer.voiceBus);
      nodes.push(hp, pres);
    }
    void tail;
    this.cur = { src, nodes };
    this.stats.played++;
    src.onended = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      if (this.cur?.src === src) this.cur = null;
      if (token === this.token) o.onend();
    };
    if (this.paused) src.playbackRate.value = 0;
    src.start();
  }

  cancel() {
    this.token++;
    const c = this.cur;
    this.cur = null;
    if (c) {
      try {
        c.src.onended = null;
        c.src.stop();
        c.src.disconnect();
        for (const n of c.nodes) n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.fallback?.cancel();
  }

  pause() {
    this.paused = true;
    if (this.cur) this.cur.src.playbackRate.value = 0;
    this.fallback?.pause();
  }

  resume() {
    this.paused = false;
    if (this.cur) this.cur.src.playbackRate.value = 1;
    this.fallback?.resume();
  }

  dispose() {
    this.cancel();
    this.synth.dispose();
    this.ready = false;
    this.cache.clear();
  }
}

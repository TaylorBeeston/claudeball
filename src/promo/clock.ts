/**
 * A virtual clock for frame-by-frame capture (`?promo`): once `virtualize()` is called, `performance.now`, `Date.now`, `setTimeout`,
 * `setInterval` and `requestAnimationFrame` only move when the capture calls `advance(ms)`, so the game, its timers, the audio controller's
 * tick and the booth all run in the picture's time however long a frame takes to render and save. Timers made before the switch keep
 * running on the real clock; `Math.random` is replaced by a seeded generator (`seedRandom`) so a re-shoot is the same take.
 *
 * Only the promo runtime installs this; nothing in the shipped game imports it.
 */
type Fn = (...a: unknown[]) => void;

interface VTimer {
  id: number;
  due: number;
  fn: Fn;
  args: unknown[];
  every: number | null;
  seq: number;
}

const real = {
  perfNow: performance.now.bind(performance),
  dateNow: Date.now.bind(Date),
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  setInterval: window.setInterval.bind(window),
  clearInterval: window.clearInterval.bind(window),
  raf: window.requestAnimationFrame.bind(window),
  caf: window.cancelAnimationFrame.bind(window),
  random: Math.random,
};
export const realTimers = real;

/** ids of virtual timers start high so they never collide with the real ones */
const ID0 = 1_000_000_000;

export class VirtualClock {
  virtual = false;
  /** virtual performance.now(), ms */
  now = 0;
  private dateOffset = 0;
  private timers = new Map<number, VTimer>();
  private rafs = new Map<number, FrameRequestCallback>();
  private nextId = ID0;
  private seq = 0;

  install() {
    const self = this;
    performance.now = () => (self.virtual ? self.now : real.perfNow());
    Date.now = () => (self.virtual ? self.now + self.dateOffset : real.dateNow());
    (window as unknown as { setTimeout: unknown }).setTimeout = (fn: Fn | string, ms?: number, ...args: unknown[]) =>
      self.virtual && typeof fn === 'function' ? self.add(fn, ms ?? 0, args, null) : real.setTimeout(fn as TimerHandler, ms, ...args);
    (window as unknown as { setInterval: unknown }).setInterval = (fn: Fn | string, ms?: number, ...args: unknown[]) =>
      self.virtual && typeof fn === 'function' ? self.add(fn, ms ?? 0, args, Math.max(1, ms ?? 0)) : real.setInterval(fn as TimerHandler, ms, ...args);
    const clear = (id?: number) => {
      if (id === undefined) return;
      if (id >= ID0) self.timers.delete(id);
      else {
        real.clearTimeout(id);
        real.clearInterval(id);
      }
    };
    (window as unknown as { clearTimeout: unknown }).clearTimeout = clear;
    (window as unknown as { clearInterval: unknown }).clearInterval = clear;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      if (!self.virtual) return real.raf(cb);
      const id = self.nextId++;
      self.rafs.set(id, cb);
      return id;
    };
    window.cancelAnimationFrame = (id: number) => {
      if (id >= ID0) self.rafs.delete(id);
      else real.caf(id);
    };
  }

  /** from now on time only moves with `advance` (continuing from the real clock, so nothing sees time go backwards) */
  virtualize() {
    if (this.virtual) return;
    this.now = real.perfNow();
    this.dateOffset = real.dateNow() - this.now;
    this.virtual = true;
  }

  private add(fn: Fn, ms: number, args: unknown[], every: number | null) {
    const id = this.nextId++;
    this.timers.set(id, { id, due: this.now + Math.max(0, ms), fn, args, every, seq: this.seq++ });
    return id;
  }

  /** move time on by `ms`: every timer that falls due runs at its own time, in order; then the animation-frame callbacks run once */
  advance(ms: number) {
    const end = this.now + ms;
    for (let guard = 0; guard < 100000; guard++) {
      let next: VTimer | null = null;
      for (const t of this.timers.values()) if (t.due <= end && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t;
      if (!next) break;
      this.now = Math.max(this.now, next.due);
      if (next.every !== null) {
        next.due += next.every;
        next.seq = this.seq++;
      } else this.timers.delete(next.id);
      try {
        next.fn(...next.args);
      } catch (e) {
        console.error('[promo clock] timer threw', e);
      }
    }
    this.now = end;
    const cbs = [...this.rafs.values()];
    this.rafs.clear();
    for (const cb of cbs) {
      try {
        cb(this.now);
      } catch (e) {
        console.error('[promo clock] rAF threw', e);
      }
    }
  }

  get pending() {
    return this.timers.size;
  }
}

/** sfc32-like small fast generator: Math.random for one take */
export function seedRandom(seed: number) {
  let a = seed >>> 0 || 1, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  Math.random = next;
}

/**
 * The speech gate: gives the stadium side (PA announcer, umpire: the "field" channel) and the broadcast booth their own view of one
 * speech engine, so they run independently:
 *  - engines that can play several lines at once (Web Audio: the HD voices) just pass every line through, the PA and the booth overlap;
 *  - engines that cannot (the browser's speech synthesis has one global queue, the custom voice plays one line) get a mutex: one line at
 *    a time, the field channel first, a line that waited too long is dropped. That sequential fallback is the only way browser voices can work.
 * Each view cancels only its own lines, and the gate counts how many lines each side has running (for the PA/booth ducking).
 */
import type { SpeakHandle, SpeakOptions, SpeechEngine } from '../speech';

export type View = 'field' | 'booth';

interface Req {
  view: View;
  text: string;
  o: SpeakOptions;
  queuedAt: number;
  handle?: SpeakHandle | void;
  done: boolean;
}

export class SpeechGate {
  /** lines currently running per side */
  readonly busy: Record<View, number> = { field: 0, booth: 0 };
  private active: Req | null = null;
  private waiting: Req[] = [];
  private running = new Set<Req>();
  readonly stats = { dropped: 0, queued: 0 };

  constructor(private base: SpeechEngine, private now: () => number = () => performance.now()) {}

  get concurrent() {
    return !!this.base.concurrent;
  }

  view(name: View): SpeechEngine {
    const g = this;
    return {
      voices: () => g.base.voices(),
      voiceFor: (r) => g.base.voiceFor?.(r),
      busyMs: () => g.base.busyMs?.() ?? 0,
      prefetch: (t, o) => g.base.prefetch?.(t, o),
      get concurrent() {
        return g.concurrent;
      },
      speak: (text, o) => g.speak(name, text, o),
      cancel: () => g.cancelView(name),
      pause: () => g.base.pause(),
      resume: () => g.base.resume(),
    };
  }

  private speak(view: View, text: string, o: SpeakOptions): SpeakHandle {
    const req: Req = { view, text, o, queuedAt: this.now(), done: false };
    const wrap = (cb: () => void) => () => {
      if (req.done) return;
      req.done = true;
      this.running.delete(req);
      this.busy[view] = Math.max(0, this.busy[view] - 1);
      if (this.active === req) this.active = null;
      cb();
      this.next();
    };
    const o2: SpeakOptions = { ...o, onend: wrap(o.onend), onerror: wrap(o.onerror) };
    req.o = o2;
    this.busy[view]++;
    this.running.add(req);
    if (this.base.concurrent) {
      req.handle = this.base.speak(text, o2);
    } else if (!this.active) this.start(req);
    else {
      this.stats.queued++;
      this.waiting.push(req);
    }
    return {
      cancel: () => this.cancelReq(req),
      cutAtClause: () => (req.handle && typeof req.handle === 'object' && req.handle.cutAtClause ? req.handle.cutAtClause() : this.cancelReq(req)),
    };
  }

  private start(req: Req) {
    this.active = req;
    req.handle = this.base.speak(req.text, req.o);
  }

  /** the next waiting line: field first, stale ones dropped */
  private next() {
    if (this.active) return;
    const t = this.now();
    while (this.waiting.length && !this.active) {
      let i = this.waiting.findIndex((r) => r.view === 'field');
      if (i < 0) i = 0;
      const r = this.waiting.splice(i, 1)[0];
      if (r.done) continue;
      if (r.o.maxWaitMs !== undefined && t - r.queuedAt > r.o.maxWaitMs) {
        this.stats.dropped++;
        r.o.onerror(); // the wrapper frees the line and moves on
        continue;
      }
      this.start(r);
      return;
    }
  }

  private cancelReq(req: Req) {
    if (req.done) return;
    req.done = true;
    this.running.delete(req);
    this.busy[req.view] = Math.max(0, this.busy[req.view] - 1);
    const wi = this.waiting.indexOf(req);
    if (wi >= 0) this.waiting.splice(wi, 1);
    if (this.active === req || this.base.concurrent) {
      const h = req.handle;
      if (h && typeof h === 'object') h.cancel();
      else if (this.active === req) this.base.cancel();
      if (this.active === req) this.active = null;
    }
    this.next();
  }

  private cancelView(view: View) {
    for (const r of [...this.running]) if (r.view === view) this.cancelReq(r);
  }
}

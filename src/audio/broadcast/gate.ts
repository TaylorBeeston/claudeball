/**
 * The speech gate: gives the stadium side (PA announcer, umpire: the "field" channel) and the broadcast booth their own view of one
 * speech engine, so they run independently:
 *  - engines that can play several lines at once (Web Audio: the HD voices) just pass every line through, the PA and the booth overlap;
 *  - engines that cannot (the browser's speech synthesis has one global queue, the custom voice plays one line) get a mutex: one line at
 *    a time, the field channel first, a line that waited too long is dropped. That sequential fallback is the only way browser voices can work.
 * Each view cancels only its own lines, and the gate counts how many lines each side has running (for the PA/booth ducking).
 */
import { speakerLabel, speakerName } from './cast';
import type { SpeakHandle, SpeakOptions, SpeechEngine } from '../speech';
import { estimateSpokenChars, type SpeechChannel, type SpeechEvent, type SpeechSpeaker } from '../captions';
import { clauseEnds, estimateDuration } from './text';

export type View = 'field' | 'booth';

interface Req {
  view: View;
  text: string;
  o: SpeakOptions;
  queuedAt: number;
  handle?: SpeakHandle | void;
  done: boolean;
  /** captions */
  id: number;
  started: boolean;
  t0: number;
  expectedMs: number;
  cutRequested: boolean;
  truncatedAt?: number;
}

export class SpeechGate {
  /** lines currently running per side */
  readonly busy: Record<View, number> = { field: 0, booth: 0 };
  private active: Req | null = null;
  private waiting: Req[] = [];
  private running = new Set<Req>();
  readonly stats = { dropped: 0, queued: 0 };
  private seq = 0;
  private listeners = new Set<(e: SpeechEvent) => void>();
  private started = new Map<number, { req: Req; text: string }>();

  constructor(private base: SpeechEngine, private now: () => number = () => performance.now(), private clock: () => number = () => performance.now()) {}

  /** captions: every line that really starts to sound, and how it ended (see captions.ts) */
  onSpeech(cb: (e: SpeechEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(e: SpeechEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a caption listener must never break the speech */
      }
    }
  }
  /** lines sounding right now (for a caption UI that subscribes late) */
  speakingNow(): { id: number; channel: SpeechChannel; speaker: SpeechSpeaker; text: string; startMs: number }[] {
    return [...this.started.values()].map(({ req }) => ({ id: req.id, channel: channelOf(req), speaker: speakerOf(req), text: req.text, startMs: req.t0 }));
  }

  private begin(req: Req, info?: { expectedMs?: number }) {
    if (req.started || req.done) return;
    req.started = true;
    req.t0 = this.clock();
    if (info?.expectedMs) req.expectedMs = info.expectedMs;
    this.started.set(req.id, { req, text: req.text });
    const speaker = speakerOf(req);
    this.emit({ type: 'speechStart', id: req.id, channel: channelOf(req), speaker, text: req.text, startMs: req.t0, expectedDurationMs: Math.round(req.expectedMs), excited: (req.o.shift ?? 1) > 1.01, label: speakerLabel(speaker), name: speakerName(speaker) });
  }

  private finishCaption(req: Req, reason: 'finished' | 'cut' | 'cancelled' | 'error') {
    if (!req.started || !this.started.delete(req.id)) return;
    let truncatedAt = req.truncatedAt;
    if (truncatedAt === undefined && (reason === 'cancelled' || reason === 'cut')) truncatedAt = this.spoken(req, reason === 'cut');
    if (truncatedAt !== undefined && truncatedAt >= req.text.length) truncatedAt = undefined;
    this.emit({ type: 'speechEnd', id: req.id, endMs: this.clock(), reason, ...(truncatedAt !== undefined ? { truncatedAt } : {}) });
  }

  /** characters spoken so far: exact when the engine says, else from the elapsed time */
  private spoken(req: Req, clauseMode: boolean): number {
    const h = req.handle;
    if (h && typeof h === 'object' && h.spokenChars) return h.spokenChars();
    const el = this.clock() - req.t0;
    return estimateSpokenChars(req.text, el, req.expectedMs, clauseMode ? clauseEnds(req.text, req.o.rate).map((x) => x * 1000) : undefined);
  }

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
    const req: Req = { view, text, o, queuedAt: this.now(), done: false, id: ++this.seq, started: false, t0: 0, expectedMs: estimateDuration(text, o.rate || 1) * 1000, cutRequested: false };
    const wrap = (cb: () => void, ok: boolean) => () => {
      if (req.done) return;
      if (ok && !req.started) this.begin(req); // an engine that never said it started: the line was heard
      if (req.started && req.cutRequested && req.truncatedAt === undefined) req.truncatedAt = this.spoken(req, true);
      this.finishCaption(req, ok ? (req.cutRequested ? 'cut' : 'finished') : 'error');
      req.done = true;
      this.running.delete(req);
      this.busy[view] = Math.max(0, this.busy[view] - 1);
      if (this.active === req) this.active = null;
      cb();
      this.next();
    };
    const o2: SpeakOptions = { ...o, onstart: (info) => { this.begin(req, info); o.onstart?.(info); }, onend: wrap(o.onend, true), onerror: wrap(o.onerror, false) };
    req.o = o2;
    this.busy[view]++;
    this.running.add(req);
    if (this.base.concurrent) {
      req.handle = this.base.speak(text, o2);
      if (!this.base.emitsStart) this.begin(req);
    } else if (!this.active) this.start(req);
    else {
      this.stats.queued++;
      this.waiting.push(req);
    }
    return {
      cancel: () => this.cancelReq(req),
      cutAtClause: () => {
        req.cutRequested = true;
        if (req.handle && typeof req.handle === 'object' && req.handle.cutAtClause) {
          // the engine finishes the current clause: where it will stop is known now (the end of the clause being spoken)
          if (req.started && req.truncatedAt === undefined && !(req.handle.spokenChars)) req.truncatedAt = this.spoken(req, true);
          req.handle.cutAtClause();
        } else this.cancelReq(req);
      },
    };
  }

  private start(req: Req) {
    this.active = req;
    req.handle = this.base.speak(req.text, req.o);
    if (!this.base.emitsStart) this.begin(req);
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
    this.finishCaption(req, req.cutRequested ? 'cut' : 'cancelled');
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

const channelOf = (r: Req): SpeechChannel => (r.o.role === 'pa' ? 'pa' : r.o.role === 'ump' ? 'umpire' : r.view === 'field' ? 'pa' : 'booth');
const speakerOf = (r: Req): SpeechSpeaker => r.o.role ?? (r.view === 'field' ? 'pa' : 'pbp');

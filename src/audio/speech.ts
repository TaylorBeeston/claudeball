/**
 * Speech: PA announcer, umpire calls and two-voice commentary through the browser's SpeechSynthesis.
 *
 * Constraints this file is built around:
 *  - The browser has ONE speech queue and its output cannot be routed through Web Audio (no convolver on the voice).
 *    So the PA "feel" comes from a low, slightly slow voice plus the chime/click bracket played by the mixer.
 *  - Lines can only be spoken one at a time; this queue orders them by priority, drops stale ones (each has a time-to-live)
 *    and lets a much more important line cancel one that is being spoken.
 *  - Voices load asynchronously and headless browsers may have none: everything is a silent no-op then.
 */
import type { SpeakRole } from './types';

export interface Line {
  role: SpeakRole;
  text: string;
  pri: number;
  /** seconds a line may wait before it is too stale to say */
  ttl: number;
  /** lines of one exchange: if one is dropped, interrupted or goes stale, the rest of its group is dropped too */
  group?: number;
}

/** The slice of SpeechSynthesis / SpeechSynthesisUtterance the queue uses (so tests can fake it). */
export interface SpeakOptions {
  voiceName?: string;
  role?: SpeakRole;
  pitch: number;
  rate: number;
  volume: number;
  /** neural engines: raise (>1) or lower (<1) the pitch by resampling while keeping the tempo of `rate` (excited calls) */
  shift?: number;
  /** drop the line if it has not started within this many ms (a queued call that went stale) */
  maxWaitMs?: number;
  /** the line really started to sound (engines that report it set `emitsStart`); `expectedMs` when the engine knows the length */
  onstart?: (info?: { expectedMs?: number }) => void;
  onend: () => void;
  onerror: () => void;
}

/** returned by engines that can run several lines at once: cancel just this line, or let it finish its current clause and stop */
export interface SpeakHandle {
  cancel(): void;
  cutAtClause?(): void;
  /** characters of the line's text that have been spoken so far (captions for a line that was cut) */
  spokenChars?(): number;
}

export interface SpeechEngine {
  voices(): { name: string; lang: string; default?: boolean }[];
  speak(text: string, o: SpeakOptions): void | SpeakHandle;
  /** true when several lines can be spoken at the same time (Web Audio engines); browser speech is one line at a time */
  concurrent?: boolean;
  /** true when `SpeakOptions.onstart` is called when the line really starts (else the caller assumes it starts at once) */
  emitsStart?: boolean;
  cancel(): void;
  pause(): void;
  resume(): void;
  /** optional (neural voices): start synthesising a line that will be spoken soon */
  prefetch?(text: string, o: Omit<SpeakOptions, 'onend' | 'onerror'>): void;
  /** optional: the voice to use for a role, overriding the name heuristics */
  voiceFor?(role: SpeakRole): string | undefined;
  /** optional: estimated ms before a newly requested line would be ready; large = the engine is falling behind */
  busyMs?(): number;
}

/**
 * One engine for the queue that can switch between the browser's voices and the optional neural ("HD") voices at run time.
 * If the neural engine is not ready (still loading, failed) everything goes to the browser.
 */
export class SwitchEngine implements SpeechEngine {
  neural: SpeechEngine | null = null;
  constructor(private browser: SpeechEngine | null) {}
  private get cur(): SpeechEngine | null {
    return this.neural && this.neural.voices().length ? this.neural : this.browser;
  }
  get usingNeural() {
    return !!this.neural && this.neural.voices().length > 0;
  }
  voices() {
    return this.cur?.voices() ?? [];
  }
  get concurrent() {
    return this.usingNeural && !!this.neural!.concurrent;
  }
  get emitsStart() {
    return !!this.cur?.emitsStart;
  }
  speak(text: string, o: SpeakOptions) {
    return this.cur?.speak(text, o);
  }
  cancel() {
    this.neural?.cancel();
    this.browser?.cancel();
  }
  pause() {
    this.neural?.pause();
    this.browser?.pause();
  }
  resume() {
    this.neural?.resume();
    this.browser?.resume();
  }
  prefetch(text: string, o: Omit<SpeakOptions, 'onend' | 'onerror'>) {
    if (this.usingNeural) this.neural!.prefetch?.(text, o);
  }
  voiceFor(role: SpeakRole) {
    return this.usingNeural ? this.neural!.voiceFor?.(role) : undefined;
  }
  busyMs() {
    return this.usingNeural ? (this.neural!.busyMs?.() ?? 0) : 0;
  }
}

export function browserSpeech(): SpeechEngine | null {
  try {
    const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return null;
    return {
      voices: () => synth.getVoices(),
      speak(text, o) {
        const u = new SpeechSynthesisUtterance(text);
        const v = o.voiceName ? synth.getVoices().find((x) => x.name === o.voiceName) : undefined;
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        } else u.lang = 'en-US';
        u.pitch = o.pitch;
        u.rate = o.rate;
        u.volume = o.volume;
        u.onstart = () => o.onstart?.();
        u.onend = o.onend;
        u.onerror = o.onerror;
        synth.speak(u);
      },
      emitsStart: true,
      cancel: () => synth.cancel(),
      pause: () => synth.pause(),
      resume: () => synth.resume(),
    };
  } catch {
    return null;
  }
}

const FEMALE = /female|samantha|zira|aria|jenny|karen|moira|tessa|fiona|victoria|susan|hazel|libby|sonia|allison|ava|serena|kate|emma|joanna|salli|kendra|kimberly/i;
const MALE = /\bmale\b|david|daniel|alex|guy|mark|fred|george|ryan|james|tom|ralph|arthur|oliver|matthew|brian|davis|thomas|rocko|reed/i;

export interface VoiceChoice {
  pa?: string;
  ump?: string;
  pbp?: string;
  color?: string;
}

/** Pick English voices: male-ish voices for the PA, umpire and play-by-play, a different one for the analyst (a male-ish one when there is a third, as the cast is; a female-ish one only as the fallback that keeps the two booth voices apart). */
export function pickVoices(list: { name: string; lang: string }[]): VoiceChoice {
  const en = list.filter((v) => /^en([-_]|$)/i.test(v.lang));
  const pool = en.length ? en : list;
  if (!pool.length) return {};
  const female = pool.filter((v) => FEMALE.test(v.name) && !MALE.test(v.name));
  const male = pool.filter((v) => MALE.test(v.name) && !FEMALE.test(v.name));
  const neutral = pool.filter((v) => !female.includes(v) && !male.includes(v));
  const guys = [...male, ...neutral];
  const pa = (guys[0] ?? pool[0]).name;
  const pbp = (guys[1] ?? guys[0] ?? pool[0]).name;
  const color = (guys[2] ?? female[0] ?? pool[Math.min(1, pool.length - 1)]).name;
  return { pa, ump: pa, pbp, color };
}

const PARAMS: Record<SpeakRole, { pitch: number; rate: number; vol: number }> = {
  pa: { pitch: 0.75, rate: 0.92, vol: 1 },
  ump: { pitch: 0.55, rate: 1.12, vol: 1 },
  pbp: { pitch: 0.95, rate: 1.08, vol: 0.9 },
  color: { pitch: 1.05, rate: 1.03, vol: 0.9 },
};

interface Item extends Line {
  at: number;
  expires: number;
  seq: number;
}

export interface QueueStats {
  spoken: number;
  dropped: number;
  interrupted: number;
}

export class SpeechQueue {
  readonly stats: QueueStats = { spoken: 0, dropped: 0, interrupted: 0 };
  /** every line handed to `speak`, newest last (debug / tests) */
  readonly log: { role: SpeakRole; text: string }[] = [];
  private q: Item[] = [];
  private cur: { item: Item; started: number; token: number } | null = null;
  private token = 0;
  private seq = 0;
  private paused = false;
  /** do not start new lines (the booth is waiting out the seventh-inning stretch) */
  hold = false;
  private voiceChoice: VoiceChoice | null = null;
  private lastEnd = -1e9;
  private lastActivity = 0;
  enabled: Record<SpeakRole, boolean> = { pa: true, ump: true, pbp: true, color: true };
  /** 0..1 */
  volume = 0.8;
  /** extra volume factor for the PA and the umpire on engines that cannot route them to their own bus (browser voices) */
  paScale: () => number = () => 1;

  constructor(
    private engine: SpeechEngine | null,
    private now: () => number = () => performance.now(),
  ) {
    this.lastActivity = now();
  }

  /** true if there is at least one voice to speak with */
  available(): boolean {
    if (!this.engine) return false;
    try {
      return this.engine.voices().length > 0;
    } catch {
      return false;
    }
  }

  /** the line that is being spoken right now, if any */
  get speaking(): Line | null {
    return this.cur?.item ?? null;
  }

  get pending(): number {
    return this.q.length;
  }

  enqueue(line: Line) {
    if (!this.enabled[line.role]) return;
    const t = this.now();
    // the neural voices are falling behind: drop chatter instead of letting it go stale
    if (line.pri <= 2 && (this.engine?.busyMs?.() ?? 0) > 7000) {
      this.stats.dropped++;
      return;
    }
    if (this.q.some((x) => x.text === line.text && t - x.at < 3000) || (this.cur?.item.text === line.text && t - this.cur.started < 3000)) return;
    this.q.push({ ...line, at: t, expires: t + line.ttl * 1000, seq: this.seq++ });
    while (this.q.length > 6) {
      // drop the least important, oldest line
      let worst = 0;
      for (let i = 1; i < this.q.length; i++) if (this.q[i].pri < this.q[worst].pri || (this.q[i].pri === this.q[worst].pri && this.q[i].at < this.q[worst].at)) worst = i;
      this.q.splice(worst, 1);
      this.stats.dropped++;
    }
    this.pump();
    this.prefetchNext();
  }

  /** ask the engine to start synthesising the line that will be spoken next */
  private prefetchNext() {
    if (!this.engine?.prefetch || !this.q.length) return;
    let best = 0;
    for (let i = 1; i < this.q.length; i++) if (this.q[i].pri > this.q[best].pri || (this.q[i].pri === this.q[best].pri && this.q[i].at < this.q[best].at)) best = i;
    const it = this.q[best];
    const p = PARAMS[it.role];
    try {
      this.engine.prefetch(it.text, { voiceName: this.engine.voiceFor?.(it.role) ?? this.voiceChoice?.[it.role], role: it.role, pitch: p.pitch, rate: p.rate, volume: Math.min(1, p.vol * this.volume) });
    } catch {
      /* prefetch is an optimisation */
    }
  }

  setPaused(p: boolean) {
    if (p === this.paused) return;
    this.paused = p;
    try {
      if (p) this.engine?.pause();
      else this.engine?.resume();
    } catch {
      /* ignore */
    }
    if (!p) this.pump();
  }

  private dropGroup(g: number | undefined) {
    if (g === undefined) return;
    const n = this.q.length;
    this.q = this.q.filter((x) => x.group !== g);
    this.stats.dropped += n - this.q.length;
  }

  /** milliseconds the booth has been silent (0 while speaking or lines are waiting) */
  idleMs(): number {
    return this.cur || this.q.length ? 0 : this.now() - this.lastActivity;
  }

  /** stop talking and forget everything (mute, skipping ahead, sped-up play) */
  clear() {
    if (this.q.length) this.stats.dropped += this.q.length;
    this.q = [];
    if (this.cur) {
      this.token++;
      this.cur = null;
      try {
        this.engine?.cancel();
      } catch {
        /* ignore */
      }
    }
  }

  /** drop queued/spoken lines of the given roles (a toggle was switched off) */
  clearRoles(roles: SpeakRole[]) {
    this.q = this.q.filter((x) => !roles.includes(x.role));
    if (this.cur && roles.includes(this.cur.item.role)) {
      this.token++;
      this.cur = null;
      try {
        this.engine?.cancel();
      } catch {
        /* ignore */
      }
    }
  }

  /** Call regularly (each frame or so): expires stale lines, restarts after a stalled utterance, starts the next line. */
  pump() {
    const t = this.now();
    const before = this.q.length;
    const stale = new Set(this.q.filter((x) => x.expires <= t && x.group !== undefined).map((x) => x.group));
    this.q = this.q.filter((x) => x.expires > t && !(x.group !== undefined && stale.has(x.group)));
    this.stats.dropped += before - this.q.length;
    if (this.cur && t - this.cur.started > 14000) {
      // Chrome sometimes never fires onend: cancel and move on
      this.token++;
      this.cur = null;
      try {
        this.engine?.cancel();
      } catch {
        /* ignore */
      }
    }
    if (!this.q.length || this.paused || this.hold) return;
    let best = 0;
    for (let i = 1; i < this.q.length; i++) if (this.q[i].pri > this.q[best].pri || (this.q[i].pri === this.q[best].pri && this.q[i].at < this.q[best].at)) best = i;
    const next = this.q[best];
    if (this.cur) {
      // a much more important line may cut a chatty one off (never the umpire)
      if (next.pri >= this.cur.item.pri + 2 && this.cur.item.role !== 'ump' && this.cur.item.role !== 'pa') {
        this.token++;
        this.dropGroup(this.cur.item.group);
        this.cur = null;
        this.stats.interrupted++;
        try {
          this.engine?.cancel();
        } catch {
          /* ignore */
        }
        // give the engine a beat to flush before the next speak()
        this.lastEnd = t - 40;
      } else return;
    }
    if (t - this.lastEnd < 90) return; // brief breath between lines; the next pump() picks it up
    this.q.splice(best, 1);
    this.start(next);
  }

  private start(item: Item) {
    if (!this.engine || !this.available()) {
      this.stats.dropped++;
      return;
    }
    if (!this.voiceChoice || !this.voiceChoice.pa) this.voiceChoice = pickVoices(this.engine.voices());
    const p = PARAMS[item.role];
    const token = ++this.token;
    this.cur = { item, started: this.now(), token };
    this.log.push({ role: item.role, text: item.text });
    if (this.log.length > 100) this.log.shift();
    this.stats.spoken++;
    const done = () => {
      if (this.cur && this.cur.token === token) {
        this.cur = null;
        this.lastEnd = this.lastActivity = this.now();
      }
    };
    try {
      this.engine.speak(item.text, { voiceName: this.engine.voiceFor?.(item.role) ?? this.voiceChoice[item.role], role: item.role, pitch: p.pitch, rate: p.rate, volume: Math.min(1, p.vol * this.volume * (item.role === 'pa' || item.role === 'ump' ? this.paScale() : 1)), onend: done, onerror: done });
      this.prefetchNext();
    } catch {
      done();
    }
  }
}

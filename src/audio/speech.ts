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
}

/** The slice of SpeechSynthesis / SpeechSynthesisUtterance the queue uses (so tests can fake it). */
export interface SpeechEngine {
  voices(): { name: string; lang: string; default?: boolean }[];
  speak(text: string, o: { voiceName?: string; pitch: number; rate: number; volume: number; onend: () => void; onerror: () => void }): void;
  cancel(): void;
  pause(): void;
  resume(): void;
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
        u.onend = o.onend;
        u.onerror = o.onerror;
        synth.speak(u);
      },
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

/** Pick English voices: a male-ish voice for the PA, umpire and play-by-play, a different (female-ish if there is one) for colour. */
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
  const color = (female[0] ?? guys[2] ?? pool[Math.min(1, pool.length - 1)]).name;
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
  private voiceChoice: VoiceChoice | null = null;
  private lastEnd = -1e9;
  enabled: Record<SpeakRole, boolean> = { pa: true, ump: true, pbp: true, color: true };
  /** 0..1 */
  volume = 0.8;

  constructor(
    private engine: SpeechEngine | null,
    private now: () => number = () => performance.now(),
  ) {}

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
    this.q = this.q.filter((x) => x.expires > t);
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
    if (!this.q.length || this.paused) return;
    let best = 0;
    for (let i = 1; i < this.q.length; i++) if (this.q[i].pri > this.q[best].pri || (this.q[i].pri === this.q[best].pri && this.q[i].at < this.q[best].at)) best = i;
    const next = this.q[best];
    if (this.cur) {
      // a much more important line may cut a chatty one off (never the umpire)
      if (next.pri >= this.cur.item.pri + 2 && this.cur.item.role !== 'ump' && this.cur.item.role !== 'pa') {
        this.token++;
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
        this.lastEnd = this.now();
      }
    };
    try {
      this.engine.speak(item.text, { voiceName: this.voiceChoice[item.role], pitch: p.pitch, rate: p.rate, volume: Math.min(1, p.vol * this.volume), onend: done, onerror: done });
    } catch {
      done();
    }
  }
}

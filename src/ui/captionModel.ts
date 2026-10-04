/**
 * The logic behind the subtitles, with no DOM and no clock of its own, so it is unit-tested: which speech events are captioned,
 * how long a line stays, truncation when a line is cut off, how many lines show at once.
 *
 * Input is the audio layer's speech events: a start `{ id, channel, speaker, text, startMs, expectedDurationMs }` when a voice starts a
 * line and an end `{ id, truncatedAt? }` when it finishes or is cut. Captions come from these text events, not from the audio itself, so they work with
 * browser speech, HD (Kokoro) and custom voices alike. Time is whatever monotonic millisecond clock the caller passes (`performance.now()`).
 */
import type { SubtitleMode } from './settings';

export interface SpeechStartEvent {
  id: string | number;
  /** audio channel ('booth' | 'pa' ...) */
  channel?: string;
  /** who speaks ('play-by-play' | 'color' | 'pa' | 'umpire' ...) */
  speaker?: string;
  text: string;
  startMs?: number;
  expectedDurationMs?: number;
}

export interface SpeechEndEvent {
  id: string | number;
  /** characters of the text that were spoken before the line was cut off */
  truncatedAt?: number;
}

export type CaptionKind = 'pbp' | 'color' | 'pa' | 'umpire' | 'other';

export const CAPTION_LABELS: Record<CaptionKind, string> = { pbp: 'PLAY-BY-PLAY', color: 'COLOR', pa: 'PA', umpire: 'UMPIRE', other: '' };

/** Which kind of voice a speech event is, from its `speaker` (preferred) or `channel`. */
export function captionKind(e: { speaker?: string; channel?: string }): CaptionKind {
  const sp = (e.speaker ?? '').toLowerCase();
  if (/colou?r|analyst/.test(sp)) return 'color';
  if (/play|pbp/.test(sp)) return 'pbp';
  if (/ump/.test(sp)) return 'umpire';
  if (sp === 'pa' || /\bpa\b|announcer|stadium/.test(sp)) return 'pa';
  const ch = (e.channel ?? '').toLowerCase();
  if (ch === 'booth') return 'pbp';
  if (ch === 'pa') return 'pa';
  return 'other';
}

/** "Booth only" captions the play-by-play and colour voices; "All voices" everything with text. */
export function captioned(kind: CaptionKind, mode: SubtitleMode): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return kind === 'pbp' || kind === 'color';
}

export type SpeechEvent = { kind: 'start'; ev: SpeechStartEvent } | { kind: 'end'; ev: SpeechEndEvent };

/** Sort a raw event from the audio layer into a start or an end (the layer may send either through one callback). Unknown shapes give null. */
export function normalizeSpeech(raw: unknown): SpeechEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const id = e.id;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  const type = typeof e.type === 'string' ? e.type.toLowerCase().replace(/[_-]/g, '') : '';
  if (type === 'speechend' || type === 'end' || e.end === true) return { kind: 'end', ev: { id, truncatedAt: typeof e.truncatedAt === 'number' ? e.truncatedAt : undefined } };
  if (typeof e.text === 'string') {
    return {
      kind: 'start',
      ev: {
        id,
        channel: typeof e.channel === 'string' ? e.channel : undefined,
        speaker: typeof e.speaker === 'string' ? e.speaker : undefined,
        text: e.text,
        startMs: typeof e.startMs === 'number' ? e.startMs : undefined,
        expectedDurationMs: typeof e.expectedDurationMs === 'number' ? e.expectedDurationMs : undefined,
      },
    };
  }
  if ('truncatedAt' in e) return { kind: 'end', ev: { id, truncatedAt: typeof e.truncatedAt === 'number' ? e.truncatedAt : undefined } };
  return null;
}

export interface CaptionLine {
  id: string | number;
  kind: CaptionKind;
  label: string;
  text: string;
  /** true when the voice was cut off and the text shortened */
  truncated: boolean;
  /** 'on': shown; 'out': fading away */
  phase: 'on' | 'out';
}

export interface CaptionTiming {
  /** how long a line stays after its voice ended */
  lingerMs: number;
  /** after a cut-off line */
  lingerCutMs: number;
  /** a line is never gone sooner than this after it appeared */
  minShowMs: number;
  /** safety: how long after the expected end a line stays when no end event ever arrives */
  graceMs: number;
  fadeMs: number;
  /** expected duration when the event gives none: per character, with a floor */
  msPerChar: number;
  minExpectedMs: number;
}

export const DEFAULT_TIMING: CaptionTiming = { lingerMs: 650, lingerCutMs: 250, minShowMs: 900, graceMs: 2500, fadeMs: 260, msPerChar: 62, minExpectedMs: 1400 };

interface Entry extends CaptionLine {
  startAt: number;
  hideAt: number;
  removeAt: number;
  ended: boolean;
}

export class CaptionModel {
  private entries: Entry[] = [];

  constructor(public mode: SubtitleMode = 'off', public maxLines = 2, private t: CaptionTiming = DEFAULT_TIMING) {}

  setMode(mode: SubtitleMode): boolean {
    if (mode === this.mode) return false;
    this.mode = mode;
    // lines of voices that are no longer captioned go away at once
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => captioned(e.kind, mode));
    return this.entries.length !== before;
  }

  setMaxLines(n: number, now = 0): boolean {
    this.maxLines = Math.max(1, n);
    return this.trim(now);
  }

  /** A voice starts a line. Returns whether the visible lines changed. */
  start(ev: SpeechStartEvent, now: number): boolean {
    const kind = captionKind(ev);
    const text = (ev.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || !captioned(kind, this.mode)) return false;
    const exp = ev.expectedDurationMs && ev.expectedDurationMs > 0 ? ev.expectedDurationMs : Math.max(this.t.minExpectedMs, text.length * this.t.msPerChar);
    const hideAt = now + exp + this.t.graceMs;
    const old = this.entries.find((e) => e.id === ev.id);
    if (old) {
      Object.assign(old, { text, kind, label: CAPTION_LABELS[kind] || (ev.speaker ?? '').toUpperCase(), truncated: false, phase: 'on' as const, hideAt, ended: false });
      return true;
    }
    this.entries.push({ id: ev.id, kind, label: CAPTION_LABELS[kind] || (ev.speaker ?? '').toUpperCase(), text, truncated: false, phase: 'on', startAt: now, hideAt, removeAt: Infinity, ended: false });
    this.trim(now);
    return true;
  }

  /** The voice finished (or was cut off at `truncatedAt` characters). */
  end(ev: SpeechEndEvent, now: number): boolean {
    const e = this.entries.find((x) => x.id === ev.id);
    if (!e || e.phase === 'out') return false;
    const cut = ev.truncatedAt !== undefined && ev.truncatedAt >= 0 && ev.truncatedAt < e.text.length;
    if (cut) {
      e.text = e.text.slice(0, ev.truncatedAt).trimEnd() + '…';
      e.truncated = true;
    }
    e.ended = true;
    e.hideAt = Math.max(now + (cut ? this.t.lingerCutMs : this.t.lingerMs), e.startAt + this.t.minShowMs);
    return cut;
  }

  /** Too many lines at once: the oldest start fading. */
  private trim(now: number): boolean {
    let changed = false;
    const on = this.entries.filter((e) => e.phase === 'on');
    for (let i = 0; i < on.length - this.maxLines; i++) {
      on[i].phase = 'out';
      on[i].removeAt = now + this.t.fadeMs;
      changed = true;
    }
    return changed;
  }

  /** Time (same clock) of the next thing that changes by itself, or null when nothing is pending. */
  next(): number | null {
    let n: number | null = null;
    for (const e of this.entries) {
      const at = e.phase === 'on' ? e.hideAt : e.removeAt;
      if (n === null || at < n) n = at;
    }
    return n;
  }

  /** Process everything due at `now`; true if the visible lines changed. */
  advance(now: number): boolean {
    let changed = false;
    for (const e of this.entries) {
      if (e.phase === 'on' && e.hideAt <= now) {
        e.phase = 'out';
        e.removeAt = now + this.t.fadeMs;
        changed = true;
      }
    }
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => e.phase === 'on' || e.removeAt > now);
    return changed || this.entries.length !== n;
  }

  lines(): CaptionLine[] {
    return this.entries.map((e) => ({ id: e.id, kind: e.kind, label: e.label, text: e.text, truncated: e.truncated, phase: e.phase }));
  }

  clear(): boolean {
    const had = this.entries.length > 0;
    this.entries = [];
    return had;
  }
}

/** Font scale for each size setting (relative to the base caption size). */
export const SIZE_SCALE = { S: 0.85, M: 1, L: 1.3, XL: 1.7 } as const;

/**
 * What the booth, the PA and the umpire are saying, for captions (the UI renders them). Emitted by the speech gate for every line that
 * really starts to sound; see `AudioController.onSpeech`.
 */
export type SpeechChannel = 'booth' | 'pa' | 'umpire';
export type SpeechSpeaker = 'pbp' | 'color' | 'pa' | 'ump';

export interface SpeechStartEvent {
  type: 'speechStart';
  /** unique per line, increasing */
  id: number;
  channel: SpeechChannel;
  speaker: SpeechSpeaker;
  /** exactly the text handed to the voice (a booth line already has the live count folded in, "(Now one and one.)" included) */
  text: string;
  /** when the line started, in `AudioController.clockMs()` (the audio clock, ms) */
  startMs: number;
  /** the engine's length when it knows it, else an estimate from the words (ms); the real end is `speechEnd` */
  expectedDurationMs: number;
  excited: boolean;
}

export interface SpeechEndEvent {
  type: 'speechEnd';
  id: number;
  endMs: number;
  /** why it ended: spoken to the end, cut by the booth director at a clause, cancelled (a more important line, pause, skip, mute), or the voice failed */
  reason: 'finished' | 'cut' | 'cancelled' | 'error';
  /** a cut / cancelled line: how many characters of `text` were spoken (the caption ends there); absent when the whole line was said */
  truncatedAt?: number;
}

export type SpeechEvent = SpeechStartEvent | SpeechEndEvent;

/** the point where a line that was stopped `elapsedMs` after it started had got to, by the words (engines that know return the exact count) */
export function estimateSpokenChars(text: string, elapsedMs: number, expectedMs: number, clauseEndsMs?: number[]): number {
  if (clauseEndsMs?.length) {
    // a cut at a clause: the engine finishes the clause it is in
    const i = clauseEndsMs.findIndex((e) => e >= elapsedMs);
    if (i < 0) return text.length;
    return clauseCharEnds(text)[i] ?? text.length;
  }
  const f = Math.max(0, Math.min(1, elapsedMs / Math.max(1, expectedMs)));
  let n = Math.floor(text.length * f);
  while (n > 0 && n < text.length && /\S/.test(text[n])) n--; // back to a word boundary
  return n;
}

/** where each clause (see broadcast/text.ts) ends in the text */
function clauseCharEnds(text: string): number[] {
  const ends: number[] = [];
  const re = /[^.!?…,;:—]+[.!?…,;:—]*\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (m[0].trim()) ends.push(m.index + m[0].trimEnd().length);
  return ends;
}

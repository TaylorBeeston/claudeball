/** Text helpers shared by the broadcast director and the speech sinks (pure). */

/** Split a line into clauses at sentence and clause punctuation (kept on the clause). "Ground ball, to short... one away." -> 3 clauses. */
export function clauses(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?…,;:—]+[.!?…,;:—]*\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const c = m[0].trim();
    if (c) out.push(c);
  }
  return out.length ? out : [text.trim()].filter(Boolean);
}

const WORDS_PER_SEC = 2.7;

/** Rough speaking time in seconds at speed 1 (TTS is steady enough for scheduling; sinks report the real end). */
export function estimateDuration(text: string, rate = 1): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const commas = (text.match(/[,;:—]/g) ?? []).length;
  const stops = (text.match(/[.!?…]/g) ?? []).length;
  return Math.max(0.35, (words / WORDS_PER_SEC) / Math.max(0.5, rate) + commas * 0.16 + stops * 0.28);
}

/** Cumulative end time (seconds from the start) of each clause. */
export function clauseEnds(text: string, rate = 1): number[] {
  let t = 0;
  return clauses(text).map((c) => (t += estimateDuration(c, rate)));
}

export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

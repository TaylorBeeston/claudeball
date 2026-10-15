/**
 * What of a booth line a voice track plays, for its caption: the HD voices speak a line piece by piece (`neural.ts`), with a pause
 * between pieces (~0.8 s; inside a piece the gaps are under 0.1 s), so the pieces that have ended by the track's end are what is heard.
 */
import { clauses } from '../../src/audio/broadcast/text';
import { SR } from './dsp';

/** the pieces the HD voice speaks a booth line in (as `neural.ts` does: by clause, a clause under three words joined to the next) */
export function linePieces(text: string): string[] {
  const out: string[] = [];
  for (const piece of clauses(text)) {
    if (out.length && out[out.length - 1].split(/\s+/).length < 3) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out.length ? out : [text];
}

/**
 * The part of `text` (a line that starts sounding at sample `from` of `x`) heard by sample `until`: its pieces whose speech has ended
 * by then (a piece ends at a pause of `gap` seconds or more under `floorDb`). '' when not even the first piece is over.
 * `end`: the line's own end (its `speechEnd`, at sample `at`): a line that finished before `until` is heard whole (the next voice may
 * follow it too closely for a pause); one cut or cancelled before it is heard up to there, a piece that had gone quiet counting as said.
 */
export function heardText(text: string, x: Float32Array, from: number, until: number, { sr = SR, gap = 0.25, floorDb = -50, end }: { sr?: number; gap?: number; floorDb?: number; end?: { at: number; finished: boolean } } = {}): string {
  const pieces = linePieces(text);
  const over = !!end && end.at <= until;
  if (over && end!.finished) return text;
  if (over) until = end!.at;
  const blk = Math.round(0.02 * sr), floor = 10 ** (floorDb / 10), need = Math.ceil((gap * sr) / blk);
  const quiet = (i: number) => {
    let s = 0;
    for (let k = i; k < i + blk; k++) s += k >= 0 && k < x.length ? x[k] * x[k] : 0;
    return s / blk < floor;
  };
  let ended = 0, spoke = false, run = 0, runStart = 0;
  // (a pause that starts before `until` may run past it; after the line's end nothing more of it comes)
  for (let i = from; i < (over ? until : until + need * blk) && ended < pieces.length; i += blk) {
    if (!quiet(i)) {
      spoke = true;
      run = 0;
      continue;
    }
    if (!spoke) continue;
    if (run++ === 0) runStart = i;
    if (run >= need) {
      if (runStart < until) ended++;
      spoke = false;
      run = 0;
    }
  }
  if (over && spoke && run > 0) ended++;
  return pieces.slice(0, Math.min(ended, pieces.length)).join(' ');
}

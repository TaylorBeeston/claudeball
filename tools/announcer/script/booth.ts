/**
 * The booth's own written lines, straight from the game (src/audio/broadcast): the anecdotes Lyle and Biscuit tell in long lulls, the running
 * jokes, the catchphrases and the park promos. They are fixed sentences (no play-by-play slots), so the recording script takes every wording as it
 * is, with the partner's name filled in. Lyle's lines are read as play-by-play (calm), Biscuit's as colour (deadpan), the home-run and strikeout
 * catchphrases as the big call. Extended tier only, in sessions of their own after the others (adding them renumbers nothing already recorded).
 */
import { ANECDOTES } from '../../../src/audio/broadcast/anecdotes';
import { CAST, CATCHPHRASES, PROMOS, RUNNING_JOKES } from '../../../src/audio/broadcast/cast';
import type { Kind, Style } from './types';

export interface BoothRaw {
  kind: Kind;
  style: Style;
  direction: string;
  text: string;
  source: string;
}

const LYLE = 'Easy play-by-play conversation with your partner; warm, a little dry, fall on the last word.';
const BISCUIT = 'Colour man telling a story on himself: dry, amused, unhurried; let the punchline land soft.';
const BIG = 'The signature call: full voice, then let it ring.';

/** fill the names a line uses: what each one calls the other, the mascot (a stand-in name: the game draws a different one per park) */
function fill(t: string, speaker: 'pxp' | 'color'): string {
  const other = speaker === 'pxp' ? CAST.color.calledBy[0] : CAST.pbp.calledBy[0];
  return t.replace(/\$other/g, other).replace(/\$pbp/g, CAST.pbp.calledBy[0]).replace(/\$color/g, CAST.color.calledBy[0]).replace(/\$mascot/g, 'Rowdy').replace(/\$park/g, 'the ballpark');
}

const as = (speaker: 'pxp' | 'color', t: string, source: string): BoothRaw => ({ kind: 'chatter', style: speaker === 'pxp' ? 'calm' : 'deadpan', direction: speaker === 'pxp' ? LYLE : BISCUIT, text: fill(t, speaker), source });

export function boothLines(): BoothRaw[] {
  const out: BoothRaw[] = [];
  for (const a of ANECDOTES) {
    const opener = a.a;
    const other = opener === 'pxp' ? 'color' : 'pxp';
    for (const l of a.lines) for (const t of l.t) out.push(as(l.who === 'A' ? opener : other, t, 'booth:anecdotes'));
  }
  for (const j of RUNNING_JOKES) {
    const a = j.a === 'pbp' ? 'pxp' : 'color';
    const b = a === 'pxp' ? 'color' : 'pxp';
    for (const stage of j.stages) for (const l of stage) for (const t of l.t) out.push(as(l.who === 'A' ? a : b, t, 'booth:jokes'));
  }
  for (const c of CATCHPHRASES)
    for (const t of c.lines)
      out.push(c.trigger === 'homeRun' || c.trigger === 'strikeout' ? { kind: 'playbyplay', style: c.who === 'pbp' ? 'peak' : 'deadpan', direction: c.who === 'pbp' ? BIG : BISCUIT, text: fill(t, c.who === 'pbp' ? 'pxp' : 'color'), source: 'booth:phrases' } : as(c.who === 'pbp' ? 'pxp' : 'color', t, 'booth:phrases'));
  for (const p of PROMOS) out.push(as('pxp', p, 'booth:promos'));
  return out;
}

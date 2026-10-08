/**
 * Scripted segments after the opening: the break between half innings and the closing wrap-up. Like the opening (`pregame.ts`), they are built
 * from facts only (the game log's moments and half-inning totals, the box score, who is due up, the park and the weather flavour that stays the same
 * all game) and fitted to the time the sim gives them (`breakStart.sec`); the director says them in order and skips what does not fit.
 *
 * A break: the recap of the half that just ended, the pitcher's line, now and then a time / weather update, a park promo or a running joke, and the
 * hitters due up. A long break (30 s and more) has a "we'll be right back" in the middle and "and we're back" timed to end with the break. The
 * seventh-inning stretch silences the booth: that break's segment is parked and resumes after the organ, opening with a word about the stretch.
 */
import { CAST, PROMOS, RUNNING_JOKES, type RunningJoke } from './cast';
import { clockAt, clockWords, fitBlocks, weatherFor, type Block, type OpeningFacts } from './pregame';
import { lastNameOf } from './ctx';
import { isHit, isK, isWalk, type GameLog, type Moment } from './gamelog';
import type { Level, Segment, VoiceId } from './director';
import { estimateDuration } from './text';
import { mulberry32 } from '../dsp';

const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const nw = (n: number) => NUM[n] ?? String(n);
const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth'];
const ord = (n: number) => ORD[n] ?? `${n}th`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pick = <T,>(r: () => number, a: T[]): T => a[Math.floor(r() * a.length)];
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charAt(i).charCodeAt(0), 16777619) >>> 0;
  return h;
};
const P = CAST.pbp;
const C = CAST.color;

/** what a box-score line looks like (the sim's `getBoxScore()`) */
export interface BoxLine {
  id: string;
  name: string;
  line: Record<string, number>;
}
export interface Box {
  home: { name: string; batters: BoxLine[]; pitchers: BoxLine[]; hits?: number; errors?: number };
  away: { name: string; batters: BoxLine[]; pitchers: BoxLine[]; hits?: number; errors?: number };
}

const innW = (outs: number) => {
  const i = Math.floor(outs / 3);
  const f = outs % 3;
  return f === 0 ? `${nw(i)} inning${i === 1 ? '' : 's'}` : i === 0 ? `${nw(f)} third${f === 1 ? '' : 's'} of an inning` : `${nw(i)} and ${f === 1 ? 'a third' : 'two-thirds'}`;
};

/** "Mason's two-run double", "a solo homer by Mason" */
export function momentWords(m: Moment, name: (id: string) => string | undefined): string | null {
  const b = name(m.batterId);
  if (!b) return null;
  const r = m.result ?? '';
  const runs = m.runs === 1 ? 'RBI' : `${nw(m.runs)}-run`;
  if (m.kind === 'hr') return m.runs <= 1 ? `${b}'s solo home run` : m.runs === 4 ? `${b}'s grand slam` : `${b}'s ${nw(m.runs)}-run homer`;
  if (m.kind === 'rbiHit') return `${b}'s ${runs} ${r}`;
  if (m.kind === 'robbed') {
    const f = m.fielderId ? name(m.fielderId) : undefined;
    return f ? `${f} robbing ${b} of a home run` : null;
  }
  if (m.kind === 'doublePlay') return `the double play on ${b}`;
  if (m.kind === 'strikeoutRisp') return `the strikeout of ${b} with runners in scoring position`;
  return null;
}

export interface BreakInput {
  facts: OpeningFacts;
  log: GameLog;
  /** the half that just ended */
  inning: number;
  half: 'top' | 'bottom';
  score: { home: number; away: number };
  /** seconds of break */
  sec: number;
  dueUp: { id: string; name: string }[];
  box?: Box | null;
  /** a player's last name by id */
  name: (id: string) => string | undefined;
  /** the pitcher who worked the half that just ended */
  pitcherId?: string;
  level?: Level;
  /** a running joke stage that may be told now (the booth tracks which and when) */
  joke?: { joke: RunningJoke; stage: number } | null;
  /** how many breaks so far (promos and the clock every few breaks, not every time) */
  n: number;
  /** the stretch will silence the booth at the start of this break */
  stretch?: boolean;
  dur?: (text: string) => number;
  /** true for words said recently (a variant is chosen instead) */
  avoid?: (text: string) => boolean;
}

/** expand a joke stage into block turns ($pbp / $color are the names each calls the other) */
export function jokeTurns(j: RunningJoke, stage: number, r: () => number): { speaker: VoiceId; text: string }[] {
  const a: VoiceId = j.a === 'pbp' ? 'pxp' : 'color';
  const b: VoiceId = a === 'pxp' ? 'color' : 'pxp';
  return (j.stages[stage] ?? []).map((l) => ({ speaker: l.who === 'A' ? a : b, text: pick(r, l.t).replace(/\$pbp/g, P.calledBy[0]).replace(/\$color/g, C.calledBy[0]) }));
}

export function promoLines(f: OpeningFacts): string[] {
  const day = f.tod === 'day';
  return PROMOS.filter((p) => !(day && /night|fireworks/i.test(p)) && (f.mascot || !p.includes('$mascot'))).map((p) =>
    p.replace(/\$park/g, f.venue?.name ?? 'the ballpark').replace(/\$mascot/g, f.mascot ?? '').replace(/\$color/g, C.calledBy[0]).replace(/tonight/g, day ? 'today' : 'tonight'),
  );
}

export function breakSegment(x: BreakInput): Segment {
  const f = x.facts;
  const dur = x.dur ?? ((t: string) => estimateDuration(t, 1));
  const r = mulberry32(hash(`${f.seed}|break|${x.inning}${x.half}`));
  const top = x.half === 'top';
  const batSide = top ? 'away' : 'home';
  const nextSide = top ? 'home' : 'away';
  const club = (s: 'home' | 'away') => (s === 'home' ? f.home : f.away);
  const nick = (s: 'home' | 'away') => club(s).nick;
  const blocks: Block[] = [];
  const lead = x.score.home === x.score.away ? null : x.score.home > x.score.away ? 'home' : 'away';
  const scoreW = lead ? `${nick(lead)} ${Math.max(x.score.home, x.score.away)}, ${nick(lead === 'home' ? 'away' : 'home')} ${Math.min(x.score.home, x.score.away)}` : `tied at ${x.score.home}`;
  const avoid = x.avoid ?? (() => false);
  /** a variant not said recently (else any) */
  const pf = (a: string[]) => {
    const ok = a.filter((v) => !avoid(v));
    return pick(r, ok.length ? ok : a);
  };
  const when = top ? `Middle of the ${ord(x.inning)}` : x.inning === 1 ? 'After one' : pf([`After ${nw(x.inning)}`, `End of ${nw(x.inning)}`, `Through ${nw(x.inning)}`]);
  const runs = x.log.runsByHalf.get(`${x.inning}${top ? 't' : 'b'}`) ?? 0;
  const ms = x.log.moments.filter((m) => m.inning === x.inning && m.half === x.half && (m.kind === 'hr' || m.kind === 'rbiHit'));
  const big = ms.sort((a, b) => b.runs - a.runs)[0];
  const bigW = big ? momentWords(big, x.name) : null;
  const h = x.log.half;
  const pit = x.pitcherId ? x.name(x.pitcherId) : undefined;
  let recap: string;
  if (runs > 0) recap = `${when}, it's ${scoreW}. The ${nick(batSide)} scored ${nw(runs)} in the ${x.half}${bigW ? `, ${bigW} the big blow` : ''}.`;
  else if (h.batters <= 3 && h.hits === 0 && h.walks === 0 && pit) recap = `${when}, ${scoreW}. ${pf([`A quick one-two-three ${x.half} for ${pit}.`, `${pit} sets them down in order.`, `Three up, three down for ${pit}.`, `${pit} needed just three hitters.`])}`;
  else if (h.ks >= 2 && pit) recap = `${when}, ${scoreW}. ${pf([`${pit} struck out ${nw(h.ks)} in the inning.`, `${nw(h.ks).charAt(0).toUpperCase() + nw(h.ks).slice(1)} strikeouts in the inning for ${pit}.`])}`;
  else if (h.hits + h.walks >= 2) recap = `${when}, ${scoreW}. ${pf([`The ${nick(batSide)} had ${h.hits + h.walks > 2 ? 'some' : 'a couple of'} runners on, but nothing came of it.`, `Traffic on the bases for the ${nick(batSide)}, but no runs.`, `${pit ?? 'The pitcher'} worked around a little trouble.`])}`;
  else recap = `${when}, ${scoreW}.`;
  const low = x.level === 'low';
  const long = x.sec >= 30 && !low;
  // the "commercial" (we'll be right back ... and we're back) in every other long break, not every one
  const commercial = long && x.n % 2 === 0;
  // the stretch: the organ plays first, the booth comes back to a word about it
  if (x.stretch) blocks.push({ id: 'stretch', pri: 0, essential: true, turns: [{ speaker: 'color', text: pick(r, ['Nothing like the seventh-inning stretch. I used to stretch for all nine, Lyle. I was a backup catcher.', `Good stretch. Even ${P.first} stood up for that one.`]) }] });
  const short = x.sec < 15;
  blocks.push({ id: 'recap', pri: 0, essential: true, turns: [{ speaker: 'pxp', text: recap }] });
  // the pitcher who just worked: his line so far
  const pl = x.box && x.pitcherId ? [...x.box.home.pitchers, ...x.box.away.pitchers].find((p) => p.id === x.pitcherId) : undefined;
  if (pl && pit && (pl.line.outs ?? 0) >= 6) {
    const L = pl.line;
    const good = (L.er ?? 0) <= 1 && (L.h ?? 0) <= (L.outs ?? 0) / 3;
    blocks.push({
      id: 'pitcher',
      pri: 1,
      turns: [
        { speaker: 'pxp', text: `${pit} through ${innW(L.outs)}: ${nw(L.h ?? 0)} hit${L.h === 1 ? '' : 's'}, ${nw(L.so ?? 0)} strikeout${L.so === 1 ? '' : 's'}, ${L.pitches ?? 0} pitches.` },
        { speaker: 'color', text: good ? pf(['He has been in command. Nothing has come easy against him.', `That's a good ${f.tod === 'day' ? "day's" : "night's"} work so far, ${P.first}.`, 'Hitters are not getting comfortable against him.', 'He is making it look easy.']) : (L.pitches ?? 0) >= 85 ? pf(['That pitch count is climbing. Somebody will be warming up soon.', 'He has had to work for every out.', 'That is a lot of pitches for this point of the game.']) : pf(['He has had his moments, good and bad.', 'Not his sharpest, but he is keeping them in it.', 'He is grinding through it.', 'Not always pretty, but he is getting outs.']) },
      ],
    });
  }
  // every few breaks: the clock and the weather, a promo, a running joke
  const wx = weatherFor(f);
  if (long && x.n % 3 === 1 && f.venue) {
    const ck = clockAt(wx, x.inning + (top ? 0 : 1), top ? 'bottom' : 'top');
    blocks.push({ id: 'clock', pri: 4, turns: [{ speaker: 'pxp', text: `It's ${clockWords(ck.h, ck.m)} here at ${f.venue.name}, ${wx.tempF + (f.tod === 'night' ? -Math.min(4, Math.floor(x.inning / 3)) : 0)} degrees.` }] });
  }
  if (long && x.n % 3 === 2) {
    const promos = promoLines(f);
    if (promos.length) blocks.push({ id: 'promo', pri: 5, turns: [{ speaker: 'pxp', text: pf(promos) }] });
  }
  if (long && x.joke) blocks.push({ id: `joke.${x.joke.joke.id}`, pri: 3, whole: true, turns: jokeTurns(x.joke.joke, x.joke.stage, r) });
  // due up
  const due = x.dueUp.map((d) => lastNameOf(d.name));
  // a short break (Quick tempo) has room for one line: the score and who is due up
  if (short) {
    const line = due.length >= 3 ? `${when}, ${scoreW}. ${due[0]}, ${due[1]} and ${due[2]} due up for the ${nick(nextSide)}.` : `${when}, ${scoreW}.`;
    return { tag: 'break', turns: [{ speaker: 'pxp', text: line, block: 'recap', optional: true }] };
  }
  const nextHalf = top ? `the bottom of the ${ord(x.inning)}` : `the top of the ${ord(x.inning + 1)}`;
  const dueText = due.length >= 3 ? `Due up for the ${nick(nextSide)} in ${nextHalf}: ${due[0]}, ${due[1]} and ${due[2]}.` : null;
  const back = commercial ? [{ speaker: 'pxp' as VoiceId, text: pf([`We'll be right back.`, `Stay with us. We'll be right back from ${f.venue?.name ?? 'the ballpark'}.`, `Time for a break. Back in a moment.`]) }] : [];
  const parts: Block[] = [];
  if (back.length) parts.push({ id: 'back', pri: 0, essential: true, turns: back });
  const segA = fitBlocks('break', [...blocks, ...parts], Math.max(4, commercial ? x.sec * 0.5 : x.sec - (dueText ? dur(dueText) + 1 : 0) - 1.5), low, dur, new Set(['stretch', 'recap', 'back']));
  if (!dueText) return segA;
  // the due-up line closes the break: "and we're back" after the commercial in a long break
  const backText = commercial ? `${pf(["And we're back", 'Back here at ' + (f.venue?.name ?? 'the ballpark'), "We're back"])}. ${dueText}` : dueText;
  const at = commercial ? Math.max(0, x.sec - dur(backText) - 2.5) : undefined;
  // with a commercial, extras (the director skips them) must not run into it: keep only the chosen turns of part A
  const turnsA = commercial ? segA.turns.filter((t) => !t.block.endsWith('+')) : segA.turns;
  return { tag: 'break', turns: [...turnsA, { speaker: 'pxp', text: backText, block: 'due', optional: false, notBefore: at }] };
}

export interface ClosingInput {
  facts: OpeningFacts;
  log: GameLog;
  score: { home: number; away: number };
  box?: Box | null;
  name: (id: string) => string | undefined;
  budget: number;
  level?: Level;
  dur?: (text: string) => number;
}

/** The wrap-up after the final out: the final, the moment that decided it, a standout line, the records, the sign-off. */
export function closingSegment(x: ClosingInput): Segment {
  const f = x.facts;
  const dur = x.dur ?? ((t: string) => estimateDuration(t, 1));
  const r = mulberry32(hash(`${f.seed}|closing`));
  const tie = x.score.home === x.score.away;
  const win: 'home' | 'away' = x.score.home > x.score.away ? 'home' : 'away';
  const lose = win === 'home' ? 'away' : 'home';
  const club = (s: 'home' | 'away') => (s === 'home' ? f.home : f.away);
  const hi = Math.max(x.score.home, x.score.away);
  const lo = Math.min(x.score.home, x.score.away);
  const blocks: Block[] = [];
  blocks.push({
    id: 'final',
    pri: 0,
    essential: true,
    turns: [{ speaker: 'pxp', text: tie ? `It ends tied at ${hi} here at ${f.venue?.name ?? 'the ballpark'}.` : `The final here at ${f.venue?.name ?? 'the ballpark'}: the ${club(win).nick} ${hi}, the ${club(lose).nick} ${lo}.` }],
  });
  // the moment that decided it: the last time the winners went ahead for good, else their biggest hit
  const winHalf = win === 'away' ? 'top' : 'bottom';
  const ms = x.log.moments.filter((m) => m.half === winHalf && (m.kind === 'hr' || m.kind === 'rbiHit'));
  const goAhead = [...ms].reverse().find((m) => m.before !== 'ahead');
  const key = goAhead ?? [...ms].sort((a, b) => b.runs - a.runs)[0];
  const keyW = key ? momentWords(key, x.name) : null;
  if (!tie && keyW && key)
    blocks.push({
      id: 'key',
      pri: 1,
      turns: [
        { speaker: 'pxp', text: `The difference: ${keyW} in the ${ord(key.inning)}${key.before === 'tied' ? ', breaking the tie' : key.before === 'behind' ? ', putting them ahead' : ''}.` },
        { speaker: 'color', text: pick(r, [`That was the swing of the night, ${P.first}.`, 'Big moment, and he did not miss it.', 'That is the one they will be talking about.']) },
      ],
    });
  // a standout: the winners' starter (or best pitcher), or their best bat
  const box = x.box;
  if (box && !tie) {
    const side = box[win];
    const ace = [...side.pitchers].sort((a, b) => (b.line.outs ?? 0) - (a.line.outs ?? 0))[0];
    const bat = [...side.batters].sort((a, b) => (b.line.h ?? 0) * 2 + (b.line.hr ?? 0) * 3 + (b.line.rbi ?? 0) - ((a.line.h ?? 0) * 2 + (a.line.hr ?? 0) * 3 + (a.line.rbi ?? 0)))[0];
    if (ace && (ace.line.outs ?? 0) >= 15) {
      const L = ace.line;
      blocks.push({ id: 'ace', pri: 2, turns: [{ speaker: 'color', text: `${lastNameOf(ace.name)} gave them ${innW(L.outs)}: ${nw(L.h ?? 0)} hit${L.h === 1 ? '' : 's'}, ${nw(L.er ?? 0)} earned, ${nw(L.so ?? 0)} strikeout${L.so === 1 ? '' : 's'}. ${pick(r, ['That is how you win a ballgame.', 'Give him the game ball.'])}` }] });
    }
    if (bat && (bat.line.h ?? 0) >= 2)
      blocks.push({ id: 'bat', pri: 3, turns: [{ speaker: 'pxp', text: `${lastNameOf(bat.name)} went ${nw(bat.line.h)} for ${nw(bat.line.ab ?? bat.line.h)}${(bat.line.rbi ?? 0) > 0 ? ` with ${nw(bat.line.rbi)} RBI` : ''}${(bat.line.hr ?? 0) > 0 ? ` and ${bat.line.hr === 1 ? 'a home run' : `${nw(bat.line.hr)} home runs`}` : ''}.` }] });
  }
  // the records after tonight
  if (!tie && f.home.record && f.away.record) {
    const wr = club(win).record!;
    const lr = club(lose).record!;
    blocks.push({ id: 'records', pri: 4, turns: [{ speaker: 'pxp', text: `The ${club(win).nick} improve to ${wr.w + 1} and ${wr.l}; the ${club(lose).nick} fall to ${lr.w} and ${lr.l + 1}.` }] });
  }
  const tod = f.tod === 'day' ? 'afternoon' : 'night';
  blocks.push({
    id: 'signoff',
    pri: 0,
    essential: true,
    turns: [
      {
        speaker: 'color',
        text: pick(
          r,
          tie
            ? [`Nobody goes home happy from a tie, ${P.first}.`]
            : hi - lo >= 6
              ? [`Not much drama late, but the ${club(win).nick} will take that one, ${P.first}.`, `A laugher. The ${club(win).nick} will sleep well.`]
              : hi - lo <= 1
                ? [`What a ballgame, ${P.first}. That one went right down to the wire.`, `My heart cannot take many more of those, ${P.first}.`]
                : [`Fun one ${f.tod === 'day' ? 'today' : 'tonight'}, ${P.first}.`, `I enjoyed that one, ${P.first}.`],
        ),
      },
      { speaker: 'pxp', text: `For ${C.first} "${C.nickname}" ${C.last}, I'm ${P.first} ${P.last}. Thanks for spending the ${tod} with us, and good night from ${f.venue?.name ?? 'the ballpark'}.`.replace('good night', f.tod === 'day' ? 'so long' : 'good night') },
    ],
  });
  // the sign-off is the last thing said: fit the rest first
  const body = fitBlocks('close', blocks.filter((b) => b.id !== 'signoff'), Math.max(4, x.budget - blocks.find((b) => b.id === 'signoff')!.turns.reduce((a, t) => a + dur(t.text!) + 0.45, 0)), x.level === 'low', dur, new Set());
  return { tag: 'close', turns: [...body.turns.filter((t) => !t.block.endsWith('+')), ...blocks.find((b) => b.id === 'signoff')!.turns.map((t) => ({ speaker: t.speaker, text: t.text!, block: 'signoff', optional: false }))] };
}

/** a hitter's game so far, for callbacks ("Last time up, Mason doubled in a run in the third") */
export function lastTimeUp(log: GameLog, batterId: string, name: (id: string) => string | undefined): string | null {
  const pas = log.batterPas(batterId).filter((p) => p.result);
  const prev = pas[pas.length - 1];
  const b = name(batterId);
  if (!prev || !b) return null;
  const r = prev.result!;
  const inn = `in the ${ord(prev.inning)}`;
  if (/^home run/.test(r)) return `Last time up, ${b} homered ${inn}.`;
  if (isHit(r)) return (prev.runs ?? 0) > 0 ? `Last time up, ${b} drove in ${prev.runs === 1 ? 'a run' : `${nw(prev.runs!)} runs`} with a ${r} ${inn}.` : r === 'single' ? null : `Last time up, ${b} hit a ${r} ${inn}.`;
  const ks = pas.filter((p) => isK(p.result)).length;
  if (isK(r) && ks >= 2) return `${b} has struck out ${ks === 2 ? 'twice' : `${nw(ks)} times`} so far.`;
  if (isWalk(r)) return null;
  return null;
}

export const ALL_JOKES = RUNNING_JOKES;

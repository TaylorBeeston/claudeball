/**
 * The opening broadcast: what the booth says while the teams take the field and the starting pitcher warms up, fitted to the pregame the sim gives
 * them (`breakStart { pregame: true, sec }`), and the "play ball" handoff into the top of the first.
 *
 * Everything said is either a game fact (the clubs, the lineups, the starters' arsenals and grades from the sim's own team data) or generated flavour
 * that stays the same for the whole game: the park, the officials, the managers, the records and the date (the sim's `GameInfo`), and the weather and
 * first-pitch time derived here from the seed and the time of day the renderer shows (day / dusk / night; partly cloudy only when the day HDRI is on).
 * Nothing claims the wind moves the ball unless the sim has a wind. Pure and deterministic: the same seed, teams and time of day give the same words.
 */
import { say } from './grammar';
import { CAST } from './cast';
import { pitchName } from '../commentary';
import type { Level, Segment, SegmentTurn, VoiceId } from './director';
import { estimateDuration } from './text';
import { mulberry32 } from '../dsp';

export type Tod = 'day' | 'dusk' | 'night';

export interface PitcherFacts {
  name: string;
  last: string;
  throws: 'L' | 'R';
  age?: number;
  /** pitches by usage share (most used first) */
  arsenal: { type: string; mph: number; share: number; grade?: number }[];
  control?: number;
  stamina?: number;
}

export interface HitterFacts {
  name: string;
  last: string;
  pos: string;
  bats: 'L' | 'R' | 'S';
  speed: number;
  power: number;
  contact: number;
  eye: number;
}

export interface ClubFacts {
  name: string;
  city: string;
  nick: string;
  /** e.g. "green and gold" */
  colors?: string;
  record?: { w: number; l: number; last10: ('W' | 'L')[]; streak: { kind: 'W' | 'L'; n: number } };
  manager?: { name: string; season: number; background: string; pitchingCoach: string };
  starter?: PitcherFacts;
  lineup: HitterFacts[];
}

export interface OpeningFacts {
  seed: string;
  tod: Tod;
  /** the day sky is the partly cloudy HDRI (else the procedural, cloudless sky) */
  cloudy?: boolean;
  venue?: { name: string; short: string; city: string; opened: number; capacity: number; lf: number; cf: number; rf: number; feature: string };
  date?: { monthName: string; day: number; weekdayName: string; month: number };
  umpires?: { key: string; name: string; years: number; chief: boolean }[];
  mascot?: string;
  wind?: { x: number; z: number } | null;
  home: ClubFacts;
  away: ClubFacts;
}

// ---- small words ------------------------------------------------------------------------------------------------------------

const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const nw = (n: number) => NUM[n] ?? String(n);
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first'];
const grade5 = (g: number | undefined) => (g === undefined ? undefined : Math.round(g / 5) * 5);
/** singular team nicknames take singular verbs ("the Thunder is ...") */
const singular = (nick: string) => !/s$/i.test(nick) && !/^(lynx|bison|ironmen)$/i.test(nick);
const v = (nick: string, pl: string, sg: string) => (singular(nick) ? sg : pl);

/** 7:05 -> "seven-oh-five", 1:30 -> "one-thirty", 7:00 -> "seven o'clock" */
export function clockWords(h24: number, m: number): string {
  const h = ((h24 + 11) % 12) + 1;
  const H = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][h % 12 === 0 ? 0 : h];
  if (m === 0) return `${H} o'clock`;
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
  const mm = m < 10 ? `oh-${NUM[m]}` : m < 13 ? NUM[m] : m < 20 ? ['thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'][m - 13] : `${tens[Math.floor(m / 10)]}${m % 10 ? '-' + NUM[m % 10] : ''}`;
  return `${H}-${mm}`;
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};
/** a random stream per purpose, so changing one input (the time of day) only changes the words that depend on it */
const rngFor = (seed: string, what: string) => mulberry32(hash(`${seed}|${what}`));

// ---- weather and the clock (flavour, consistent for the whole game) -----------------------------------------------------------------

export interface Weather {
  tempF: number;
  /** first pitch, 24 h */
  firstPitch: { h: number; m: number };
  sky: string;
  breeze: string;
  /** the wind is real (the sim has one): only then may the booth say it helps or hurts fly balls */
  realWind: boolean;
}

const MONTH_BASE: Record<number, number> = { 3: 55, 4: 60, 5: 68, 6: 77, 7: 82, 8: 81, 9: 74, 10: 63 };

export function weatherFor(f: Pick<OpeningFacts, 'seed' | 'tod' | 'cloudy' | 'date' | 'venue' | 'wind'>): Weather {
  const r = rngFor(f.seed, 'weather');
  const month = f.date?.month ?? 7;
  const city = hash(f.venue?.city ?? 'x') % 13 - 6; // some towns run warmer than others
  const tempF = Math.round((MONTH_BASE[month] ?? 72) + (f.tod === 'day' ? 4 : f.tod === 'night' ? -4 : 0) + city + (r() - 0.5) * 6);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const fp = f.tod === 'day' ? pick([[13, 5], [13, 10], [12, 35], [13, 35]]) : f.tod === 'dusk' ? pick([[19, 5], [19, 10], [18, 40]]) : pick([[20, 5], [20, 10], [19, 40]]);
  const sky =
    f.tod === 'day'
      ? f.cloudy
        ? pick(['partly cloudy skies', 'a few clouds drifting over', 'sun and clouds'])
        : pick(['blue skies', 'not a cloud in the sky', 'plenty of sunshine'])
      : f.tod === 'dusk'
        ? pick(['the sun going down out beyond left field', 'the sun setting beyond the left-field stands', 'a sunset out past left field'])
        : pick(['a clear night', 'a clear, dark sky', 'a beautiful night']);
  let breeze: string;
  let realWind = false;
  if (f.wind) {
    realWind = true;
    const mph = Math.round(Math.hypot(f.wind.x, f.wind.z) * 2.237);
    const out = f.wind.z > Math.abs(f.wind.x) * 0.5;
    const inn = f.wind.z < -Math.abs(f.wind.x) * 0.5;
    breeze = `the wind ${out ? 'blowing out' : inn ? 'blowing in' : f.wind.x > 0 ? 'blowing toward left' : 'blowing toward right'} at about ${mph} miles an hour`;
  } else breeze = pick(['hardly a breeze', 'just a light breeze', 'barely a breath of wind', 'the flags hanging still']);
  return { tempF, firstPitch: { h: fp[0], m: fp[1] }, sky, breeze, realWind };
}

/** the clock at a point of the game (first pitch + about 19 minutes a half-inning played): for "it's a quarter past nine here" updates */
export function clockAt(w: Weather, inning: number, half: 'top' | 'bottom'): { h: number; m: number } {
  const mins = w.firstPitch.h * 60 + w.firstPitch.m + Math.round(((inning - 1) * 2 + (half === 'bottom' ? 1 : 0)) * 9.5);
  return { h: Math.floor(mins / 60) % 24, m: mins % 60 };
}

// ---- describing people ----------------------------------------------------------------------------------------------------------------

const hand = (t: 'L' | 'R') => (t === 'L' ? 'left-hander' : 'right-hander');
const FAST = new Set(['FF', 'FT', 'SI']);

/** what the analyst says about a starter: velocity, the mix, his best pitch (from the arsenal's grades and usage), command */
export function pitcherNote(p: PitcherFacts, r: () => number): { fastball?: string; mix: string; best?: string; command?: string } {
  const fb = p.arsenal.find((a) => FAST.has(a.type)) ?? p.arsenal[0];
  const names = p.arsenal.map((a) => pitchName(a.type));
  const mix = names.length > 1 ? `${names.slice(0, -1).join(', ')}${names.length > 2 ? ',' : ''} and ${names[names.length - 1]}` : names[0] ?? 'fastball';
  const sec = p.arsenal.filter((a) => !FAST.has(a.type) && a.grade !== undefined).sort((a, b) => (b.grade ?? 0) - (a.grade ?? 0))[0];
  const share = sec ? Math.round(sec.share * 100) : 0;
  const shareW = share >= 40 ? 'nearly half the time' : share >= 28 ? 'about a third of the time' : share >= 20 ? 'about a quarter of the time' : share >= 12 ? 'every so often' : 'once in a while';
  const fastball = fb ? pick(r, [`he sits around ${Math.round(fb.mph)} with the ${pitchName(fb.type)}`, `he works at ${Math.round(fb.mph)} with the ${pitchName(fb.type)}`]) : undefined;
  const best = sec && (sec.grade ?? 0) >= 55 ? `the ${pitchName(sec.type)} is his best pitch, a ${grade5(sec.grade)} on the scouting scale, and he throws it ${shareW}` : undefined;
  const c = p.control ?? 50;
  const command = c >= 65 ? 'He pounds the strike zone.' : c <= 38 ? 'The command comes and goes, so the walks can pile up.' : undefined;
  return { fastball, mix, best, command };
}

/** a line about the lineup: the leadoff man's legs, the cleanup man's power, the best bat */
export function lineupNotes(c: ClubFacts): { leadoff?: string; cleanup?: string; best?: string } {
  const L = c.lineup;
  const out: { leadoff?: string; cleanup?: string; best?: string } = {};
  const lead = L[0];
  if (lead) out.leadoff = lead.speed >= 60 ? `${lead.last} leads off, and he can fly: a ${grade5(lead.speed)} runner` : lead.eye >= 60 ? `${lead.last} leads off, a patient hitter with a ${grade5(lead.eye)} eye` : `${lead.last} leads off`;
  const four = L[3];
  if (four) out.cleanup = four.power >= 60 ? `${four.last} hits cleanup with ${grade5(four.power)} power` : `${four.last} bats cleanup`;
  const bestBat = [...L].sort((a, b) => b.contact + b.power - (a.contact + a.power))[0];
  if (bestBat && bestBat !== four && bestBat !== lead && bestBat.contact + bestBat.power >= 120) out.best = `${bestBat.last} might be the best bat in the lineup: ${grade5(bestBat.contact)} contact, ${grade5(bestBat.power)} power`;
  return out;
}

function recordLine(c: ClubFacts, r: () => number): string | null {
  const rec = c.record;
  if (!rec) return null;
  const w10 = rec.last10.filter((x) => x === 'W').length;
  const n10 = rec.last10.length;
  const last5 = rec.last10.slice(-5).filter((x) => x === 'W').length;
  const their = v(c.nick, 'their', 'its');
  const form =
    rec.streak.n >= 3
      ? rec.streak.kind === 'W'
        ? `winners of ${nw(rec.streak.n)} straight`
        : `losers of ${nw(rec.streak.n)} in a row`
      : last5 >= 4
        ? `winners of ${nw(last5)} of ${their} last five`
        : last5 <= 1
          ? `losers of ${nw(5 - last5)} of ${their} last five`
          : `${nw(w10)} and ${nw(n10 - w10)} over ${their} last ${nw(n10)}`;
  return say([`The ${c.nick} ${v(c.nick, 'come', 'comes')} in at ${rec.w} and ${rec.l}, ${form}.`, `The ${c.nick}: ${rec.w} and ${rec.l} on the year, ${form}.`], {}, r);
}

// ---- the segment ------------------------------------------------------------------------------------------------------------------------

interface Block {
  id: string;
  /** lower = more important; essential blocks are always said */
  pri: number;
  essential?: boolean;
  turns: { speaker: VoiceId; text: string | null; excited?: boolean }[];
}

const P = CAST.pbp;
const C = CAST.color;

export interface OpeningOpts {
  /** seconds available (the pregame length minus whatever plays before the booth starts) */
  budget: number;
  level?: Level;
  /** speaking-time estimate (seconds) */
  dur?: (text: string) => number;
}

/** The opening segment, fitted to `budget` seconds (3 % margin; the director also skips an optional block at run time when it would not fit). */
export function openingSegment(f: OpeningFacts, o: OpeningOpts): Segment {
  const dur = o.dur ?? ((t: string) => estimateDuration(t, 1));
  const wx = weatherFor(f);
  const R = (what: string) => rngFor(f.seed, what);
  const H = f.home;
  const A = f.away;
  const evening = f.tod !== 'day';
  const venue = f.venue;
  const where = venue ? venue.name : H.city;
  const date = f.date ? `on a ${f.date.weekdayName} ${f.tod === 'day' ? 'afternoon' : f.tod === 'dusk' ? 'evening' : 'night'} in ${f.date.day <= 10 ? 'early' : f.date.day <= 20 ? 'mid-' : 'late'}${f.date.day <= 10 || f.date.day > 20 ? ' ' : ''}${f.date.monthName}` : '';
  const blocks: Block[] = [];
  const add = (b: Block) => blocks.push(b);
  let r = R('welcome');
  const short = o.budget < 20;
  add({
    id: 'welcome',
    pri: 0,
    essential: true,
    turns: short
      ? [{ speaker: 'pxp', text: `${evening ? 'Good evening' : 'Good afternoon'} from ${venue ? venue.name : H.city}, where the ${H.nick} host the ${A.nick}. ${P.first} ${P.last} with ${C.first} ${C.last}.` }]
      : [
          { speaker: 'pxp', text: `${evening ? 'Good evening' : 'Good afternoon'}, everybody, and welcome to ${where}, where the ${H.nick} host the ${A.city} ${A.nick}${date ? ' ' + date : ''}. ${P.first} ${P.last} here, ${pick(r, ['alongside', 'with', 'next to'])} ${C.first} ${C.last}.` },
        ],
  });
  if (!short) add({ id: 'hello', pri: 3, turns: [{ speaker: 'color', text: pick(r, [`${C.nickname} to everybody but my mother, ${P.first}. Good to be here.`, `Good to be here, ${P.first}. And it's ${C.nickname}, folks. Nobody calls me ${C.first}.`, `${P.first}, good to see you. Hello, everybody.`]) }] });
  r = R('field');
  add({
    id: 'field',
    pri: 6,
    turns: [
      { speaker: 'pxp', text: say([`The anthem is done, and here come the ${H.nick}${H.colors ? `, in ${H.colors},` : ''} to take the field.`, `The ${H.nick} are running out to their positions${H.colors ? `, in ${H.colors}` : ''}, and the crowd is on its feet.`], {}, r) },
    ],
  });
  r = R('weather');
  const tempW = `${wx.tempF} degrees`;
  add({
    id: 'weather',
    pri: 4,
    turns: [
      { speaker: 'pxp', text: say([`It is ${tempW} at first pitch, ${wx.sky}, and ${wx.breeze}.`, `${cap(wx.sky)}, ${tempW}, ${wx.breeze}. First pitch at ${clockWords(wx.firstPitch.h, wx.firstPitch.m)}.`], {}, r) },
      {
        speaker: 'color',
        text: wx.realWind
          ? say(['Keep an eye on that wind, it will matter on fly balls.', 'That wind is going to have a say tonight.'], {}, r)
          : wx.tempF >= 85
            ? say([`Hot one. Catchers lose about five pounds on a day like this, ${P.first}. I never did, but that is what they tell me.`, 'Hot. Somebody bring the catchers a towel.'], {}, r)
            : wx.tempF <= 60
              ? say(['A little chilly. The bats sting on a night like this, ask anybody who ever hit off the end of one.', 'Cool one. Hitters hate it, pitchers do not mind a bit.'], {}, r)
              : say(['Perfect weather for baseball.', `You could not order it up any better, ${P.first}.`, 'Nice night for it.'], {}, r),
      },
    ],
  });
  r = R('records');
  const ra = recordLine(A, r);
  const rh = recordLine(H, r);
  if (ra || rh) {
    const better = A.record && H.record ? (A.record.w - A.record.l) - (H.record.w - H.record.l) : 0;
    add({
      id: 'records',
      pri: 2,
      turns: [
        { speaker: 'pxp', text: [ra, rh].filter(Boolean).join(' ') },
        {
          speaker: 'color',
          text: Math.abs(better) <= 3 ? say(['Two clubs right on top of each other, so this one matters.', 'Not much between these two clubs.'], {}, r) : say([`The ${better > 0 ? A.nick : H.nick} have the better record, but that does not hit or pitch tonight.`, 'Records are nice. Tonight starts at zero to zero.'], {}, r),
        },
      ],
    });
  }
  // the starters: the home man pitches the top of the first
  for (const [side, club, pri] of [['home', H, 1], ['away', A, 4]] as const) {
    const sp = club.starter;
    if (!sp) continue;
    r = R(`starter.${side}`);
    const n = pitcherNote(sp, r);
    const first = side === 'home' ? `On the mound for the ${club.nick}, ${sp.name}${sp.age ? `, the ${sp.age}-year-old ${hand(sp.throws)}` : `, a ${hand(sp.throws)}`}.` : `For the ${club.nick}, ${sp.name} gets the start, a ${hand(sp.throws)}.`;
    add({
      id: `starter.${side}`,
      pri,
      turns: [
        { speaker: 'pxp', text: first },
        { speaker: 'color', text: [n.fastball ? `${cap(n.fastball)}.` : null, n.best ? `${cap(n.best)}.` : `The mix: ${n.mix}.`, n.command].filter(Boolean).join(' ') || null },
      ],
    });
  }
  // the lineups
  for (const [side, club, pri] of [['away', A, 5], ['home', H, 8]] as const) {
    const l = lineupNotes(club);
    if (!l.leadoff) continue;
    r = R(`lineup.${side}`);
    add({
      id: `lineup.${side}`,
      pri,
      turns: [
        { speaker: 'pxp', text: `For the ${club.nick}, ${l.leadoff}${l.cleanup ? `, and ${l.cleanup}` : ''}.` },
        { speaker: 'color', text: l.best ? `${cap(l.best)}. ${say(['That is the one I would pitch around.', 'I would not give him much to hit.'], {}, r)}` : club.lineup[0]?.speed >= 60 ? say([`If ${club.lineup[0].last} gets on, watch him on the bases.`, `${club.lineup[0].last} on first base is a problem for any pitcher.`], {}, r) : null },
      ],
    });
  }
  // the umpires and the managers
  const plate = f.umpires?.find((u) => u.key === 'plate');
  const chief = f.umpires?.find((u) => u.chief);
  if (plate) {
    r = R('umpires');
    add({
      id: 'umpires',
      pri: 7,
      turns: [
        { speaker: 'pxp', text: chief && chief !== plate ? `${plate.name} is behind the plate tonight, and the crew chief, ${chief.name}, has ${chief.key === 'second' ? 'second base' : chief.key === 'first' ? 'first base' : 'third base'}.` : `${plate.name} has the plate tonight${plate.chief ? ', and he is the crew chief' : ''}.` },
        { speaker: 'color', text: say([`${plate.years} years in the big leagues for ${plate.name.split(' ')[1]}. I will be watching the corners the first time through.`, `Every umpire has his own zone, ${P.first}. We will learn this one fast.`, `I spent eleven years arguing with umpires, and I won about twice.`], {}, r) },
      ],
    });
  }
  if (H.manager && A.manager) {
    r = R('managers');
    const bg = (m: NonNullable<ClubFacts['manager']>) => (m.background === 'coach' ? 'a longtime coach' : `a former ${m.background}`);
    add({
      id: 'managers',
      pri: 9,
      turns: [
        { speaker: 'pxp', text: `${H.manager.name}, ${bg(H.manager)}, is in his ${ORD[H.manager.season] ?? 'umpteenth'} season managing the ${H.nick}; ${A.manager.name}, ${bg(A.manager)}, ${A.manager.season === 1 ? 'is in his first year with' : `is in year ${nw(A.manager.season)} with`} the ${A.nick}.` },
        { speaker: 'color', text: H.manager.background === 'catcher' || A.manager.background === 'catcher' ? say([`A catcher in the manager's chair. Smart man, ${P.first}. We see the whole field.`, 'Former catcher. Best seat in the house for learning the game.'], {}, r) : H.manager.background === 'pitcher' ? say([`A pitcher managing, so he will be talking to ${H.manager.pitchingCoach} every inning.`], {}, r) : null },
      ],
    });
  }
  if (venue) {
    r = R('park');
    add({
      id: 'park',
      pri: 10,
      turns: [
        { speaker: 'pxp', text: say([`${venue.name} opened in ${venue.opened}, about ${Math.round(venue.capacity / 1000)} thousand seats, and my favourite thing here is ${venue.feature}.`, `If you have never been to ${venue.short}, look for ${venue.feature}. One of my favourite spots in the league.`], {}, r) },
        { speaker: 'color', text: `${venue.lf} down the lines, ${venue.cf} to center. ${say(['A fair park. I never hit one out of here, but I blame the park anyway.', 'Fair for hitters, fair for pitchers.'], {}, r)}` },
      ],
    });
  }
  if (f.mascot) {
    r = R('mascot');
    add({ id: 'crowd', pri: 11, turns: [{ speaker: 'pxp', text: say([`${f.mascot} is already up on the dugout roof getting the crowd going.`, `A good crowd here, and ${f.mascot} is working the first-base side.`], {}, r) }, { speaker: 'color', text: say(['Best athlete in the building.', 'Better footwork than half the infielders I played with.'], {}, r) }] });
  }
  r = R('pa');
  add({ id: 'pa', pri: 12, turns: [{ speaker: 'color', text: say([`And ${CAST.pa.name} on the public address, the best voice in the ballpark, ${P.first}. Present company included.`, `Love hearing ${CAST.pa.first} ${CAST.pa.last} on the PA. That voice was made for this.`], {}, r) }, { speaker: 'pxp', text: say(['No argument from me.', 'I will take that personally.'], {}, r) }] });

  // fit: essential blocks, then by importance while the estimate fits (15 % margin)
  const pause = 0.45;
  const est = (b: Block) => b.turns.reduce((a, t) => a + (t.text ? dur(t.text) + pause : 0), 0);
  const low = o.level === 'low';
  const chosen = new Map<Block, number>(); // block -> how many of its turns
  let used = 0;
  const fits = (e: number) => (used + e) * 1.03 <= o.budget;
  for (const b of [...blocks].sort((a, b) => a.pri - b.pri)) {
    const e = est(b);
    if (b.essential || ((!low || b.pri <= 1) && fits(e))) {
      chosen.set(b, b.turns.length);
      used += e;
    }
  }
  // fill what is left with the opening line of blocks that did not fit whole (each stands on its own)
  if (!low)
    for (const b of [...blocks].sort((a, b) => a.pri - b.pri)) {
      if (chosen.has(b) || !b.turns[0]?.text) continue;
      const e = dur(b.turns[0].text) + pause;
      if (fits(e)) {
        chosen.set(b, 1);
        used += e;
      }
    }
  const turns: SegmentTurn[] = [];
  for (const b of blocks) {
    const n = chosen.get(b);
    if (!n) continue;
    for (const t of b.turns.slice(0, n)) if (t.text) turns.push({ speaker: t.speaker, text: t.text, block: b.id, optional: !b.essential, excited: t.excited });
  }
  // what did not make it waits at the end, most important first: the director says it only if the voices ran faster than estimated and it still fits
  if (!low)
    for (const b of [...blocks].sort((a, b) => a.pri - b.pri)) {
      const n = chosen.get(b) ?? 0;
      if (n === 0) for (const t of b.turns) if (t.text) turns.push({ speaker: t.speaker, text: t.text, block: `${b.id}+`, optional: true, excited: t.excited });
    }
  return { tag: 'open', turns };
}

/** The handoff when the umpire calls play ball: the leadoff man, the pitcher, and the short tag for the top of the first. */
export function handoffLine(f: Pick<OpeningFacts, 'seed' | 'away' | 'home'>, batter?: string, pitcher?: string): string {
  const r = rngFor(f.seed, 'handoff');
  const b = batter ?? f.away.lineup[0]?.last;
  const p = pitcher ?? f.home.starter?.last;
  const face = b && p ? say([`${b} steps in against ${p}`, `${b} to lead off against ${p}`, `${p} to face ${b}`], {}, r) : null;
  return `${say(['And there is the call to play ball.', 'Play ball, says the umpire.', 'And we have the call: play ball.'], {}, r)} ${face ? `${cap(face)}, and it's the top of the first.` : "And it's the top of the first."}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pick = <T,>(r: () => number, a: T[]): T => a[Math.floor(r() * a.length)];

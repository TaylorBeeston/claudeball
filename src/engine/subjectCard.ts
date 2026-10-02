/**
 * Which lower-third card goes with a B-roll shot, and what is on it (pure, no DOM; unit-tested). The camera director cuts to shots about a
 * person (the on-deck batter, a pitcher's face, the catcher's signs, the manager walking out, a reliever warming up ...); the HUD shows a card in the style
 * of the name card while the shot is held. The data comes from the live `GameState`: the subject's snapshot (name, number, hand, 20-80 ratings)
 * and the box-score stats of the game (`stats`), plus the batter / pitcher records for the pitch arsenal.
 */
import { arsenalText, batLine, batterBars, gradeColor, pitLine, pitcherBars, rate, type RatingBar } from './hudStats';
import type { GameState, PersonInfo, PlayerSnap, StatsEntry, TeamInfo } from './types';

export interface SubjectCard {
  /** the shot's kind (for tests / styling) */
  kind: string;
  /** small gold label: ON DECK, NOW WARMING ... */
  role: string;
  number: string;
  name: string;
  /** "BATS LEFT · CF · .291 AVG 24 HR" */
  detail: string;
  /** "TODAY  1-3  1 RBI" */
  today: string;
  /** 20-80 mini bars (power / contact / speed / eye, or velocity / control / movement / stamina) */
  bars: RatingBar[];
  /** pitchers: the pitch mix */
  arsenal: string;
  /** the team colour of the number box */
  color: string;
}

export interface ShotInfo {
  kind: string;
  subject?: string;
}

const POSITION: Record<string, string> = { pitcher: 'P', catcher: 'C', first: '1B', second: '2B', third: '3B', short: 'SS', left: 'LF', center: 'CF', right: 'RF', batter: '', runner: '', ondeck: '', bench: '', manager: 'MGR', coach1b: '1B COACH', coach3b: '3B COACH' };

type Kind = 'bat' | 'pit' | 'plain';

interface Plan {
  role: string;
  kind: Kind;
  /** show the arsenal / bars (pitchers and batters), or just the person */
  full: boolean;
}

/** Shot kinds that get a card; the kinds are the director's `BrollKind`s (and the engine thread's `shot` event kinds: `ondeck`, `walkup`, `faceCloseup`, `dugout` map onto them). */
const PLANS: Record<string, (p: PlayerSnap) => Plan> = {
  onDeck: () => ({ role: 'ON DECK', kind: 'bat', full: true }),
  ondeck: () => ({ role: 'ON DECK', kind: 'bat', full: true }),
  walkup: () => ({ role: 'WALKING UP', kind: 'bat', full: true }),
  batterFace: () => ({ role: 'AT BAT', kind: 'bat', full: true }),
  faceCloseup: (p) => (p.role === 'pitcher' ? { role: 'PITCHING', kind: 'pit', full: true } : { role: 'AT BAT', kind: 'bat', full: true }),
  pitcherFace: () => ({ role: 'PITCHING', kind: 'pit', full: true }),
  shakeOff: () => ({ role: 'PITCHING', kind: 'pit', full: true }),
  catcherSigns: () => ({ role: 'CATCHER', kind: 'bat', full: false }),
  leadOff: () => ({ role: 'ON THE BASES', kind: 'bat', full: false }),
  managerWalk: () => ({ role: 'MANAGER', kind: 'plain', full: false }),
  coachSigns: () => ({ role: 'COACH', kind: 'plain', full: false }),
  bullpen: () => ({ role: 'NOW WARMING', kind: 'pit', full: true }),
  relieverJog: () => ({ role: 'COMING IN', kind: 'pit', full: true }),
  relieverFace: () => ({ role: 'RELIEVER', kind: 'pit', full: true }),
};

/** The team colour for a number box: the jersey colour, or the trim when the jersey is the off-white one. */
export function teamColor(t: TeamInfo | undefined): string {
  if (!t) return '#333';
  return t.color === '#f4f4f0' ? t.trim : t.color;
}

function entryFor(s: GameState, id: string): StatsEntry | undefined {
  for (const side of ['away', 'home'] as const) {
    const t = s.stats?.[side];
    const e = t?.batters.find((x) => x.playerId === id) ?? t?.pitchers.find((x) => x.playerId === id);
    if (e) return e;
  }
  return undefined;
}

/** The card for a shot, or null when the shot is not about a person we can describe (crowd, sky, dugout, ...). */
export function cardFor(shot: ShotInfo | null | undefined, s: GameState | null | undefined): SubjectCard | null {
  if (!shot || !s) return null;
  const plan = PLANS[shot.kind];
  if (!plan || !shot.subject) return null;
  const snap = s.players.find((p) => p.id === shot.subject);
  const sideInfo = s.side?.onDeck && s.side.onDeck.id === shot.subject ? s.side.onDeck : null;
  if (!snap && !sideInfo) return null;
  const who = snap ?? ({ id: sideInfo!.id, name: sideInfo!.name, number: sideInfo!.number, hand: sideInfo!.hand, team: s.side!.battingSide, role: 'ondeck' } as PlayerSnap);
  if (!who.name) return null;
  const p = plan(who);
  const entry = entryFor(s, who.id);
  // the batter / pitcher records carry ratings and the arsenal even when the snapshot does not
  const rec: PersonInfo | null = s.batter?.id === who.id ? s.batter : s.pitcher?.id === who.id ? s.pitcher : null;
  const ratings = who.ratings ?? rec?.ratings;
  const pos = entry?.position || POSITION[who.role] || '';
  const hand = who.hand ?? rec?.hand;
  const detail: string[] = [];
  if (p.kind === 'pit') detail.push(hand ? `THROWS ${hand === 'L' ? 'LEFT' : 'RIGHT'}` : '');
  else if (p.kind === 'bat') detail.push(hand ? `BATS ${hand === 'L' ? 'LEFT' : 'RIGHT'}` : '');
  else detail.push(hand ? (hand === 'L' ? 'LEFT-HANDED' : 'RIGHT-HANDED') : '');
  if (pos && p.kind !== 'plain') detail.push(pos);
  // season line when the sim has one: batting average and homers, or ERA
  if (entry && p.kind === 'bat' && entry.season.batting.ab > 0) detail.push(`${rate(entry.season.batting.avg)} AVG  ${entry.season.batting.hr} HR`);
  if (entry && p.kind === 'pit' && entry.season.pitching && Number.isFinite(entry.season.pitching.era)) detail.push(`${entry.season.pitching.era.toFixed(2)} ERA`);
  else if (rec?.stats) detail.push(rec.stats.trim());
  const today = p.kind === 'bat' ? batLine(entry?.game.batting) : p.kind === 'pit' ? pitLine(entry?.game.pitching) : '';
  const bars = !p.full ? [] : p.kind === 'pit' ? pitcherBars(ratings) : batterBars(ratings);
  const side = who.team === 0 ? 'away' : who.team === 1 ? 'home' : null;
  return {
    kind: shot.kind,
    role: p.role,
    number: who.number !== undefined ? String(who.number) : '',
    name: who.name,
    detail: detail.filter(Boolean).join('  ·  '),
    today: today && p.kind !== 'plain' ? today : '',
    bars,
    arsenal: p.full && p.kind === 'pit' ? arsenalText(rec?.arsenal) : '',
    color: side ? teamColor(s.teams[side]) : '#333',
  };
}

export { gradeColor };

import { Rng } from './rng';
import { clamp } from './math';
import type { FieldPosition, Handed, PitchSpec, PitchType, PlayerInfo, Ratings, Team, TeamSide, Traits } from './types';

const FIRST = ['Aaron', 'Adrian', 'Alex', 'Andre', 'Andrew', 'Anthony', 'Ben', 'Blake', 'Brandon', 'Brett', 'Bryce', 'Caleb', 'Carlos', 'Chase', 'Chris', 'Cody', 'Colby', 'Cole', 'Connor', 'Dalton', 'Dan', 'Darius', 'David', 'Derek', 'Diego', 'Dominic', 'Dustin', 'Elijah', 'Eric', 'Ethan', 'Evan', 'Felix', 'Frankie', 'Gabe', 'Garrett', 'Gavin', 'George', 'Grant', 'Gus', 'Hank', 'Hunter', 'Ian', 'Isaac', 'Jack', 'Jake', 'Jamal', 'Jared', 'Jason', 'Javier', 'Jay', 'Jesse', 'Joey', 'Jon', 'Jorge', 'Josh', 'Juan', 'Justin', 'Kaleb', 'Kenny', 'Kevin', 'Kyle', 'Lance', 'Leo', 'Logan', 'Luis', 'Luke', 'Marcus', 'Mario', 'Mason', 'Matt', 'Miguel', 'Mike', 'Nate', 'Nick', 'Noah', 'Omar', 'Oscar', 'Pablo', 'Patrick', 'Pete', 'Quinn', 'Rafael', 'Ray', 'Reid', 'Ricky', 'Riley', 'Rob', 'Roman', 'Ryan', 'Sam', 'Santiago', 'Seth', 'Shane', 'Sean', 'Spencer', 'Tanner', 'Theo', 'Tim', 'Todd', 'Tomas', 'Travis', 'Trent', 'Tyler', 'Victor', 'Vince', 'Wade', 'Will', 'Xavier', 'Zach'];
const LAST = ['Abbott', 'Alvarez', 'Anderson', 'Baker', 'Barnes', 'Bell', 'Bennett', 'Blanco', 'Brooks', 'Brown', 'Burke', 'Butler', 'Cabrera', 'Campbell', 'Carter', 'Castillo', 'Chavez', 'Clark', 'Coleman', 'Cruz', 'Daniels', 'Davis', 'Delgado', 'Diaz', 'Dixon', 'Douglas', 'Edwards', 'Ellis', 'Evans', 'Fernandez', 'Fisher', 'Flores', 'Foster', 'Fuentes', 'Garcia', 'Gibson', 'Gomez', 'Gonzalez', 'Graham', 'Grant', 'Gray', 'Green', 'Griffin', 'Guerrero', 'Hall', 'Hamilton', 'Harris', 'Hayes', 'Henderson', 'Hernandez', 'Hill', 'Howard', 'Hughes', 'Jackson', 'James', 'Jenkins', 'Johnson', 'Jones', 'Kelly', 'Kim', 'King', 'Lee', 'Lewis', 'Lopez', 'Marshall', 'Martin', 'Martinez', 'Mason', 'Miller', 'Mitchell', 'Moore', 'Morales', 'Morgan', 'Murphy', 'Myers', 'Nelson', 'Nguyen', 'Ortiz', 'Owens', 'Parker', 'Patel', 'Perez', 'Peterson', 'Powell', 'Price', 'Ramirez', 'Reed', 'Reyes', 'Reynolds', 'Rivera', 'Roberts', 'Robinson', 'Rodriguez', 'Rogers', 'Ross', 'Ruiz', 'Sanchez', 'Sanders', 'Santos', 'Scott', 'Silva', 'Simmons', 'Smith', 'Stewart', 'Sullivan', 'Taylor', 'Thomas', 'Thompson', 'Torres', 'Turner', 'Vargas', 'Walker', 'Ward', 'Washington', 'Watson', 'White', 'Williams', 'Wilson', 'Wood', 'Wright', 'Young'];
const CITIES: [string, string][] = [
  ['Portland', 'POR'], ['Austin', 'AUS'], ['Denver', 'DEN'], ['Memphis', 'MEM'], ['Omaha', 'OMA'], ['Tampa', 'TAM'],
  ['Boise', 'BOI'], ['Raleigh', 'RAL'], ['Sacramento', 'SAC'], ['Richmond', 'RIC'], ['Tucson', 'TUC'], ['Albany', 'ALB'],
  ['Savannah', 'SAV'], ['Duluth', 'DUL'], ['Reno', 'REN'], ['Toledo', 'TOL'], ['Fresno', 'FRE'], ['Mobile', 'MOB'],
  ['Spokane', 'SPO'], ['Madison', 'MAD'], ['Tulsa', 'TUL'], ['Norfolk', 'NOR'], ['Lincoln', 'LIN'], ['Wichita', 'WIC'],
  ['Buffalo', 'BUF'], ['Charleston', 'CHA'], ['Dayton', 'DAY'], ['Eugene', 'EUG'], ['Provo', 'PRO'], ['Salem', 'SAL'],
];
const MASCOTS = ['Comets', 'Herons', 'Foxes', 'Ironmen', 'Otters', 'Stallions', 'Rangers', 'Falcons', 'Hammers', 'Owls', 'Wolves', 'Miners', 'Barons', 'Captains', 'Pioneers', 'Sharks', 'Bison', 'Thunder', 'Cyclones', 'Lynx', 'Mariners', 'Giants', 'Kings', 'Rockets', 'Bears', 'Chargers', 'Skippers', 'Voyagers', 'Sea Dogs', 'Storm'];

export const PITCH_TEMPLATES: Record<PitchType, { dv: number; rpm: number; eff: number; dir: number }> = {
  // dv: mph below the pitcher's fastball; dir: Magnus force direction (deg), mirrored for right-handers.
  FF: { dv: 0, rpm: 2250, eff: 0.9, dir: -18 },
  SI: { dv: 1.5, rpm: 2100, eff: 0.85, dir: -62 },
  FC: { dv: 3.5, rpm: 2350, eff: 0.55, dir: 48 },
  SL: { dv: 8.5, rpm: 2450, eff: 0.4, dir: 112 },
  SW: { dv: 11, rpm: 2500, eff: 0.35, dir: 100 },
  CU: { dv: 14, rpm: 2550, eff: 0.72, dir: 158 },
  CH: { dv: 9, rpm: 1700, eff: 0.85, dir: 228 },
  FS: { dv: 8, rpm: 1450, eff: 0.5, dir: 200 },
};

export function makePitchSpec(type: PitchType, fbMph: number, movement: number, throwsLeft: boolean, rng: Rng, usage: number): PitchSpec {
  const t = PITCH_TEMPLATES[type];
  const q = (movement - 50) / 50; // -0.6..+0.8
  const rpm = t.rpm * (1 + 0.1 * q + rng.normal(0, 0.03));
  const eff = clamp(t.eff + 0.05 * q + rng.normal(0, 0.03), 0.15, 0.98);
  let dir = t.dir + rng.normal(0, 6);
  if (!throwsLeft) dir = -dir; // templates are written for a left-hander in the +X=3B frame; mirror for righties
  dir = ((dir % 360) + 360) % 360;
  return { type, mph: fbMph - t.dv + rng.normal(0, 0.6), rpm, efficiency: eff, breakDirDeg: dir, usage };
}

const rate = (rng: Rng, mean: number, sd: number, lo = 20, hi = 95) => clamp(rng.normal(mean, sd), lo, hi);

interface Slot {
  pos: FieldPosition;
  // per-position tilts: [range, arm, glove, power, contact]
  tilt: { range: number; arm: number; glove: number; power: number; contact: number; speed: number };
}
const SLOTS: Slot[] = [
  { pos: 'C', tilt: { range: -8, arm: 4, glove: 0, power: -2, contact: -2, speed: -12 } },
  { pos: '1B', tilt: { range: -10, arm: -8, glove: -6, power: 8, contact: 2, speed: -8 } },
  { pos: '2B', tilt: { range: 4, arm: -2, glove: 4, power: -4, contact: 2, speed: 2 } },
  { pos: '3B', tilt: { range: 0, arm: 6, glove: 2, power: 3, contact: 0, speed: -3 } },
  { pos: 'SS', tilt: { range: 8, arm: 6, glove: 6, power: -5, contact: 0, speed: 3 } },
  { pos: 'LF', tilt: { range: 0, arm: -3, glove: -2, power: 4, contact: 0, speed: 0 } },
  { pos: 'CF', tilt: { range: 10, arm: 2, glove: 2, power: -2, contact: 0, speed: 8 } },
  { pos: 'RF', tilt: { range: 2, arm: 8, glove: 0, power: 4, contact: 0, speed: 0 } },
  { pos: 'DH', tilt: { range: -14, arm: -14, glove: -14, power: 10, contact: 3, speed: -6 } },
];

function makeName(rng: Rng, used: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    const n = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    if (!used.has(n)) {
      used.add(n);
      return n;
    }
  }
  return `${rng.pick(FIRST)} ${rng.pick(LAST)} Jr.`;
}

function makeTraits(rng: Rng, throwsLeft: boolean, power: number): Traits {
  const slotType = rng.next();
  // 3/4 over-the-top / three-quarter, some sidearm
  const armHeight = slotType < 0.62 ? rng.normal(1.83, 0.07) : slotType < 0.94 ? rng.normal(1.6, 0.07) : rng.normal(1.28, 0.08);
  const side = (throwsLeft ? -1 : 1) * (0.25 + (1.83 - armHeight) * 0.9 + rng.normal(0, 0.08));
  return {
    attackAngleDeg: rng.normal(8 + (power - 50) * 0.05, 3.5),
    aimBelow: rng.normal(0.004, 0.006),
    aggression: clamp(rng.normal(0, 0.45), -1, 1),
    armHeight,
    armSide: side,
    extension: clamp(rng.normal(1.85, 0.12), 1.5, 2.2),
  };
}

function makeHitter(id: string, side: TeamSide, jersey: number, pos: FieldPosition, tilt: Slot['tilt'], quality: number, rng: Rng, used: Set<string>): PlayerInfo {
  const q = quality; // additive rating shift (regulars ~ +3, bench ~ -4)
  const talent = rng.normal(0, 1);
  const ratings: Ratings = {
    contact: rate(rng, 50 + q + tilt.contact + 3 * talent, 9),
    power: rate(rng, 50 + q + tilt.power + 3 * talent, 11),
    eye: rate(rng, 50 + q + 2 * talent, 10),
    discipline: rate(rng, 50 + q + 2 * talent, 11),
    speed: rate(rng, 50 + tilt.speed, 12),
    baserunning: rate(rng, 50 + q * 0.5, 11),
    glove: rate(rng, 50 + q * 0.5 + tilt.glove, 9),
    range: rate(rng, 50 + q * 0.5 + tilt.range, 9),
    arm: rate(rng, 50 + tilt.arm, 10),
    accuracy: rate(rng, 50 + q * 0.3 + tilt.arm * 0.4, 10),
    catching: pos === 'C' ? rate(rng, 55 + q * 0.5, 9) : 30,
    velocity: 75,
    control: 30,
    movement: 30,
    stamina: 20,
  };
  const r = rng.next();
  const bats: Handed = r < 0.56 ? 'R' : r < 0.86 ? 'L' : 'S';
  const throwsL = rng.next() >= 0.88;
  return {
    id,
    name: makeName(rng, used),
    team: side,
    jersey,
    bats,
    throws: throwsL ? 'L' : 'R',
    primaryPosition: pos,
    height: clamp(rng.normal(1.86, 0.06), 1.68, 2.05),
    ratings,
    arsenal: [],
    isPitcher: false,
    traits: makeTraits(rng, throwsL, ratings.power),
  };
}

function makePitcher(id: string, side: TeamSide, jersey: number, role: 'SP' | 'RP' | 'CL', quality: number, rng: Rng, used: Set<string>): PlayerInfo {
  const q = quality;
  const left = rng.next() < 0.27;
  const fb = clamp(rng.normal(role === 'SP' ? 93.0 : role === 'CL' ? 96 : 94.2, 1.7) + q * 0.12, 86, 101);
  const movement = rate(rng, 50 + q, 10);
  const control = rate(rng, 50 + q + (role === 'RP' ? -1 : 0), 10);
  const stamina = role === 'SP' ? rate(rng, 66, 9, 45, 92) : rate(rng, 32, 8, 15, 55);
  const types: PitchType[] = [];
  types.push(rng.next() < 0.7 ? 'FF' : 'SI');
  if (types[0] === 'FF' && rng.next() < 0.3) types.push('SI');
  if (types[0] === 'SI' && rng.next() < 0.3) types.push('FF');
  const extras: PitchType[] = ['SL', 'CU', 'CH', 'FC', 'SW', 'FS'];
  const nExtra = role === 'SP' ? 3 : 2;
  const weights: Record<PitchType, number> = { SL: 1.6, CU: 1, CH: 1.2, FC: 0.7, SW: 0.45, FS: 0.3, FF: 0, SI: 0 };
  while (types.length < (role === 'SP' ? 2 + nExtra - (types.length > 1 ? 0 : 0) : 1 + nExtra) && extras.length) {
    const tot = extras.reduce((s, t) => s + weights[t], 0);
    let x = rng.next() * tot;
    let idx = 0;
    for (; idx < extras.length; idx++) {
      x -= weights[extras[idx]];
      if (x <= 0) break;
    }
    idx = Math.min(idx, extras.length - 1);
    types.push(extras[idx]);
    extras.splice(idx, 1);
  }
  const arsenal: PitchSpec[] = types.map((t, i) => {
    const usage = i === 0 ? 4.4 : t === 'SI' || t === 'FF' ? 1.8 : t === 'SL' || t === 'CH' || t === 'CU' ? 2.0 : 1.2;
    return makePitchSpec(t, fb, movement, left, rng, usage);
  });
  const ratings: Ratings = {
    contact: rate(rng, 22, 4, 15, 40),
    power: rate(rng, 22, 4, 15, 40),
    eye: rate(rng, 25, 5, 15, 40),
    discipline: rate(rng, 30, 8, 15, 55),
    speed: rate(rng, 38, 10, 20, 65),
    baserunning: rate(rng, 35, 8, 20, 60),
    glove: rate(rng, 50, 9),
    range: rate(rng, 42, 8),
    arm: rate(rng, 55, 8),
    accuracy: rate(rng, 52, 9),
    catching: 20,
    velocity: fb,
    control,
    movement,
    stamina,
  };
  return {
    id,
    name: makeName(rng, used),
    team: side,
    jersey,
    bats: left ? 'L' : rng.next() < 0.12 ? 'L' : 'R',
    throws: left ? 'L' : 'R',
    primaryPosition: 'P',
    height: clamp(rng.normal(1.91, 0.06), 1.75, 2.08),
    ratings,
    arsenal,
    isPitcher: true,
    traits: makeTraits(rng, left, 30),
  };
}

export interface TeamOptions {
  name?: string;
  abbrev?: string;
  side?: TeamSide;
  /** Rating shift for the whole team (default 0). */
  strength?: number;
}

/** Generate a full 26-man team with a lineup, rotation and bullpen. */
export function generateTeam(seed: number | string, opts: TeamOptions = {}): Team {
  const rng = new Rng(`team:${seed}`);
  const side: TeamSide = opts.side ?? 'home';
  const city = rng.pick(CITIES);
  const name = opts.name ?? `${city[0]} ${rng.pick(MASCOTS)}`;
  const abbrev = opts.abbrev ?? city[1];
  const id = `${abbrev}-${side}`;
  const used = new Set<string>();
  const strength = opts.strength ?? 0;
  const jerseys = new Set<number>();
  const jersey = () => {
    let j: number;
    do j = rng.int(1, 99);
    while (jerseys.has(j));
    jerseys.add(j);
    return j;
  };
  const roster: PlayerInfo[] = [];
  const starters: PlayerInfo[] = [];
  SLOTS.forEach((s, i) => {
    const p = makeHitter(`${id}-b${i + 1}`, side, jersey(), s.pos, s.tilt, 3 + strength, rng, used);
    starters.push(p);
    roster.push(p);
  });
  const benchSpecs: { pos: FieldPosition; tilt: Slot['tilt'] }[] = [
    { pos: 'C', tilt: SLOTS[0].tilt },
    { pos: 'SS', tilt: { ...SLOTS[4].tilt, power: -3 } },
    { pos: 'LF', tilt: { ...SLOTS[5].tilt, speed: 4 } },
    { pos: '1B', tilt: { ...SLOTS[1].tilt, power: 6 } },
  ];
  const bench: string[] = [];
  benchSpecs.forEach((b, i) => {
    const p = makeHitter(`${id}-bn${i + 1}`, side, jersey(), b.pos, b.tilt, -4 + strength, rng, used);
    bench.push(p.id);
    roster.push(p);
  });
  const rotation: PlayerInfo[] = [];
  for (let i = 0; i < 5; i++) {
    const p = makePitcher(`${id}-sp${i + 1}`, side, jersey(), 'SP', 2 + strength, rng, used);
    rotation.push(p);
    roster.push(p);
  }
  const bullpen: string[] = [];
  for (let i = 0; i < 8; i++) {
    const role = i === 0 ? 'CL' : 'RP';
    const p = makePitcher(`${id}-rp${i + 1}`, side, jersey(), role, i < 3 ? 2 + strength : -1 + strength, rng, used);
    bullpen.push(p.id);
    roster.push(p);
  }
  // batting order: leadoff high eye/speed, 2 contact, 3-4 best bats, 5-9 by overall
  const score = (p: PlayerInfo) => p.ratings.contact * 0.35 + p.ratings.power * 0.35 + p.ratings.eye * 0.2 + p.ratings.speed * 0.1;
  const pool = [...starters];
  const take = (fn: (p: PlayerInfo) => number) => {
    pool.sort((a, b) => fn(b) - fn(a));
    return pool.shift()!;
  };
  const order: PlayerInfo[] = [];
  order.push(take((p) => p.ratings.eye * 0.5 + p.ratings.speed * 0.3 + p.ratings.contact * 0.2));
  order.push(take((p) => p.ratings.contact * 0.6 + p.ratings.eye * 0.4));
  order.push(take(score));
  order.push(take((p) => p.ratings.power * 0.6 + score(p) * 0.4));
  pool.sort((a, b) => score(b) - score(a));
  while (pool.length) order.push(pool.shift()!);
  const lineup = order.map((p) => ({ playerId: p.id, position: SLOTS.find((s) => starters.indexOf(p) === SLOTS.indexOf(s))!.pos }));
  return {
    id,
    name,
    abbrev,
    roster,
    lineup,
    startingPitcherId: rotation[0].id,
    bullpen,
    bench,
  };
}

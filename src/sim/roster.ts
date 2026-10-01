import { Rng } from './rng';
import { clamp } from './math';
import { releaseGeometry, styleOf } from './attributes';
import type { Appearance, Build, Delivery, FieldPosition, Handed, PitchSpec, PitchType, PlayerInfo, Physique, Ratings, Team, TeamSide, Traits } from './types';

const FIRST = ['Aaron', 'Adrian', 'Alex', 'Andre', 'Andrew', 'Anthony', 'Ben', 'Blake', 'Brandon', 'Brett', 'Bryce', 'Caleb', 'Carlos', 'Chase', 'Chris', 'Cody', 'Colby', 'Cole', 'Connor', 'Dalton', 'Dan', 'Darius', 'David', 'Derek', 'Diego', 'Dominic', 'Dustin', 'Elijah', 'Eric', 'Ethan', 'Evan', 'Felix', 'Frankie', 'Gabe', 'Garrett', 'Gavin', 'George', 'Grant', 'Gus', 'Hank', 'Hunter', 'Ian', 'Isaac', 'Jack', 'Jake', 'Jamal', 'Jared', 'Jason', 'Javier', 'Jay', 'Jesse', 'Joey', 'Jon', 'Jorge', 'Josh', 'Juan', 'Justin', 'Kaleb', 'Kenny', 'Kevin', 'Kyle', 'Lance', 'Leo', 'Logan', 'Luis', 'Luke', 'Marcus', 'Mario', 'Mason', 'Matt', 'Miguel', 'Mike', 'Nate', 'Nick', 'Noah', 'Omar', 'Oscar', 'Pablo', 'Patrick', 'Pete', 'Quinn', 'Rafael', 'Ray', 'Reid', 'Ricky', 'Riley', 'Rob', 'Roman', 'Ryan', 'Sam', 'Santiago', 'Seth', 'Shane', 'Sean', 'Spencer', 'Tanner', 'Theo', 'Tim', 'Todd', 'Tomas', 'Travis', 'Trent', 'Tyler', 'Victor', 'Vince', 'Wade', 'Will', 'Xavier', 'Zach'];
const LAST = ['Abbott', 'Alvarez', 'Anderson', 'Baker', 'Barnes', 'Bell', 'Bennett', 'Blanco', 'Brooks', 'Brown', 'Burke', 'Butler', 'Cabrera', 'Campbell', 'Carter', 'Castillo', 'Chavez', 'Clark', 'Coleman', 'Cruz', 'Daniels', 'Davis', 'Delgado', 'Diaz', 'Dixon', 'Douglas', 'Edwards', 'Ellis', 'Evans', 'Fernandez', 'Fisher', 'Flores', 'Foster', 'Fuentes', 'Garcia', 'Gibson', 'Gomez', 'Gonzalez', 'Graham', 'Grant', 'Gray', 'Green', 'Griffin', 'Guerrero', 'Hall', 'Hamilton', 'Harris', 'Hayes', 'Henderson', 'Hernandez', 'Hill', 'Howard', 'Hughes', 'Jackson', 'James', 'Jenkins', 'Johnson', 'Jones', 'Kelly', 'Kim', 'King', 'Lee', 'Lewis', 'Lopez', 'Marshall', 'Martin', 'Martinez', 'Mason', 'Miller', 'Mitchell', 'Moore', 'Morales', 'Morgan', 'Murphy', 'Myers', 'Nelson', 'Nguyen', 'Ortiz', 'Owens', 'Parker', 'Patel', 'Perez', 'Peterson', 'Powell', 'Price', 'Ramirez', 'Reed', 'Reyes', 'Reynolds', 'Rivera', 'Roberts', 'Robinson', 'Rodriguez', 'Rogers', 'Ross', 'Ruiz', 'Sanchez', 'Sanders', 'Santos', 'Scott', 'Silva', 'Simmons', 'Smith', 'Stewart', 'Sullivan', 'Taylor', 'Thomas', 'Thompson', 'Torres', 'Turner', 'Vargas', 'Walker', 'Ward', 'Washington', 'Watson', 'White', 'Williams', 'Wilson', 'Wood', 'Wright', 'Young'];
export const CITIES: [string, string][] = [
  ['Portland', 'POR'], ['Austin', 'AUS'], ['Denver', 'DEN'], ['Memphis', 'MEM'], ['Omaha', 'OMA'], ['Tampa', 'TAM'],
  ['Boise', 'BOI'], ['Raleigh', 'RAL'], ['Sacramento', 'SAC'], ['Richmond', 'RIC'], ['Tucson', 'TUC'], ['Albany', 'ALB'],
  ['Savannah', 'SAV'], ['Duluth', 'DUL'], ['Reno', 'REN'], ['Toledo', 'TOL'], ['Fresno', 'FRE'], ['Mobile', 'MOB'],
  ['Spokane', 'SPO'], ['Madison', 'MAD'], ['Tulsa', 'TUL'], ['Norfolk', 'NOR'], ['Lincoln', 'LIN'], ['Wichita', 'WIC'],
  ['Buffalo', 'BUF'], ['Charleston', 'CHA'], ['Dayton', 'DAY'], ['Eugene', 'EUG'], ['Provo', 'PRO'], ['Salem', 'SAL'],
];
export const MASCOTS = ['Comets', 'Herons', 'Foxes', 'Ironmen', 'Otters', 'Stallions', 'Rangers', 'Falcons', 'Hammers', 'Owls', 'Wolves', 'Miners', 'Barons', 'Captains', 'Pioneers', 'Sharks', 'Bison', 'Thunder', 'Cyclones', 'Lynx', 'Mariners', 'Giants', 'Kings', 'Rockets', 'Bears', 'Chargers', 'Skippers', 'Voyagers', 'Sea Dogs', 'Storm'];

export const PITCH_TEMPLATES: Record<PitchType, { dv: number; rpm: number; eff: number; dir: number }> = {
  // dv: mph below the pitcher's fastball; dir: Magnus force direction (deg), mirrored for right-handers.
  FF: { dv: 0, rpm: 2250, eff: 0.9, dir: -18 },
  FT: { dv: 1.0, rpm: 2150, eff: 0.8, dir: -42 },
  SI: { dv: 1.5, rpm: 2100, eff: 0.85, dir: -62 },
  FC: { dv: 3.5, rpm: 2350, eff: 0.55, dir: 48 },
  SL: { dv: 8.5, rpm: 2450, eff: 0.4, dir: 112 },
  SW: { dv: 11, rpm: 2500, eff: 0.35, dir: 100 },
  CU: { dv: 14, rpm: 2550, eff: 0.72, dir: 158 },
  CH: { dv: 9, rpm: 1700, eff: 0.85, dir: 228 },
  FS: { dv: 8, rpm: 1450, eff: 0.5, dir: 200 },
};

/** Pitches that run arm-side (the slot drags their spin axis toward the arm side) and glove-side breakers. */
const ARM_SIDE: PitchType[] = ['FF', 'FT', 'SI', 'CH', 'FS'];
const GLOVE_SIDE: PitchType[] = ['SL', 'SW', 'CU', 'FC'];

/**
 * One pitch of a repertoire. `grade` (20-80) is the pitch's movement / spin quality, `command` its locatability. The arm slot
 * tilts the spin axis (a sidearmer's fastball runs and his slider sweeps).
 */
export function makePitchSpec(type: PitchType, fbMph: number, grade: number, throwsLeft: boolean, rng: Rng, usage: number, armSlotDeg = 45, command = 50): PitchSpec {
  const t = PITCH_TEMPLATES[type];
  const q = (grade - 50) / 50; // -0.6..+0.6
  const rpm = t.rpm * (1 + 0.1 * q + rng.normal(0, 0.03));
  const eff = clamp(t.eff + 0.05 * q + rng.normal(0, 0.03), 0.15, 0.98);
  let dir = t.dir + rng.normal(0, 6);
  const tilt = (armSlotDeg - 45) * 0.35; // deg of extra run (+) for a lower slot
  if (ARM_SIDE.includes(type)) dir -= tilt;
  else if (GLOVE_SIDE.includes(type)) dir += tilt;
  if (!throwsLeft) dir = -dir; // templates are written for a left-hander in the +X=3B frame; mirror for righties
  dir = ((dir % 360) + 360) % 360;
  return { type, mph: fbMph - t.dv + rng.normal(0, 0.6), rpm, efficiency: eff, breakDirDeg: dir, usage, grade, command };
}

const rate = (rng: Rng, mean: number, sd: number, lo = 20, hi = 80) => clamp(rng.normal(mean, sd), lo, hi);

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

/** Typical height (m) and body-mass index by position. */
const BODY: Record<string, { h: number; bmi: number }> = {
  C: { h: 1.84, bmi: 27.2 },
  '1B': { h: 1.92, bmi: 28.2 },
  '2B': { h: 1.8, bmi: 25.2 },
  '3B': { h: 1.86, bmi: 26.6 },
  SS: { h: 1.81, bmi: 24.9 },
  LF: { h: 1.86, bmi: 26.3 },
  CF: { h: 1.84, bmi: 25.1 },
  RF: { h: 1.88, bmi: 26.6 },
  DH: { h: 1.88, bmi: 28.0 },
  P: { h: 1.91, bmi: 26.3 },
};

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

function makePhysique(rng: Rng, pos: string, sizeZ: number): Physique {
  const b = BODY[pos] ?? BODY.P;
  const heightM = clamp(b.h + 0.055 * (0.55 * sizeZ + 0.85 * rng.normal(0, 1)), 1.70, 2.08);
  const bmi = clamp(b.bmi + 1.4 * sizeZ + rng.normal(0, 0.7), 23.2, 33);
  const weightKg = Math.round(bmi * heightM * heightM * 10) / 10;
  const build: Build = bmi < 24.2 ? 'lean' : bmi < 26.6 ? 'athletic' : bmi < 28.6 ? 'stocky' : 'heavy';
  return { heightM: Math.round(heightM * 1000) / 1000, weightKg, build };
}

function makeAppearance(rng: Rng): Appearance {
  const skinRoll = rng.next();
  const skin = skinRoll < 0.3 ? rng.int(0, 1) : skinRoll < 0.6 ? rng.int(2, 3) : rng.int(3, 5);
  const gray = rng.next() < 0.03;
  return { skin, hairColor: gray ? 5 : rng.pick([0, 0, 1, 1, 1, 2, 2, 3, 4]), hairStyle: rng.int(0, 3), facialHair: rng.pick([0, 0, 0, 1, 1, 2]), seed: Math.floor(rng.next() * 2147483647) };
}

function makeAge(rng: Rng, pitcher: boolean): number {
  return Math.round(clamp(rng.normal(pitcher ? 28.2 : 28.6, 3.8), 21, 40));
}

function makeTraits(rng: Rng, power: number, delivery: Delivery | null, heightM: number, throwsLeft: boolean): Traits {
  // hitters get a nominal three-quarter slot (unused); pitchers' release point follows their delivery
  const d = delivery ?? { style: 'three_quarter' as const, armSlotDeg: 45, tempo: 1 };
  const g = releaseGeometry(d, heightM, throwsLeft, clamp(rng.normal(1.85, 0.12), 1.5, 2.2));
  return {
    attackAngleDeg: rng.normal(8 + (power - 50) * 0.05, 3.5),
    aimBelow: rng.normal(0.004, 0.006),
    aggression: clamp(rng.normal(0, 0.45), -1, 1),
    armHeight: g.armHeight,
    armSide: g.armSide + rng.normal(0, 0.03),
    extension: g.extension,
  };
}

function makeDelivery(rng: Rng): Delivery {
  const r = rng.next();
  // arm slot in degrees from vertical: mostly three-quarter, a fair number over the top, a few sidearm, the odd submariner
  const slot = r < 0.22 ? rng.range(5, 24) : r < 0.84 ? rng.range(28, 62) : r < 0.97 ? rng.range(68, 96) : rng.range(102, 125);
  const tempoBase = slot > 65 ? 1.06 : 1;
  return { style: styleOf(slot), armSlotDeg: Math.round(slot * 10) / 10, tempo: Math.round(clamp(rng.normal(tempoBase, 0.08), 0.8, 1.25) * 100) / 100 };
}

function makeHitter(id: string, side: TeamSide, jersey: number, pos: FieldPosition, tilt: Slot['tilt'], quality: number, rng: Rng, used: Set<string>): PlayerInfo {
  const q = quality; // additive rating shift (regulars ~ +3, bench ~ -4)
  const talent = rng.normal(0, 1);
  const sizeZ = rng.normal(0, 1);
  const ath = rng.normal(0, 1);
  const age = makeAge(rng, false);
  const contactEps = rng.normal(0, 9);
  const contact = clamp(50 + q + tilt.contact + 3 * talent + contactEps, 20, 80);
  // power and contact trade off; big hitters have more of the former, slower runners
  const power = clamp(50 + q + tilt.power + 3 * talent + 3.5 * sizeZ - 0.6 * contactEps + rng.normal(0, 8.5), 20, 80);
  const eye = rate(rng, 50 + q + 2 * talent, 10);
  const speed = clamp(50 + tilt.speed - 3.8 * sizeZ + 3.5 * ath - 0.5 * (age - 28) + rng.normal(0, 9), 20, 80);
  const arm = rate(rng, 50 + tilt.arm + 1.5 * ath, 10);
  const posMean = pos === 'C' ? 55 + q * 0.5 : 30;
  const ratings: Ratings = {
    contact,
    power,
    eye,
    discipline: rate(rng, 50 + q + 2 * talent, 11),
    pull: rate(rng, 50 + 0.25 * (power - 50), 12),
    gap: rate(rng, 50 + 0.2 * (contact - 50), 11),
    breaking: rate(rng, 50 + 0.5 * (eye - 50), 9),
    consistency: rate(rng, 50 + 0.3 * (contact - 50), 10),
    clutch: rate(rng, 50, 10),
    durability: rate(rng, 50 - 0.6 * (age - 28), 10),
    speed,
    acceleration: rate(rng, 50 + 0.65 * (speed - 50) + 2 * ath, 7),
    baserunning: rate(rng, 50 + q * 0.5, 11),
    glove: rate(rng, 50 + q * 0.5 + tilt.glove, 9),
    range: rate(rng, 50 + q * 0.5 + tilt.range + 3 * ath, 8),
    arm,
    accuracy: rate(rng, 50 + q * 0.3 + tilt.arm * 0.4, 10),
    release: rate(rng, 50 + 0.3 * (arm - 50) + 0.3 * tilt.arm, 9),
    iq: rate(rng, 50 + 2 * talent, 10),
    catching: pos === 'C' ? rate(rng, 55 + q * 0.5, 9) : 30,
    framing: pos === 'C' ? rate(rng, posMean, 9) : 30,
    blocking: pos === 'C' ? rate(rng, posMean, 9) : 30,
    pop: pos === 'C' ? rate(rng, posMean + 0.2 * (arm - 50), 9) : 30,
    velocity: 75,
    control: 30,
    movement: 30,
    stamina: 20,
    composure: 30,
    holding: 30,
    pickoff: 30,
  };
  const r = rng.next();
  const bats: Handed = r < 0.56 ? 'R' : r < 0.86 ? 'L' : 'S';
  // throwing hand by position: almost nobody throws left-handed at C, 2B, SS or 3B
  const pLeft = pos === 'C' || pos === '2B' || pos === 'SS' || pos === '3B' ? 0 : pos === '1B' ? 0.25 : 0.2;
  const throwsL = rng.next() < pLeft;
  const physique = makePhysique(rng, pos, sizeZ);
  return {
    id,
    name: makeName(rng, used),
    team: side,
    jersey,
    bats,
    throws: throwsL ? 'L' : 'R',
    primaryPosition: pos,
    height: physique.heightM,
    age,
    physique,
    appearance: makeAppearance(rng),
    ratings,
    arsenal: [],
    isPitcher: false,
    traits: makeTraits(rng, ratings.power, null, physique.heightM, throwsL),
  };
}

function makePitcher(id: string, side: TeamSide, jersey: number, role: 'SP' | 'RP' | 'CL', quality: number, rng: Rng, used: Set<string>): PlayerInfo {
  const q = quality;
  const left = rng.next() < 0.27;
  const sizeZ = rng.normal(0, 1);
  const age = makeAge(rng, true);
  const delivery = makeDelivery(rng);
  const fb = clamp(rng.normal(role === 'SP' ? 93.0 : role === 'CL' ? 96 : 94.2, 1.7) + q * 0.12 + 0.5 * sizeZ - (delivery.armSlotDeg > 65 ? 2.3 : 0), 84, 101);
  const movement = rate(rng, 50 + q + (delivery.armSlotDeg > 65 ? 4 : 0), 10);
  const control = rate(rng, 50 + q + (role === 'RP' ? -1 : 0), 10);
  const stamina = role === 'SP' ? rate(rng, 66, 8, 48, 80) : rate(rng, 32, 8, 20, 55);
  const lowSlot = delivery.armSlotDeg > 65;
  // repertoire: a primary fastball (four-seam / two-seam / sinker) plus breaking and off-speed pitches; more pitches for starters
  const types: PitchType[] = [];
  const fbRoll = rng.next();
  if (lowSlot) types.push(fbRoll < 0.6 ? 'SI' : fbRoll < 0.9 ? 'FT' : 'FF');
  else types.push(fbRoll < 0.55 ? 'FF' : fbRoll < 0.72 ? 'FT' : fbRoll < 0.85 ? 'SI' : 'FC');
  const second = rng.next();
  if (role === 'SP' ? second < 0.55 : second < 0.25) {
    const alt: PitchType[] = ['FF', 'FT', 'SI'].filter((t) => t !== types[0]) as PitchType[];
    types.push(rng.pick(alt));
  }
  const extras: PitchType[] = ['SL', 'CU', 'CH', 'FC', 'SW', 'FS'].filter((t) => !types.includes(t as PitchType)) as PitchType[];
  const weights: Record<PitchType, number> = lowSlot
    ? { SL: 1.8, CU: 0.5, CH: 1.3, FC: 0.5, SW: 1.1, FS: 0.3, FF: 0, FT: 0, SI: 0 }
    : { SL: 1.6, CU: 1, CH: 1.2, FC: 0.7, SW: 0.45, FS: 0.35, FF: 0, FT: 0, SI: 0 };
  const target = role === 'SP' ? rng.int(4, 5) : rng.int(2, 4);
  while (types.length < target && extras.length) {
    const tot = extras.reduce((s2, t) => s2 + weights[t], 0);
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
  const FB = ['FF', 'FT', 'SI', 'FC'];
  const arsenal: PitchSpec[] = types.map((t, i) => {
    const usage = i === 0 ? 4.4 : FB.includes(t) && t !== 'FC' ? 1.8 : t === 'SL' || t === 'CH' || t === 'CU' ? 2.0 : 1.2;
    const grade = clamp(movement + rng.normal(0, 7), 20, 80);
    const command = clamp(control + rng.normal(i === 0 ? 4 : -2, 7), 20, 80);
    return makePitchSpec(t, fb, grade, left, rng, usage, delivery.armSlotDeg, command);
  });
  const ratings: Ratings = {
    contact: rate(rng, 22, 4, 20, 40),
    power: rate(rng, 22, 4, 20, 40),
    eye: rate(rng, 25, 5, 20, 40),
    discipline: rate(rng, 30, 8, 20, 55),
    pull: rate(rng, 50, 10),
    gap: rate(rng, 40, 10),
    breaking: rate(rng, 30, 8, 20, 55),
    consistency: 50,
    clutch: rate(rng, 50, 10),
    durability: rate(rng, 50 - 0.6 * (age - 28), 10),
    speed: rate(rng, 38, 10, 20, 65),
    acceleration: rate(rng, 38, 9, 20, 65),
    baserunning: rate(rng, 35, 8, 20, 60),
    glove: rate(rng, 50, 9),
    range: rate(rng, 42, 8),
    arm: rate(rng, 55, 8),
    accuracy: rate(rng, 52, 9),
    release: rate(rng, 52, 9),
    iq: rate(rng, 50, 10),
    catching: 20,
    framing: 20,
    blocking: 20,
    pop: 20,
    velocity: fb,
    control,
    movement,
    stamina,
    composure: rate(rng, 50, 10),
    holding: rate(rng, 50 + (left ? 6 : 0) + (delivery.tempo - 1) * 25, 10),
    pickoff: rate(rng, 50 + (left ? 9 : 0), 10),
  };
  // the consistency of a pitcher is release-point repeatability (independent of his stuff)
  ratings.consistency = rate(rng, 50, 10);
  const physique = makePhysique(rng, 'P', sizeZ);
  return {
    id,
    name: makeName(rng, used),
    team: side,
    jersey,
    bats: left ? 'L' : rng.next() < 0.12 ? 'L' : 'R',
    throws: left ? 'L' : 'R',
    primaryPosition: 'P',
    height: physique.heightM,
    age,
    physique,
    appearance: makeAppearance(rng),
    delivery,
    ratings,
    arsenal,
    isPitcher: true,
    traits: makeTraits(rng, 30, delivery, physique.heightM, left),
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
    rotation: rotation.map((p) => p.id),
    bullpen,
    bench,
  };
}

import { CHAINS, COUNTS, INNING_WORDS, LOCATIONS, OUTS, PITCHES, RUNNERS, SPRAY, type Pools } from './vocab';

/** Small deterministic PRNG (mulberry32 over an FNV hash of the seed string). */
export class Rand {
  private s: number;
  constructor(seed: string) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
    this.s = h >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.next() * a.length)];
  }
  shuffle<T>(a: readonly T[]): T[] {
    const r = [...a];
    for (let i = r.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [r[i], r[j]] = [r[j], r[i]];
    }
    return r;
  }
}

/** Values chosen so far in one instance, so related slots agree (the speed fits the pitch, hits <= at-bats, the leader leads). */
interface Ctx {
  v: Record<string, string>;
  pitchLo: number;
  pitchHi: number;
  lo: number;
  ab: number;
}

const ORD_CARD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];

type Gen = (r: Rand, p: Pools, c: Ctx) => string;

const team = (r: Rand, p: Pools) => `${r.pick(p.cities)} ${r.pick(p.mascots)}`;
const name = (r: Rand, p: Pools) => `${r.pick(p.first)} ${r.pick(p.last)}`;

const GENS: Record<string, Gen> = {
  first: (r, p) => r.pick(p.first),
  last: (r, p) => r.pick(p.last),
  name,
  name2: name,
  team,
  team2: team,
  city: (r, p) => r.pick(p.cities),
  mascot: (r, p) => r.pick(p.mascots),
  jersey: (r, p) => String(r.int(p.jerseyMin, p.jerseyMax)),
  pos: (r, p) => r.pick(p.positions),
  pitch: (r, _p, c) => {
    const x = r.pick(PITCHES);
    c.pitchLo = x.lo;
    c.pitchHi = x.hi;
    return x.name;
  },
  mph: (r, _p, c) => String(r.int(c.pitchLo, c.pitchHi)),
  loc: (r) => r.pick(LOCATIONS),
  count: (r) => r.pick(COUNTS),
  outs: (r) => r.pick(OUTS),
  runners: (r) => r.pick(RUNNERS),
  spray: (r) => r.pick(SPRAY),
  chain: (r) => r.pick(CHAINS),
  field: (r) => r.pick(['left field', 'center field', 'right field']),
  inn: (r) => String(r.int(2, 9)),
  /** "top of the third" etc. */
  inning: (r) => `${r.pick(['top', 'bottom'])} of the ${r.pick(INNING_WORDS.slice(0, 11))}`,
  /** "third" (1..9) */
  ord: (r) => ORD_CARD[r.int(1, 9)],
  /** winner's runs; the loser's (`lo`) is chosen here so `{lo}` after `{hi}` is consistent, and `{runs}` is their gap */
  hi: (r, _p, c) => {
    c.lo = r.int(0, 8);
    return String(c.lo + r.int(1, 6));
  },
  lo: (r, _p, c) => String(c.lo || r.int(0, 5)),
  runs: (r) => ['two', 'three', 'four'][r.int(0, 2)],
  ft: (r) => String(r.int(345, 468)),
  exit: (r) => String(r.int(96, 115)),
  angle: (r) => String(r.int(14, 38)),
  k: (r) => String(r.int(3, 14)),
  w: (r) => String(r.pick([0, 2, 3, 4])),
  np: (r) => String(r.int(48, 112)),
  st: (r, _p, c) => String(Math.max(30, Number(c.v.np ?? 90) - r.int(18, 38))),
  h: (r, _p, c) => {
    c.ab = r.int(2, 5);
    return String(r.int(0, c.ab));
  },
  ab: (r, _p, c) => String(c.ab || r.int(2, 5)),
  hr: (r) => String(r.int(2, 41)),
  rbi: (r) => String(r.int(10, 118)),
  avg: (r) => `.${r.int(180, 345)}`,
  era: (r) => `${r.int(1, 5)}.${String(r.int(5, 95)).padStart(2, '0')}`,
};

export const SLOT_NAMES = Object.keys(GENS);

/** Fill the `{slots}` of a template text. The same slot used twice gets the same value within one instance. */
export function fill(text: string, r: Rand, p: Pools): string {
  const c: Ctx = { v: {}, pitchLo: 88, pitchHi: 100, lo: 0, ab: 0 };
  const s = text.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const g = GENS[k];
    if (!g) throw new Error(`unknown slot {${k}}`);
    if (c.v[k] === undefined) c.v[k] = g(r, p, c);
    return c.v[k];
  });
  return capitalize(s);
}

/** Capitalise the first letter and the first letter after a sentence end ('...' keeps lower case: it is a pause, not a stop). */
export function capitalize(s: string): string {
  return s.replace(/^[a-z]/, (m) => m.toUpperCase()).replace(/(?<!\.)([.!?])(\s+)([a-z])/g, (_m, a: string, b: string, c: string) => `${a}${b}${c.toUpperCase()}`);
}

/**
 * Vocabulary the script draws from. The sim's name pools are not exported (and src/sim is not ours to edit), so they are parsed out of
 * the source text; a test fails if the parse comes back thin, which is what would happen if roster.ts changed shape.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function stringArray(src: string, name: string): string[] {
  const m = src.match(new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\];`));
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

export interface Pools {
  first: string[];
  last: string[];
  cities: string[];
  abbrevs: string[];
  mascots: string[];
  positions: string[];
  /** jersey numbers the roster generator hands out (inclusive) */
  jerseyMin: number;
  jerseyMax: number;
}

export function loadPools(): Pools {
  const roster = read('src/sim/roster.ts');
  const rules = read('src/sim/rules.ts');
  const cityBlock = roster.match(/const CITIES[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
  const pairs = [...cityBlock.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)];
  const posBlock = rules.match(/const POS_NAME[^=]*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';
  const positions = [...posBlock.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
  const j = roster.match(/rng\.int\((\d+),\s*(\d+)\)\s*;\s*while \(jerseys\.has/);
  return {
    first: stringArray(roster, 'FIRST'),
    last: stringArray(roster, 'LAST'),
    cities: pairs.map((p) => p[1]),
    abbrevs: pairs.map((p) => p[2]),
    mascots: stringArray(roster, 'MASCOTS'),
    positions,
    jerseyMin: j ? Number(j[1]) : 1,
    jerseyMax: j ? Number(j[2]) : 99,
  };
}

/** Pitch names as a broadcaster says them, with typical speeds relative to a ~94 mph fastball (see PITCH_TEMPLATES in roster.ts). */
export const PITCHES: { name: string; lo: number; hi: number }[] = [
  { name: 'fastball', lo: 90, hi: 101 },
  { name: 'four-seam fastball', lo: 91, hi: 100 },
  { name: 'two-seam fastball', lo: 90, hi: 98 },
  { name: 'sinker', lo: 89, hi: 97 },
  { name: 'cutter', lo: 86, hi: 94 },
  { name: 'slider', lo: 80, hi: 90 },
  { name: 'sweeper', lo: 77, hi: 86 },
  { name: 'curveball', lo: 73, hi: 84 },
  { name: 'changeup', lo: 80, hi: 89 },
  { name: 'splitter', lo: 82, hi: 90 },
];

export const LOCATIONS = [
  'low and away', 'high and inside', 'right down the middle', 'up in the zone', 'on the black', 'just off the plate', 'in the dirt', 'belt high',
  'painting the corner', 'down and in', 'up and away', 'at the knees', 'on the outside corner', 'on the inside corner', 'letter high', 'way outside',
  'under his hands', 'a little up', 'low', 'high', 'inside', 'outside', 'down the pipe', 'off the plate',
];

/** Every count the way an announcer says it (balls first). */
export const COUNTS = [
  'oh and oh', 'one and oh', 'two and oh', 'three and oh', 'oh and one', 'one and one', 'two and one', 'three and one',
  'oh and two', 'one and two', 'two and two', 'full count',
];

export const OUTS = ['nobody out', 'one out', 'two outs'];
export const RUNNERS = [
  'nobody on', 'a runner on first', 'a runner on second', 'a runner on third', 'runners on first and second', 'runners on first and third',
  'runners on second and third', 'the bases loaded',
];
export const SPRAY = ['down the left-field line', 'down the right-field line', 'to left field', 'to center field', 'to right field'];
export const INNING_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
export const HALF = ['top', 'bottom'];
export const CHAINS = ['6-3', '4-3', '5-3', '3-1', '1-3', '6-4-3', '4-6-3', '5-4-3', '3-6-1', '2-3', '6-3', '4-3', '5-3'];

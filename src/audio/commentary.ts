/**
 * Small baseball vocabulary helpers shared by the broadcast booth (`broadcast/`): pitch names, ordinals, where a pitch crossed the
 * plate in a hitter's terms, and how the bases are described. (The old template chatter that lived here was replaced by the broadcast
 * booth: director, lexicon, stories.)
 */
// ---- vocabulary --------------------------------------------------------------------------------------------------------

const PITCH_NAME: Record<string, string> = { FF: 'fastball', FT: 'two-seam fastball', SI: 'sinker', FC: 'cutter', SL: 'slider', CU: 'curveball', CH: 'changeup', SW: 'sweeper', FS: 'splitter' };
export const pitchName = (t: string) => PITCH_NAME[t] ?? 'pitch';
export const isFastball = (t: string) => t === 'FF' || t === 'FT' || t === 'SI' || t === 'FC';
export const isBreaking = (t: string) => t === 'SL' || t === 'CU' || t === 'SW';
export const isOffspeed = (t: string) => t === 'CH' || t === 'FS';

const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
export const ord = (n: number) => ORD[n] ?? `${n}th`;
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const num = (n: number) => NUM[n] ?? String(n);
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${num(n)} times`);

/** last name for casual mentions */
export const lastName = (full: string) => {
  const p = full.trim().split(/\s+/);
  return p.length > 1 ? p[p.length - 1] : full;
};

/**
 * Where a pitch crossed the plate, in a hitter's terms. The sim's +X is toward third base; a right-handed batter stands on +X
 * (so inside is +X for him) and a left-handed batter on -X. Heights are metres (zone ~0.5 .. 1.05).
 */
export function locationWords(x: number, y: number, bats: 'L' | 'R'): string {
  const side = (bats === 'R' ? x : -x) > 0 ? 'in' : 'away'; // toward the batter = inside
  const wide = Math.abs(x);
  const h = y < 0.15 ? 'dirt' : y < 0.55 ? 'low' : y > 0.98 ? 'up' : 'mid';
  if (h === 'dirt') return 'in the dirt';
  if (wide < 0.09 && h === 'mid') return 'right down the middle';
  if (wide < 0.09) return h === 'up' ? 'up in the zone' : 'down at the knees';
  if (h === 'mid') return side === 'in' ? 'inside' : 'away';
  return `${h} and ${side}`;
}

export function basesText(r: [boolean, boolean, boolean]): string {
  const n = r.filter(Boolean).length;
  if (n === 0) return 'nobody on';
  if (n === 3) return 'the bases loaded';
  if (n === 1) return r[0] ? 'a runner on first' : r[1] ? 'a runner on second' : 'a runner on third';
  if (r[0] && r[1]) return 'runners on first and second';
  if (r[0] && r[2]) return 'runners on the corners';
  return 'runners on second and third';
}

const countText = (b: number, s: number) => (b === 3 && s === 2 ? 'Full count.' : `${b} and ${s}.`);


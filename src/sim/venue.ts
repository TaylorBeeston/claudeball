/**
 * Where things are around the field (metres; +X toward third base, +Z toward centre field, origin home plate): the dugouts and their bench seats, the
 * on-deck circles, the coach boxes, the ball kids' chairs, the bullpens. The numbers follow `assets/src/field.py` / `geom.py` (the rendered stadium).
 * The home team is in the third-base dugout (+X), the visitors in the first-base dugout (-X).
 */
import type { TeamSide } from './types';

const R = Math.SQRT1_2;
const sg = (side: TeamSide) => (side === 'home' ? 1 : -1);

/** The dugout / coach box / stand frame of the assets: `s` metres along the base line from the plate, `o` metres off it into foul ground. */
export const alongLine = (s: number, o: number, side: TeamSide) => ({ x: sg(side) * (s + o) * R, z: (s - o) * R });

/** Dugout footprint (s 12-30, o 8.6-13.2), its floor 1.05 m below the field, the bench along the back wall, the steps at the home-plate end. */
export const DUG_S = [12, 30] as const;
export const DUG_O = [8.6, 13.2] as const;
export const DUG_FLOOR = -1.05;
export const BENCH_SEATS = 16;

/** The dugout door at field level (the top of the steps) and the foot of the steps. */
export const dugDoor = (side: TeamSide) => alongLine(11.0, 9.6, side);
export const dugStep = (side: TeamSide) => alongLine(12.9, 9.7, side);
/** Seat `k` on the bench (0 = nearest the steps), the aisle point in front of it, and the way he faces (toward the field). */
export const benchSeat = (side: TeamSide, k: number) => alongLine(14.2 + (k % BENCH_SEATS) * 0.95, 12.1, side);
export const benchAisle = (side: TeamSide, k: number) => alongLine(14.2 + (k % BENCH_SEATS) * 0.95, 10.4, side);
export const benchFacing = (side: TeamSide) => Math.atan2(-sg(side) * R, R);

/** The on-deck circle (radius 0.76 m, 5 ft across) on the dugout side of the plate. */
export const onDeckSpot = (side: TeamSide) => ({ x: sg(side) * 11.3, z: 0 });
/** A point behind the plate the walk to the far batter's box goes through (behind the umpire and the catcher). */
export const behindPlate = (x: number) => ({ x, z: -3.6 });

/** Coach boxes beside first and third (10 x 20 ft, 15 ft off the line): the point a coach stands at. */
export const coachBox = (base: 1 | 3) => alongLine(27.4, 6.1, base === 3 ? 'home' : 'away');

/** Ball kids' chairs down the lines (foul ground, ~4.5 m off the line, 48 m from the plate along it), and the bat boy's spot by the dugout. */
export const ballKidSpot = (base: 1 | 3) => alongLine(48, 4.5, base === 3 ? 'home' : 'away');
export const batBoySpot = (side: TeamSide) => alongLine(16.5, 5.2, side);

/** Bullpens beyond the outfield corners (the mound end and the plate end): first-base side for the visitors, third-base side for the home team. */
export const bullpenMound = (side: TeamSide) => alongLine(62, 8, side);
export const bullpenSpot = (side: TeamSide, k: number) => {
  const m = bullpenMound(side);
  return { x: m.x + sg(side) * 1.8 + sg(side) * (k % 4) * 0.8, z: m.z - 1.2 - Math.floor(k / 4) * 0.8 };
};

/** Height of the floor at a field position when it is inside a dugout (negative: the pit), else 0. The steps ramp up to the field at the plate end. */
export function dugoutFloorY(x: number, z: number): number {
  const ax = Math.abs(x);
  const s = (ax * (1 / R) + z * (1 / R)) / 2;
  const o = (ax * (1 / R) - z * (1 / R)) / 2;
  if (s < 11.2 || s > DUG_S[1] || o < DUG_O[0] || o > DUG_O[1]) return 0;
  // the steps (s 12.25 - 13.4) climb 0.9 m to the lip: the floor ramps from the aisle up to the field-level door
  if (s < 13.4) return DUG_FLOOR + Math.min(1.05, (13.4 - s) * 0.95);
  return DUG_FLOOR;
}

/** The manager and the pitching coach stand at the dugout rail (front of the dugout, home-plate end), inside the pit. */
export const managerSpot = (side: TeamSide) => alongLine(15.0, 9.2, side);
export const pitchCoachSpot = (side: TeamSide) => alongLine(16.8, 9.2, side);
/** Where a visitor stands at the mound (between the pitcher and the plate), and the ring spots of the infielders who join. */
export const moundVisitor = { x: 0.7, z: 17.0 };
export const moundRing: Record<string, { x: number; z: number }> = { '1B': { x: -2.3, z: 17.6 }, '2B': { x: -2.6, z: 19.6 }, SS: { x: 2.6, z: 19.6 }, '3B': { x: 2.3, z: 17.6 } };
/** Where the umpires gather for a review (a huddle in front of the plate, on the first-base side). */
export const umpHuddle = (k: number) => ({ x: -1.6 + 1.1 * (k % 2), z: 5.0 + 1.1 * Math.floor(k / 2) });

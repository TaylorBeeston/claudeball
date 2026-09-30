/**
 * How the player attributes (ratings, physique, delivery) turn into mechanics. Every function here is a pure map from
 * an attribute to a physical quantity or noise scale, used by the sim and unit-tested (`__tests__/attributes.test.ts`).
 * 50 is average on the 20-80 scouting scale; the maps are written around that point.
 */
import { MOUND_DIST, groundHeight } from './field';
import { clamp } from './math';
import type { Delivery, DeliveryStyle, PlayerInfo, Ratings } from './types';

export const RUBBER_Z = MOUND_DIST;

// ---------------------------------------------------------------------------------------------
// pitcher: delivery and release point
// ---------------------------------------------------------------------------------------------

export function styleOf(armSlotDeg: number): DeliveryStyle {
  return armSlotDeg < 25 ? 'overhand' : armSlotDeg < 65 ? 'three_quarter' : armSlotDeg < 100 ? 'sidearm' : 'submarine';
}

/**
 * Release point from the arm slot and the body: height above the mound, lateral offset toward the arm side (+X for a
 * right-hander), and extension in front of the rubber. Lower slots release lower and wider.
 */
export function releaseGeometry(d: Delivery, heightM: number, throwsLeft: boolean, extension: number): { armHeight: number; armSide: number; extension: number; aboveMound: number } {
  const c = Math.cos((d.armSlotDeg * Math.PI) / 180);
  const s = Math.sin((d.armSlotDeg * Math.PI) / 180);
  const aboveMound = heightM * (0.65 + 0.27 * c);
  const side = (throwsLeft ? -1 : 1) * (0.16 + 0.6 * s * (heightM / 1.9));
  // release height is measured above the mound the pitcher stands on
  return { armHeight: groundHeight(0, RUBBER_Z) + aboveMound, armSide: side, extension, aboveMound };
}

/** Seconds from set to release (before per-pitch noise): windup with the bases empty, the shorter stretch with runners on. */
export function deliverySeconds(d: Delivery, r: Ratings, fromStretch: boolean): number {
  const base = fromStretch ? 0.84 - 0.0035 * (r.holding - 50) : 1.12;
  return base / clamp(d.tempo, 0.75, 1.25);
}

/** Velocity lost working from the stretch (mph) and the command penalty that goes with the shorter motion. */
export const STRETCH_MPH = 0.6;
export const STRETCH_COMMAND = 1.04;

/** Time (s) to start the throw over to a base: the pickoff move's quickness. */
export const pickoffSeconds = (r: Ratings) => clamp(0.35 - 0.003 * (r.pickoff - 50), 0.22, 0.5);
/** Seconds the runner needs to react to the move: a deceptive move freezes him a moment. */
export const pickoffRunnerReaction = (runnerBaserunning: number, r: Ratings) => Math.max(0.1, 0.22 - 0.0008 * (runnerBaserunning - 50) + 0.0014 * (r.pickoff - 50));
/** How far off the bag (m) a runner dares to stand against this pitcher: a good holder shortens the leash. */
export const holdingLeadAdjust = (r: Pick<Ratings, 'holding'>) => -0.022 * (r.holding - 50);

/** Scale on the pitcher's command noise from his form and composure under pressure (`pressure` 0..1) and rattled state (0..1). */
export function composureScale(r: Ratings, pressure: number, rattled: number): number {
  const c = (50 - r.composure) / 30; // + = fragile
  return clamp(1 + 0.12 * c * pressure + 0.1 * c * rattled + 0.05 * rattled, 0.85, 1.35);
}

/** Release-point repeatability: metres of 1-sigma scatter in each release coordinate (lower consistency = wider). */
export const releaseSigma = (r: Ratings) => clamp(0.032 * (1.55 - 0.011 * r.consistency), 0.014, 0.05);

/** Pitcher stamina: pitches before he is spent. */
export const pitchLimit = (r: Ratings) => 30 + r.stamina + 0.15 * (r.durability - 50);

// ---------------------------------------------------------------------------------------------
// hitter
// ---------------------------------------------------------------------------------------------

/** Scale on swing-timing / bat-path noise from consistency (pitch to pitch): 1 at 50. */
export const consistencyScale = (cons: number) => clamp(1.3 - 0.006 * cons, 0.75, 1.3);

/** Day-to-day form: an AR(1) drift, wider for inconsistent players. `step` is a standard normal. */
export function nextForm(form: number, cons: number, step: number): number {
  return clamp(0.8 * form + 0.6 * (1.5 - (cons / 50) * 0.5) * step, -2.5, 2.5);
}
/** Rating points of contact / power the current form is worth. */
export const formContactShift = (form: number) => 4 * form;
export const formPowerShift = (form: number) => 2.5 * form;

/** Leverage of a situation for the batting team, 0 (nothing on it) .. 1 (game on the line). */
export function pressureOf(inning: number, innings: number, outs: number, scoreDiff: number, runnerBases: number[]): number {
  const late = clamp((inning - (innings - 3)) / 3, 0, 1); // 7th inning on
  const close = clamp(1 - Math.abs(scoreDiff) / 4, 0, 1);
  const risp = runnerBases.some((b) => b >= 2) ? 1 : runnerBases.length ? 0.5 : 0;
  const twoOut = outs === 2 ? 1 : 0.6;
  return clamp(late * close * (0.5 + 0.5 * risp) * (0.8 + 0.2 * twoOut) * 1.1, 0, 1);
}
/** Extra timing / aim noise factor from pressure: clutch players tighten up, rattled ones loosen. */
export const clutchScale = (clutch: number, pressure: number) => clamp(1 + 0.1 * pressure * ((50 - clutch) / 30), 0.9, 1.15);

/** How much further out in front (+) of his comfortable contact depth a puller meets the ball / how much deeper (-) an opposite-field hitter lets it travel (m): the bat is more turned at contact, so the ball goes toward the pull side. */
export const pullDepth = (pull: number) => clamp(0.004 * (pull - 50), -0.14, 0.14);

/** Mean attack angle a gap hitter is drawn to (deg) and the spread scale of his bat path. */
export const GAP_ANGLE_DEG = 11;
export const gapAttackAngle = (base: number, gap: number) => base + (GAP_ANGLE_DEG - base) * clamp((gap - 50) / 60, 0, 0.5);
export const gapSpread = (gap: number) => clamp(1.15 - 0.006 * (gap - 50), 0.8, 1.35);

/** Perception of breaking / off-speed pitches: extra recognition probability and movement-extrapolation noise scale. */
export const breakingRecognition = (br: number) => 0.007 * (br - 50);
export const breakingNoiseScale = (br: number) => clamp(1.25 - 0.005 * br, 0.85, 1.35);

// ---------------------------------------------------------------------------------------------
// running and fielding
// ---------------------------------------------------------------------------------------------

export const sprintOf = (speed: number) => 6.65 + 0.031 * speed;
export const accelOfRating = (acceleration: number) => 6.6 + 0.03 * acceleration;
/** Fielders' top speed leans on range as well (long strides, good reads). */
export const fielderTopSpeed = (r: Ratings) => sprintOf(0.85 * r.speed + 0.15 * r.range);
/** Efficiency of his routes: fraction of top speed that turns into progress toward the ball. */
export const routeEfficiency = (r: Ratings) => clamp(0.955 + 0.0009 * (r.iq - 50), 0.92, 0.985);
/** Judgement error (m per second of remaining flight) of the ball's path: range and IQ shrink it. */
export const judgementSigma = (r: Ratings) => clamp(0.38 - 0.0035 * (r.range - 50) - 0.0035 * (r.iq - 50), 0.2, 0.85);
/** Time to first move (s) after contact: first step. */
export const firstStepSeconds = (r: Ratings, jitter: number) => 0.10 + 0.2 * (1 - r.range / 100) - 0.0006 * (r.iq - 50) + jitter;
/** Wind-up (s) before a throw leaves the hand and the glove-to-hand transfer (s). */
export const throwWindup = (r: Ratings, onRun: number) => (0.07 + 0.06 * onRun) * clamp(1.35 - 0.007 * r.release, 0.7, 1.3);
export const transferSeconds = (r: Ratings, onRun: number) => clamp(0.5 - 0.0025 * (r.glove - 50) - 0.0025 * (r.release - 50) + 0.03 * onRun, 0.3, 0.85);
export const armMps = (r: Ratings) => 27 + 0.21 * r.arm;

/** Legs: fatigue from sprinting (0 fresh .. 1), the speed it costs (fraction) and how quickly it comes back. */
export const legsSpeedFactor = (legs: number, durability: number) => 1 - 0.06 * legs * clamp(1.7 - durability / 50, 0.1, 1.5);
/** How hard a runner / fielder can brake for a stop (m/s²): a human limit, a little better with a good read of the play (iq) and range. */
export const brakeDecel = (r: Ratings) => clamp(6.6 + 0.02 * (r.iq - 50) + 0.01 * (r.range - 50), 4.5, 7.5);
export const LEGS_PER_SPRINT_SECOND = 1 / 60;
export const LEGS_RECOVERY_PER_SECOND = 1 / 240;

// catchers
export const catcherExchange = (r: Ratings) => 0.72 - 0.0035 * (r.pop - 50);
export const catcherTransfer = (r: Ratings) => clamp(0.74 - 0.0045 * (r.pop - 50), 0.5, 1.0);
export const framingPull = (r: Ratings) => clamp((r.framing - 50) * 0.00022, -0.008, 0.012);
export const blockHalfWidth = (r: Ratings) => 0.3 + 0.0045 * r.blocking;

export const isPitcher = (p: PlayerInfo) => p.isPitcher;

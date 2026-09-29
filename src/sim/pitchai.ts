import { pitchLimit } from './attributes';
import { PLATE_HALF_WIDTH } from './field';
import { clamp } from './math';
import type { StrikeZone } from './pitching';
import type { PitchSpec, PitchType } from './types';
import type { PlayerRT, World } from './world';

const FASTBALLS: PitchType[] = ['FF', 'SI', 'FC'];
const BREAKING: PitchType[] = ['SL', 'CU', 'SW'];
const isFB = (t: PitchType) => FASTBALLS.includes(t);
const isBrk = (t: PitchType) => BREAKING.includes(t);

export type Intent = 'middle' | 'edge' | 'chase';

export interface PitchCall {
  spec: PitchSpec;
  x: number;
  y: number;
  intent: Intent;
}

/** Fatigue in [0, ~1.3]: 0 while fresh, rising as the pitch count passes ~60% of the pitcher's limit. */
export function fatigueOf(p: PlayerRT): number {
  const limit = pitchLimit(p.info.ratings);
  const onset = 0.62 * limit;
  return Math.max(0, (p.pitchCount - onset) / onset);
}

/** The catcher / pitcher pitch-calling AI: chooses an intent from the count and batter, then a pitch and a target. */
export function callPitch(w: World): PitchCall {
  const rng = w.aiRng;
  const P = w.pitcher;
  const B = w.batter!;
  const { balls, strikes } = w.count;
  const zone: StrikeZone = w.zone;
  const cy = (zone.top + zone.bottom) / 2;
  const halfH = (zone.top - zone.bottom) / 2;

  // --- intent probabilities ---
  let pChase: number;
  let pEdge: number;
  if (balls === 3 && strikes < 2) {
    pChase = 0;
    pEdge = strikes === 0 ? 0.15 : 0.35;
  } else if (strikes === 2) {
    pChase = balls === 3 ? 0.12 : balls === 2 ? 0.34 : balls === 1 ? 0.5 : 0.58;
    pEdge = 0.36;
  } else if (balls > strikes) {
    pChase = 0.1;
    pEdge = 0.45;
  } else if (balls === 0 && strikes === 0) {
    pChase = 0.1;
    pEdge = 0.5;
  } else if (strikes === 1 && balls === 0) {
    pChase = 0.3;
    pEdge = 0.42;
  } else {
    pChase = 0.22;
    pEdge = 0.45;
  }
  const disc = (B.info.ratings.discipline + B.info.ratings.eye) / 2;
  pChase *= clamp(1.35 - 0.014 * disc, 0.55, 1.4) * 1.35;
  pEdge += 0.04;
  const power = B.info.ratings.power;
  if (power > 60) pEdge += 0.05;
  // wild pitchers avoid nibbling
  if (P.info.ratings.control < 40) pEdge *= 0.85;
  const r = rng.next();
  const intent: Intent = r < pChase ? 'chase' : r < pChase + pEdge ? 'edge' : 'middle';

  // --- pitch type ---
  const bHand = w.batStance;
  const arsenal = P.info.arsenal;
  const weights = arsenal.map((a) => {
    let wt = a.usage;
    if (intent === 'chase') wt *= isFB(a.type) ? (a.type === 'FF' ? 0.55 : 0.3) : 1.5;
    else if (intent === 'middle') wt *= isFB(a.type) ? 1.7 : a.type === 'CH' ? 0.8 : 0.7;
    else wt *= isFB(a.type) ? 1.1 : 1.0;
    if (balls >= 2 && strikes < 2 && !isFB(a.type)) wt *= 0.75; // need a strike
    if (a.type === 'CH') wt *= bHand !== P.info.throws ? 1.5 : 0.55; // change-ups vs opposite hand
    if (isBrk(a.type)) wt *= bHand === P.info.throws ? 1.25 : 0.85;
    if (a.type === w.seq.lastType) wt *= 0.72;
    return wt;
  });
  const tot = weights.reduce((s, x) => s + x, 0);
  let x = rng.next() * tot;
  let spec = arsenal[0];
  for (let i = 0; i < arsenal.length; i++) {
    x -= weights[i];
    if (x <= 0) {
      spec = arsenal[i];
      break;
    }
  }

  // --- target ---
  const away = bHand === 'R' ? -1 : 1; // toward the far side of the plate from the batter
  let u: number; // horizontal, in half-plate widths (+ = toward third base side)
  let v: number; // vertical, in half-zone heights
  if (intent === 'middle') {
    u = clamp(rng.normal(0, 0.28), -0.6, 0.6);
    v = clamp(rng.normal(0, 0.3), -0.6, 0.6);
  } else if (intent === 'edge') {
    const horiz = rng.next() < 0.6;
    if (horiz) {
      u = (rng.next() < 0.74 ? away : -away) * rng.range(0.95, 1.4);
      v = clamp(rng.normal(0, 0.45), -0.85, 0.85);
    } else {
      v = (rng.next() < 0.6 ? -1 : 1) * rng.range(0.9, 1.4);
      u = clamp(rng.normal(0, 0.5), -0.9, 0.9);
    }
  } else {
    // chase: out of the zone. Breaking balls dive low/away, fastballs climb or run away
    if (isFB(spec.type)) {
      if (rng.next() < 0.55) {
        v = rng.range(1.35, 1.9);
        u = clamp(rng.normal(0, 0.5), -0.9, 0.9);
      } else {
        u = away * rng.range(1.35, 1.9);
        v = clamp(rng.normal(0, 0.5), -0.8, 0.8);
      }
    } else {
      if (rng.next() < 0.6) {
        v = -rng.range(1.35, 2.1);
        u = away * rng.range(0.2, 1.2);
      } else {
        u = away * rng.range(1.35, 2.0);
        v = clamp(rng.normal(-0.3, 0.5), -1, 0.6);
      }
    }
  }
  return { spec, x: u * PLATE_HALF_WIDTH, y: cy + v * halfH, intent };
}

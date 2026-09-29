/**
 * Pitching delivery timing shared by the animation and the tests: which clip a pitcher plays, when the ball leaves the glove and the
 * hand, and how the sim's windup (which ends exactly at release) is laid over a clip whose release frame is fixed.
 */
export type DeliveryStyle = 'overhand' | 'three_quarter' | 'sidearm' | 'submarine';

/** The sim's windup length (s): 1.12 windup / 0.84 stretch (holding-adjusted), divided by the tempo (clamped 0.75..1.25). */
export function windupSeconds(tempo: number, fromStretch: boolean, holding = 50): number {
  const base = fromStretch ? 0.84 - 0.0035 * (holding - 50) : 1.12;
  return base / Math.min(1.25, Math.max(0.75, tempo));
}

/** Frames of the delivery clips (24 fps): [hand break, foot plant, release]. Windup clips 32 frames, stretch 26. */
export const DELIVERY_FRAMES: Record<DeliveryStyle, { windup: [number, number, number]; stretch: [number, number, number] }> = {
  overhand: { windup: [8, 11, 14], stretch: [5, 7, 9] },
  three_quarter: { windup: [8, 11, 14], stretch: [5, 7, 9] },
  sidearm: { windup: [8, 11, 13], stretch: [5, 7, 9] },
  submarine: { windup: [8, 11, 14], stretch: [5, 7, 9] },
};
export const CLIP_FPS = 24;

export interface DeliveryEvents {
  /** clip name */
  clip: string;
  /** seconds into the clip */
  handBreak: number;
  footPlant: number;
  release: number;
}

export function deliveryClip(style: DeliveryStyle | undefined, fromStretch: boolean): DeliveryEvents {
  const st = style ?? 'overhand';
  const f = DELIVERY_FRAMES[st] ?? DELIVERY_FRAMES.overhand;
  const [hb, fp, rel] = fromStretch ? f.stretch : f.windup;
  return { clip: `pitch_${st}_${fromStretch ? 'stretch' : 'windup'}`, handBreak: hb / CLIP_FPS, footPlant: fp / CLIP_FPS, release: rel / CLIP_FPS };
}

export const RELEASE_HOLD_MAX = 0.75;
export const SPEED_MIN = 0.6;
export const SPEED_MAX = 2.0;

export interface DeliveryPlan {
  /** seconds spent rocking / set before the delivery clip starts (the sim's windup minus the clip's time to release) */
  hold: number;
  /** playback speed of the delivery clip */
  speed: number;
}

/**
 * Lay a delivery clip over the sim's windup: hold the rock / set pose for `hold` s, then play the delivery so that its release frame lands
 * exactly at the end of the sim's windup (= the moment the ball is released). A tempo that leaves less time than the clip needs simply
 * speeds it up; a hitch that leaves more holds longer (both bounded).
 */
export function planDelivery(windupDur: number, release: number): DeliveryPlan {
  const dur = Math.max(0.2, windupDur);
  let hold = Math.min(RELEASE_HOLD_MAX, Math.max(0, dur - release));
  let speed = release / Math.max(0.05, dur - hold);
  if (speed < SPEED_MIN) {
    speed = SPEED_MIN;
    hold = Math.max(0, dur - release / SPEED_MIN);
  } else if (speed > SPEED_MAX) speed = SPEED_MAX;
  return { hold, speed };
}

/**
 * Clip time (s) for `elapsed` seconds since the sim's windup began (elapsed may exceed `windupDur` during the follow-through, which the
 * sim reports as `pitch` progress). Returns null while still holding the rock / set pose.
 */
export function deliveryClipTime(plan: DeliveryPlan, elapsed: number): number | null {
  if (elapsed < plan.hold) return null;
  return (elapsed - plan.hold) * plan.speed;
}

export type BallPlace = 'glove' | 'hand' | 'world';
/** Where the pitcher's ball is at a clip time: in the glove until the hand break, in the hand until release, then the sim owns it. */
export function pitchBallPlace(clipTime: number | null, ev: DeliveryEvents): BallPlace {
  if (clipTime === null || clipTime < ev.handBreak) return 'glove';
  return clipTime < ev.release ? 'hand' : 'world';
}

/** Grip: two-seam style pitches use the 2-seam grip, the rest the 4-seam. */
export function gripFor(pitchType: string | undefined): 'Ball_Grip' | 'Ball_Grip_2Seam' {
  return pitchType && ['FT', 'SI', 'CH', 'FS'].includes(pitchType) ? 'Ball_Grip_2Seam' : 'Ball_Grip';
}

/**
 * Waiting for a throw that has not been made yet. The sim only reports a catch (hint, `gloveTarget`, `catchIn`) once the ball is on its way, but
 * a pitcher whose catcher is handling the ball already turns to him and holds the glove up. Without a `catch_ready` hint from the sim this is
 * inferred from the ball carrier: a catcher or fielder in his transfer / look / toss with a receiver standing near with nothing in his hands.
 */
export interface ReadyInput {
  /** the sim sent a `catch_ready` hint for this player */
  hint: boolean;
  role: string;
  anim: string;
  hasBall: boolean;
  /** the ball carrier, when it is somebody else */
  carrier: { role: string; anim: string; distance: number } | null;
  /** the sim already has a glove target for this player (the throw is in the air) */
  incoming?: boolean;
  /** the ball is loose and moving faster than a casual throw: this is a live play, not a handoff */
  liveBall: boolean;
}

const WAITING_ANIMS = new Set(['idle', 'walk', 'catch_ready']);
const HANDLING_ANIMS = new Set(['transfer', 'toss', 'catch_pitch']);

export function receiveReady(i: ReadyInput): boolean {
  if (i.hasBall) return false;
  if (i.incoming && i.role === 'pitcher') return true; // the return throw flies at 25-40 m/s: the glove stays up until the catch clip takes over
  if (i.liveBall) return false;
  if (i.hint) return true;
  if (!WAITING_ANIMS.has(i.anim) || !i.carrier) return false;
  // inferred only for the catcher's return to the pitcher (other casual legs arrive with their own catch hint a second before the ball)
  if (i.role !== 'pitcher' || i.carrier.role !== 'catcher') return false;
  if (i.carrier.distance > 30 || i.carrier.distance < 8) return false;
  return HANDLING_ANIMS.has(i.carrier.anim);
}

/** where the glove waits: in front of the chest, toward the thrower, on the glove side (metres in the player's frame → returned in scene axes) */
export function readyGlove(pos: { x: number; z: number }, toward: { x: number; z: number }, hand: 'L' | 'R', out = { x: 0, y: 0, z: 0 }) {
  const dx = toward.x - pos.x, dz = toward.z - pos.z;
  const l = Math.hypot(dx, dz) || 1;
  const fx = dx / l, fz = dz / l;
  // glove hand is on the left of the facing for a right-hander
  const lx = fz, lz = -fx;
  const s = (hand === 'L' ? -1 : 1) * 0.3;
  out.x = pos.x + fx * 0.55 + lx * s;
  out.y = 1.3;
  out.z = pos.z + fz * 0.55 + lz * s;
  return out;
}

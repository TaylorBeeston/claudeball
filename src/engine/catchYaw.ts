/**
 * The body's heading while a fielder takes a ball and holds it. Pure: no three.js (unit-tested under node).
 *
 * The sim turns a player toward his velocity whenever he moves faster than 0.8 m/s, and back toward what he looks at once he is slower
 * (movement.ts). Under a fly ball, and fielding a grounder, the last adjustment is a shuffle of 0.9-1.4 m/s in any direction for a tenth of a
 * second or two: the sim's facing swings 1-1.7 rad toward it and straight back, and a body that followed it swivelled on planted feet right
 * after the catch (t-0039: `foot:skate` 6-11 frames a catch). A fielder squared up to the ball does not turn his chest toward a half step.
 *
 * So while he is taking or holding the ball (not running, not throwing), the body keeps its heading and takes the sim's facing only once that
 * has settled (turning slower than `steadyRate` for `steady` s) while he stands or runs; never in the in-between shuffle speeds, where the
 * sim's facing is the shuffle's direction.
 */
export const CATCH_YAW = {
  /** the sim's facing counts as settled after turning slower than `steadyRate` (rad/s) for `steady` s */
  steady: 0.1,
  steadyRate: 1.5,
  /** speeds (m/s) in which the sim's facing follows a shuffle, not where he is going: the sim's own threshold (0.8) up to a run */
  shuffle: [0.8, 2.0] as const,
  /** the turn rate (rad/s) toward a settled heading: a standing turn the feet can step with (pose/footLock.ts) */
  turn: 5,
};

export interface CatchYawState {
  /** the heading the body keeps (null: not taking or holding a ball) */
  hold: number | null;
  prev: number | null;
  steadyT: number;
}
export const newCatchYaw = (): CatchYawState => ({ hold: null, prev: null, steadyT: 0 });

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/**
 * One frame. `on`: he is taking or holding a ball (a catch / fielding clip, the transfer, settled under a fly ball he has called); `facing`: the
 * sim's; `body`: the body's heading now; `speed`: his ground speed (m/s). Returns the heading to turn toward, or null (off: the caller's rule).
 */
export function catchYaw(st: CatchYawState, on: boolean, facing: number, body: number, speed: number, dt: number): number | null {
  const rate = st.prev === null || dt <= 0 ? Infinity : Math.abs(wrap(facing - st.prev)) / dt;
  st.prev = facing;
  st.steadyT = rate < CATCH_YAW.steadyRate ? st.steadyT + dt : 0;
  if (!on) {
    st.hold = null;
    return null;
  }
  if (st.hold === null) st.hold = body;
  const shuffling = speed > CATCH_YAW.shuffle[0] && speed < CATCH_YAW.shuffle[1];
  if (!shuffling && st.steadyT >= CATCH_YAW.steady - 1e-9) st.hold = facing;
  return st.hold;
}

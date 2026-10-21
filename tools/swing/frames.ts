/** A swing's frames as the engine draws them (shared by worker.ts and tune.ts). */
import { Holder, ikWeights, type HoldSample, type V3 } from './hold';

export interface Frame {
  tau: number;
  /** clip time shown */
  t: number;
  knob: V3;
  tip: V3;
  s: HoldSample;
  finish: boolean;
}

interface SwingLike {
  tau: number;
  done: boolean;
  plan: { tauC: number };
  advance(dt: number): void;
  pose(): { knob: V3; tip: V3 };
}

/**
 * Every 60 Hz frame of a swing from its start to the end of the hint (2.1 tauC), then 0.1 s of the clip's finish with the sim's last pose
 * held: the drawn bat (eased from the hands' over the first 70 ms, engine.ts BAT_BLEND) and the fists solved onto it, tracked frame to
 * frame. In the finish the engine lets the top hand go when it would need > 12 deg past its range (gltfCharacter.ts topRelease): such a
 * top hand is not counted.
 */
export function swingFrames(holder: Holder, bs: SwingLike, stance: 'L' | 'R', h: number, each?: (f: Frame) => void): Frame[] {
  const DT = 1 / 1920;
  const tauC = bs.plan.tauC, tEnd = tauC * 2.1;
  const track = {};
  const out: Frame[] = [];
  const W = ikWeights(Math.ceil(tEnd * 60) + 10);
  for (let k = 0; k / 60 <= tEnd + 1e-9; k++) {
    const tau = k / 60;
    while (bs.tau < tau - 1e-9 && !bs.done) bs.advance(Math.min(DT, tau - bs.tau));
    const pose = bs.pose();
    const t = holder.clipTime(tau / tEnd);
    let kn = pose.knob, tp = pose.tip;
    if (tau < 0.07) {
      const cb = holder.clipBat(t, stance, h), e = tau / 0.07, m = e * e * (3 - 2 * e);
      const mix = (a: V3, b: V3) => ({ x: a.x + (b.x - a.x) * m, y: a.y + (b.y - a.y) * m, z: a.z + (b.z - a.z) * m });
      kn = mix(cb.knob, pose.knob);
      const dd = mix({ x: cb.tip.x - cb.knob.x, y: cb.tip.y - cb.knob.y, z: cb.tip.z - cb.knob.z }, { x: pose.tip.x - pose.knob.x, y: pose.tip.y - pose.knob.y, z: pose.tip.z - pose.knob.z });
      const l = Math.hypot(dd.x, dd.y, dd.z) / 0.84;
      tp = { x: kn.x + dd.x / l, y: kn.y + dd.y / l, z: kn.z + dd.z / l };
    }
    const f = { tau, t, knob: kn, tip: tp, s: holder.sample(stance, h, kn, tp, t, track, 1 / 60, W[k]), finish: false };
    out.push(f);
    each?.(f);
  }
  while (!bs.done) bs.advance(DT);
  const pose = bs.pose();
  for (let j = 1; j <= 6; j++) {
    const t = holder.clipTime(1.01, j / 60);
    const s = holder.sample(stance, h, pose.knob, pose.tip, t, track);
    if (s.overR > 12) {
      // the top hand let go: only the bottom fist holds the bat
      s.gripR = 0;
      s.axisR = 0;
      s.held = s.gripL <= 0.03 && s.axisL <= 25;
    }
    const f = { tau: tEnd + j / 60, t, knob: pose.knob, tip: pose.tip, s, finish: true };
    out.push(f);
    each?.(f);
  }
  return out;
}

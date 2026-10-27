/**
 * Aggregation of validator output: per (source, file, clip) the frames each kind of violation fires on, its worst excess and a severity-weighted
 * score (severity x seconds), plus the worst frame's pose snapshot per kind for the contact sheets. Serialisable, so the page and Node merge alike.
 */
import type { Violation } from './validate';

export interface Snapshot {
  lq: number[];
  lp: number[];
  base: number[];
  model: number[];
  bat?: { knob: number[]; tip: number[] } | null;
  ctx: Record<string, unknown>;
}
export interface KindStat {
  frames: number;
  max: number;
  sum: number;
  score: number;
  worst?: Snapshot;
}
export interface Entry {
  src: string;
  file: string;
  clip: string;
  frames: number;
  /** frames with at least one violation */
  bad: number;
  seconds: number;
  score: number;
  kinds: Record<string, KindStat>;
}

export class Agg {
  entries = new Map<string, Entry>();
  /** keep pose snapshots of the worst frames (off for the cheap ratchet run) */
  snapshots = true;

  add(src: string, file: string, clip: string, v: Violation[], dt: number, snap?: () => Snapshot) {
    const key = `${src}|${file}|${clip}`;
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { src, file, clip, frames: 0, bad: 0, seconds: 0, score: 0, kinds: {} }));
    e.frames++;
    e.seconds += dt;
    if (!v.length) return;
    e.bad++;
    let s: Snapshot | undefined;
    for (const x of v) {
      const k = (e.kinds[x.kind] ??= { frames: 0, max: 0, sum: 0, score: 0 });
      k.frames++;
      k.sum += x.excess;
      k.score += x.sev * dt;
      e.score += x.sev * dt;
      if (x.excess > k.max) {
        k.max = x.excess;
        if (this.snapshots && snap) k.worst = s ??= snap();
      }
    }
  }

  merge(other: Iterable<Entry>) {
    for (const o of other) {
      const key = `${o.src}|${o.file}|${o.clip}`;
      const e = this.entries.get(key);
      if (!e) {
        this.entries.set(key, structuredClone(o));
        continue;
      }
      e.frames += o.frames;
      e.bad += o.bad;
      e.seconds += o.seconds;
      e.score += o.score;
      for (const [kind, ks] of Object.entries(o.kinds)) {
        const k = (e.kinds[kind] ??= { frames: 0, max: 0, sum: 0, score: 0 });
        k.frames += ks.frames;
        k.sum += ks.sum;
        k.score += ks.score;
        if (ks.max > k.max) {
          k.max = ks.max;
          k.worst = ks.worst;
        }
      }
    }
  }

  list(): Entry[] {
    return [...this.entries.values()];
  }
}

/** a kind's family for the summary tables: `joint:elbowL.flex` -> `joint:elbow.flex` (sides merged), `spike:LeftArm` -> `spike:Arm` */
export function family(kind: string): string {
  const [f, k] = kind.split(':');
  if (!k) return f;
  return `${f}:${k.replace(/^(Left|Right)/, '').replace(/([a-z])[LR]\./, '$1.').replace(/-[LR]$/, '')}`;
}

/**
 * Head roll off the horizon per role and clip: a 1-degree histogram of |roll| of the final pose, the clip's own (mixer) roll, the chest's lean
 * off the vertical and the look's yaw offset, and a few samples (roll, look yaw, lean, clip roll) to relate them. Airborne frames apart.
 */
export interface RollStat {
  n: number;
  air: number;
  hist: number[];
  clipMax: number;
  lean: number;
  lookYaw: number;
  samples: number[][];
}
export function addRoll(m: Record<string, RollStat>, key: string, roll: number, clipRoll: number, lean: number, lookYaw: number, airborne: boolean) {
  const r = (m[key] ??= { n: 0, air: 0, hist: new Array(91).fill(0), clipMax: 0, lean: 0, lookYaw: 0, samples: [] });
  if (airborne) {
    r.air++;
    return;
  }
  r.n++;
  r.hist[Math.min(90, Math.floor(Math.abs(roll)))]++;
  r.clipMax = Math.max(r.clipMax, Math.abs(clipRoll));
  r.lean += lean;
  r.lookYaw += Math.abs(lookYaw) / (Math.PI / 180);
  // a sample every ~30 frames, more of the worst
  if (r.samples.length < 60 && (r.n % 30 === 0 || (Math.abs(roll) > 30 && r.n % 5 === 0))) r.samples.push([roll, lookYaw / (Math.PI / 180), lean, clipRoll].map((x) => +x.toFixed(1)));
}
export function mergeRoll(into: Record<string, RollStat>, from: Record<string, RollStat>) {
  for (const [k, o] of Object.entries(from)) {
    const r = into[k];
    if (!r) {
      into[k] = structuredClone(o);
      continue;
    }
    r.n += o.n;
    r.air += o.air;
    for (let i = 0; i < r.hist.length; i++) r.hist[i] += o.hist[i];
    r.clipMax = Math.max(r.clipMax, o.clipMax);
    r.lean += o.lean;
    r.lookYaw += o.lookYaw;
    r.samples.push(...o.samples.slice(0, Math.max(0, 60 - r.samples.length)));
  }
  return into;
}

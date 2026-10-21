/** Mergeable histograms and tallies for tools/swing (worker shards -> run.ts). */
import type { HoldSample } from './hold';

export const PHASES = ['launch', 'mid', 'contact', 'follow', 'finish'] as const;
export type Phase = (typeof PHASES)[number];
export const MARKS = ['t0', 'half', 'c-60ms', 'contact', '1.5c', '2.1c'] as const;

/** the splits every hold rate is also reported by: stance, pitch height at the plate, batter height */
export function splitKeys(stance: string, py: number, h: number): string[] {
  const ph = py < 0.6 ? 'pitch<0.6' : py < 0.9 ? 'pitch0.6-0.9' : 'pitch>0.9';
  const bh = h < 1.8 ? 'h<1.80' : h < 1.9 ? 'h1.80-1.90' : 'h>1.90';
  return [`stance:${stance}`, ph, bh];
}

export interface Worst {
  over: number;
  miss: number;
  az: number;
  el: number;
  wel: number;
  ctx: Record<string, unknown>;
}

export class Hist {
  /** name -> value (rounded to 1 unit) -> count */
  h: Record<string, Record<string, number>> = {};
  /** phase|split -> [n, strict, relaxed] */
  t: Record<string, [number, number, number]> = {};
  worst: Record<string, Worst[]> = {};

  add(name: string, v: number) {
    if (!Number.isFinite(v)) return;
    const b = (this.h[name] ??= {});
    const k = String(Math.round(v));
    b[k] = (b[k] ?? 0) + 1;
  }

  tally(key: string, s: HoldSample) {
    const t = (this.t[key] ??= [0, 0, 0]);
    t[0]++;
    if (s.strict) t[1]++;
    if (s.relaxed) t[2]++;
  }

  phase(ph: Phase, split: string[], s: HoldSample, wel: number, waz: number, tipY: number, ctx: Record<string, unknown>) {
    this.tally(ph, s);
    this.tally('all', s);
    for (const k of split) {
      this.tally(`${ph}|${k}`, s);
      this.tally(`all|${k}`, s);
    }
    this.add(`${ph}:az`, s.az);
    this.add(`${ph}:el`, s.el);
    this.add(`${ph}:wel`, wel);
    this.add(`${ph}:waz`, waz);
    this.add(`${ph}:tipY`, tipY * 100);
    this.add(`${ph}:knobOff`, s.knobOff * 100);
    this.add(`${ph}:over`, Math.max(s.overL, s.overR));
    this.add(`${ph}:miss`, Math.max(s.missL, s.missR) * 100);
    const over = Math.max(s.overL, s.overR) + Math.max(s.missL, s.missR) * 500;
    const list = (this.worst[ph] ??= []);
    if (list.length < 8 || over > list[list.length - 1].over + list[list.length - 1].miss * 500) {
      list.push({ over: Math.max(s.overL, s.overR), miss: Math.max(s.missL, s.missR), az: s.az, el: s.el, wel, ctx });
      list.sort((a, b) => b.over + b.miss * 500 - (a.over + a.miss * 500));
      list.length = Math.min(list.length, 8);
    }
  }

  toJSON() {
    return { h: this.h, t: this.t, worst: this.worst };
  }

  static merge(parts: ReturnType<Hist['toJSON']>[]): Hist {
    const o = new Hist();
    for (const p of parts) {
      for (const [n, b] of Object.entries(p.h)) {
        const d = (o.h[n] ??= {});
        for (const [k, c] of Object.entries(b)) d[k] = (d[k] ?? 0) + c;
      }
      for (const [k, v] of Object.entries(p.t)) {
        const d = (o.t[k] ??= [0, 0, 0]);
        d[0] += v[0];
        d[1] += v[1];
        d[2] += v[2];
      }
      for (const [k, v] of Object.entries(p.worst)) {
        const l = (o.worst[k] ??= []);
        l.push(...v);
        l.sort((a, b) => b.over + b.miss * 500 - (a.over + a.miss * 500));
        l.length = Math.min(l.length, 8);
      }
    }
    return o;
  }

  /** percentiles of a histogram */
  pct(name: string, ps: number[]): number[] {
    const b = this.h[name];
    if (!b) return ps.map(() => NaN);
    const e = Object.entries(b).map(([k, c]) => [+k, c] as [number, number]).sort((a, b) => a[0] - b[0]);
    const n = e.reduce((s, x) => s + x[1], 0);
    return ps.map((p) => {
      const target = p * n;
      let acc = 0;
      for (const [v, c] of e) {
        acc += c;
        if (acc >= target) return v;
      }
      return e[e.length - 1][0];
    });
  }

  range(name: string): [number, number] {
    const b = this.h[name];
    if (!b) return [NaN, NaN];
    const ks = Object.keys(b).map(Number);
    return [Math.min(...ks), Math.max(...ks)];
  }
}

/**
 * Crowd excitement model (pure). The stadium bed follows a smoothed level in 0..1 made of
 *  - a *baseline* from the leverage of the situation (late innings, close score, runners in scoring position, two strikes ...)
 *  - short *pulses* from events (ball in the air, a big hit, a strikeout), which decay back to the baseline
 */
export interface Situation {
  inning: number;
  outs: number;
  balls: number;
  strikes: number;
  score: { home: number; away: number };
  runners: [boolean, boolean, boolean];
}

export function baseline(s: Situation): number {
  let v = 0.2;
  if (s.inning >= 7) v += 0.1;
  if (s.inning >= 9) v += 0.06;
  const diff = Math.abs(s.score.home - s.score.away);
  if (s.inning >= 6 && diff <= 2) v += 0.1;
  else if (diff <= 1) v += 0.04;
  if (s.runners[1] || s.runners[2]) v += 0.12;
  if (s.runners[0] && s.runners[1] && s.runners[2]) v += 0.08;
  if (s.strikes >= 2) v += 0.08;
  if (s.balls >= 3 && s.strikes >= 2) v += 0.05;
  if (s.outs >= 2) v += 0.04;
  return Math.min(0.75, v);
}

interface Pulse {
  amount: number;
  left: number;
}

export class Excitement {
  level = 0.2;
  private pulses: Pulse[] = [];
  private base = 0.2;

  setBaseline(v: number) {
    this.base = v;
  }

  add(amount: number, hold: number) {
    if (this.pulses.length > 24) this.pulses.shift();
    this.pulses.push({ amount, left: hold });
  }

  /** advance by `dt` seconds; returns the current level */
  update(dt: number): number {
    let boost = 0;
    for (const p of this.pulses) {
      p.left -= dt;
      boost += p.amount * Math.min(1, Math.max(0, p.left) / 1.0);
    }
    this.pulses = this.pulses.filter((p) => p.left > 0);
    const target = Math.min(1, Math.max(0.05, this.base + boost));
    // the crowd rises quickly and calms slowly
    const rate = target > this.level ? 1.4 : 0.22;
    this.level += (target - this.level) * Math.min(1, rate * dt);
    return this.level;
  }

  reset() {
    this.pulses = [];
    this.level = this.base;
  }
}

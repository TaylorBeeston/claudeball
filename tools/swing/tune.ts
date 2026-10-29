/**
 * Tunes the swing's shape (src/sim/batting.ts SWING) so two hands can hold the bat on the drawn body: synthetic swings over the zone (a
 * righty; lefties are the mirror image) planned by the real buildSwing, every frame solved like the engine (frames.ts), and an evolution
 * strategy over the free parameters (the start, the follow-through, the hands at contact, the bat's angle at contact within its realistic
 * band). Prints the best parameter set as a SWING literal.
 *   npx tsx tools/swing/tune.ts [--iters 60] [--lambda 12] [--seed 1] [--heights 1.85] [--only load,blendIn]
 */
import path from 'node:path';
import { Holder } from './hold';
import { swingFrames } from './frames';
import { BatSwing, SWING, buildSwing, pivotFor, type SwingObservation } from '../../src/sim/batting';
import { generateTeam } from '../../src/sim/roster';
import { Rng } from '../../src/sim/rng';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

// the free parameters: [getter path, lo, hi, initial step]
const PARAMS: [string, number, number, number][] = [
  ['inStart', 0, 0.6, 0.06],
  ['turnStart', 0, 0.6, 0.06],
  ['blendIn', 0.5, 0.95, 0.06],
  ['rh', 0.1, 0.35, 0.04],
  ['outStart', 1.15, 1.8, 0.1],
  ['finish.dKnob.x', -0.3, 0.2, 0.05],
  ['finish.dKnob.y', -0.4, 0.1, 0.05],
  ['finish.dKnob.z', -0.2, 0.2, 0.05],
  ['finish.dAz', -80, 80, 15],
  ['finish.dEl', -60, 30, 10],
  ['hands.fwd', 0.08, 0.3, 0.03],
  ['hands.lat', 0.15, 0.35, 0.03],
  ['vba.v0', -26, -14, 2],
  ['vba.slope', 30, 50, 4],
];
const only = opt('only', '');
const excl = opt('exclude', '');
const FREE = (only ? PARAMS.filter((p) => only.split(',').some((o) => p[0].startsWith(o))) : PARAMS).filter((p) => !excl || !excl.split(',').some((o) => p[0].startsWith(o)));
const getP = (k: string): number => k.split('.').reduce((o: any, s) => o[s], SWING as any);
const setP = (k: string, v: number) => {
  const ks = k.split('.');
  const o = ks.slice(0, -1).reduce((o: any, s) => o[s], SWING as any);
  o[ks[ks.length - 1]] = v;
};

const team = generateTeam('tune', { side: 'home' });
const batter0 = team.roster.find((p) => p.id === team.lineup[0].playerId)!;
const batter = { ...batter0, ratings: { ...batter0.ratings, contact: 60, power: 55, pull: 50, gap: 50, consistency: 60, clutch: 50 }, traits: { ...batter0.traits, attackAngleDeg: 10, aimBelow: 0 } };
const XS = [-0.22, -0.08, 0.06, 0.2], YS = [0.5, 0.7, 0.9, 1.1];
const HEIGHTS = opt('heights', '1.85').split(',').map(Number);
const ctx = { balls: 1, strikes: 1, outs: 0, runnersOn: false, scoringPosition: false, inning: 1, scoreDiff: 0 };

function plans() {
  const out: { plan: ReturnType<typeof buildSwing>; h: number }[] = [];
  for (const h of HEIGHTS)
    for (const x of XS)
      for (const y of YS) {
        const b = { ...batter, height: h };
        const predictAtZ = (z: number) => ({ t: 0.42 + (0.43 - z) / 38, x, y });
        const obs: SwingObservation = { tDec: 0.25, pivot: pivotFor('R'), front: predictAtZ(0.43), dPerceived: 0, recognised: true, speedMph: 90, predictAtZ };
        out.push({ plan: buildSwing(b as any, 'R', null as any, obs, { swing: true }, ctx, new Rng(`tune-${x}-${y}`), null, 0), h });
      }
  return out;
}

function evaluate(holder: Holder): { cost: number; held: number; byPhase: number[] } {
  let cost = 0, n = 0, held = 0;
  const ph = [0, 0, 0, 0, 0], phn = [0, 0, 0, 0, 0];
  for (const { plan, h } of plans()) {
    swingFrames(holder, new BatSwing(plan), 'R', h, (f) => {
      const s = f.s;
      const c = Math.max(0, s.axisR - 20) + Math.max(0, s.axisL - 20) + 400 * (Math.max(0, s.gripR - 0.02) + Math.max(0, s.gripL - 0.02));
      cost += c;
      n++;
      if (s.held) held++;
      const u = f.tau / plan.tauC, i = f.finish ? 4 : u < 0.4 ? 0 : u < 0.85 ? 1 : u <= 1.15 ? 2 : 3;
      phn[i]++;
      if (s.held) ph[i]++;
    });
  }
  return { cost: cost / n, held: held / n, byPhase: ph.map((v, i) => v / Math.max(1, phn[i])) };
}

async function main() {
  const holder = new Holder();
  await holder.init(HERE);
  const rng = new Rng(opt('seed', '1'));
  const ITERS = +opt('iters', '60'), LAMBDA = +opt('lambda', '12');
  let x = FREE.map(([k]) => getP(k));
  const apply = (v: number[]) => FREE.forEach(([k, lo, hi], i) => setP(k, Math.min(hi, Math.max(lo, v[i]))));
  apply(x);
  let best = evaluate(holder);
  console.log(`start: cost ${best.cost.toFixed(2)} held ${(best.held * 100).toFixed(1)} % by phase ${best.byPhase.map((v) => (v * 100).toFixed(0)).join('/')}`);
  let sigma = 1;
  for (let it = 0; it < ITERS; it++) {
    let improved = false;
    for (let j = 0; j < LAMBDA; j++) {
      const y = x.map((v, i) => v + rng.normal(0, FREE[i][3] * sigma));
      apply(y);
      const r = evaluate(holder);
      if (r.cost < best.cost) {
        best = r;
        x = y.map((v, i) => Math.min(FREE[i][2], Math.max(FREE[i][1], v)));
        improved = true;
      }
    }
    sigma *= improved ? 1.25 : 0.82;
    apply(x);
    console.log(`it ${it}: cost ${best.cost.toFixed(2)} held ${(best.held * 100).toFixed(1)} % by phase ${best.byPhase.map((v) => (v * 100).toFixed(0)).join('/')} sigma ${sigma.toFixed(2)}`);
  }
  apply(x);
  console.log(JSON.stringify(SWING));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

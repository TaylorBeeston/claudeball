/**
 * The bat directions two hands can hold when the hands may move: envelope.ts holds the knob where the clip's top fist has it; here, for each
 * world bat direction, the knob is searched (a grid around the clip's knob, then refined) for the placement with the least past the hands'
 * range, at the clip times of the swing the engine shows. For designing the sim's hand path (a right-handed batter, 1.85 m).
 *   npx tsx tools/swing/free.ts [--times 0.583,0.75,0.917] [--step 10] [--out tools/swing/out/free.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Holder } from './hold';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const TIMES = opt('times', '0.583,0.667,0.75,0.833,0.875,0.917,0.958,1.0,1.083,1.167').split(',').map(Number);
const STEP = +opt('step', '10');
const OUT = opt('out', path.join(HERE, 'tools/swing/out/free.json'));
const AZ = opt('az', '-180,180').split(',').map(Number), EL = opt('el', '-70,70').split(',').map(Number);

async function main() {
  const h = new Holder();
  await h.init(HERE);
  const res: { t: number; az: number; el: number; cost: number; over: number; miss: number; knob: number[]; clipKnob: number[] }[] = [];
  for (const t of TIMES) {
    const ck = h.clipBat(t, 'R', 1.85).knob;
    console.log(`\n## clip t ${t.toFixed(3)} (clip knob ${[ck.x, ck.y, ck.z].map((v) => v.toFixed(2)).join(', ')}): best past-range deg (miss < 2 cm), world az (from +z, + toward the plate's far side = -x for a righty... shown as atan2(x, z)) x el`);
    console.log('el\\az ' + Array.from({ length: Math.floor((AZ[1] - AZ[0]) / STEP) }, (_, i) => String(AZ[0] + i * STEP).padStart(4)).join(''));
    for (let el = EL[1]; el >= EL[0]; el -= STEP) {
      let row = '';
      for (let az = AZ[0]; az < AZ[1]; az += STEP) {
        const ce = Math.cos((el * Math.PI) / 180);
        const d = { x: ce * Math.sin((az * Math.PI) / 180), y: Math.sin((el * Math.PI) / 180), z: ce * Math.cos((az * Math.PI) / 180) };
        const evalAt = (k: { x: number; y: number; z: number }) => {
          const s = h.sample('R', 1.85, k, { x: k.x + d.x * 0.84, y: k.y + d.y * 0.84, z: k.z + d.z * 0.84 }, t);
          const over = Math.max(s.overL, s.overR), miss = Math.max(s.missL, s.missR);
          return { over, miss, cost: over + Math.max(0, miss - 0.02) * 2000 };
        };
        // coarse grid +-30 cm around the clip's knob, 10 cm; then two refinements
        let best = { k: ck, ...evalAt(ck) };
        let span = 0.3, st = 0.1;
        for (let pass = 0; pass < 3; pass++) {
          const c0 = best.k;
          for (let dx = -span; dx <= span + 1e-9; dx += st)
            for (let dy = -span; dy <= span + 1e-9; dy += st)
              for (let dz = -span; dz <= span + 1e-9; dz += st) {
                const k = { x: c0.x + dx, y: c0.y + dy, z: c0.z + dz };
                const r = evalAt(k);
                if (r.cost < best.cost) best = { k, ...r };
              }
          span = st;
          st /= 2.5;
        }
        res.push({ t, az, el, cost: best.cost, over: best.over, miss: best.miss, knob: [best.k.x, best.k.y, best.k.z], clipKnob: [ck.x, ck.y, ck.z] });
        row += best.miss >= 0.02 ? '   x' : String(Math.round(best.over)).padStart(4);
      }
      console.log(`${String(el).padStart(4)}  ${row}`);
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(res));
  console.log(`[free] wrote ${OUT}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Per 60 Hz frame of the swing (k from its start), the holdability proxy (hold.ts, the engine's tracked solve) on each fist: degrees past the
 * hand's range and the grip axis off the bat, and how far the bat turns frame to frame in the drawn body's shoulder frame. Where the top fist
 * runs out of range the game's IK rolls it on the handle (flip:RightHand / spike:RightHand at those frames in a batter trace).
 *   SWING_IKW1=1 SWING_TOP_SUP=130 npx tsx tools/swing/perframe.ts --cache plans.json [--n 150] [--swing '<SWING overrides, JSON>']
 * (the engine as it is since t-0026: grip at once, top hand 130 deg; plans.json from tools/swing/steps.ts --cache)
 */
import fs from 'node:fs';
import { Holder } from './hold';
import { swingFrames } from './frames';
import { BatSwing, SWING } from '../../src/sim/batting';
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const deep = (o: any, v: any) => { for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') deep(o[k], v[k]); else o[k] = v[k]; };
if (opt('swing', '')) deep(SWING, JSON.parse(opt('swing', '{}')));
const plans = JSON.parse(fs.readFileSync(opt('cache', ''), 'utf8')).slice(0, +opt('n', '150'));
const q = (a: number[], p: number) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
(async () => {
  const h = new Holder();
  await h.init(process.cwd());
  const rows: Record<string, number[]>[] = Array.from({ length: 14 }, () => ({ overR: [], axisR: [], overL: [], axisL: [], daz: [], del: [] }));
  for (const p of plans) {
    const st = p.sgn > 0 ? 'R' : 'L';
    const fr = swingFrames(h, new BatSwing(p), st, 1.85 * p.scale);
    for (let k = 0; k < 14 && k < fr.length; k++) {
      const s = fr[k].s, r = rows[k];
      r.overR.push(s.overR); r.axisR.push(s.axisR); r.overL.push(s.overL); r.axisL.push(s.axisL);
      if (k) { r.daz.push(Math.abs(((s.az - fr[k - 1].s.az + 540) % 360) - 180)); r.del.push(Math.abs(s.el - fr[k - 1].s.el)); }
    }
  }
  console.log('k | top past range p50/p90 | top axis p50/p90 | bottom past p50/p90 | bottom axis p50/p90 | shoulder-frame d az p50/p90 | d el p50/p90');
  rows.forEach((r, k) => console.log(k, '|', ...['overR', 'axisR', 'overL', 'axisL', 'daz', 'del'].map((n) => `${q(r[n], 0.5)?.toFixed(0)}/${q(r[n], 0.9)?.toFixed(0)} |`)));
})();

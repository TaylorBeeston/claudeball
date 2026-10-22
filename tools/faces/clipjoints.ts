/**
 * Joint ranges of chosen clips in any player GLB (also an armature-only export), measured exactly like tools/jank's static sweep
 * (src/engine/pose/limits.ts): per clip and limit, the frames over the limit and the largest excess, plus the range of each named angle.
 *   npx tsx tools/faces/clipjoints.ts <a.glb> [b.glb] [--clips batting_stance,swing] [--keys forearmL.pron,wristL.swing] [--step 0.0333]
 * With two files the rows are printed side by side (before / after a rebake).
 */
import { loadRig, sampleClip } from '../jank/glb';
import { fk } from '../../src/engine/pose/skeleton';
import { restInfo, measureJoints, JOINT_LIMITS, excess } from '../../src/engine/pose/limits';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const clips = opt('clips', 'batting_stance,swing').split(',');
const keys = opt('keys', 'forearmL.pron,forearmR.pron,wristL.swing,wristR.swing').split(',');
const step = +opt('step', String(1 / 30));

interface Row { frames: number; over: Record<string, { n: number; max: number }>; range: Record<string, [number, number]> }
async function measure(file: string): Promise<Map<string, Row>> {
  const rig = await loadRig(file);
  const rw = fk(rig.rest);
  fk(rig.rest, rw, rw);
  const R = restInfo(rw);
  const out = new Map<string, Row>();
  for (const name of clips) {
    const clip = rig.clips.get(name);
    if (!clip) continue;
    const row: Row = { frames: 0, over: {}, range: {} };
    for (let t = 0; t <= clip.duration + 1e-6; t += step) {
      const w = fk(sampleClip(clip, t, rig.rest), undefined, R.rest);
      const j = measureJoints(w, R);
      row.frames++;
      for (const l of JOINT_LIMITS) {
        const e = excess(l, j[l.key] ?? 0);
        if (e <= 0) continue;
        const o = (row.over[l.key] ??= { n: 0, max: 0 });
        o.n++;
        o.max = Math.max(o.max, e);
      }
      for (const k of keys) {
        const r = (row.range[k] ??= [Infinity, -Infinity]);
        r[0] = Math.min(r[0], j[k]);
        r[1] = Math.max(r[1], j[k]);
      }
    }
    out.set(name, row);
  }
  return out;
}

const res = await Promise.all(files.map(measure));
const f1 = (v: number) => v.toFixed(1);
for (const name of clips) {
  const rows = res.map((m) => m.get(name));
  if (!rows[0]) continue;
  console.log(`\n${name} (${rows[0].frames} frames)${files.length > 1 ? '   before | after' : ''}`);
  for (const k of keys) console.log(`  ${k.padEnd(16)} ${rows.map((r) => (r ? `${f1(r.range[k][0])} .. ${f1(r.range[k][1])}` : '-').padEnd(18)).join(' | ')}`);
  const lim = new Set(rows.flatMap((r) => (r ? Object.keys(r.over) : [])));
  for (const k of lim) console.log(`  over ${k.padEnd(16)} ${rows.map((r) => (r?.over[k] ? `${r.over[k].n} fr, max +${f1(r.over[k].max)}` : 'in range').padEnd(18)).join(' | ')}`);
  if (!lim.size) console.log('  every joint in range');
}

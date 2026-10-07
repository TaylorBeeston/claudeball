/**
 * Reads `bodyprobe.ts` samples and lists the frames whose skeleton looks wrong, worst first, per kind of violation:
 *   len      a bone longer / shorter than at rest (> 3 %)
 *   reach    the hand further from the shoulder than the arm can reach (> 1.0 of upper + fore arm), i.e. a stretched IK target
 *   hyper    an elbow / knee bent backwards (flexion against the joint's own direction, < -8 deg)
 *   offaxis  an elbow / knee bent sideways or twisted (> 40 deg off its hinge)
 *   wrist    a wrist bent > 75 deg;  wristTwist  the hand twisted > 80 deg about the forearm (candy-wrapper wrist)
 *   foreTwist  the forearm twisted > 100 deg about its own axis at the elbow
 *   neck     neck + head turned / bent > 95 deg from the upper spine
 *   head     a hand inside the head (< 0.11 m from its centre)
 * The hinge direction of each joint is learnt from the samples themselves (the angle-weighted mean axis, sign-aligned).
 *
 *   npx tsx tools/visual/bodyprobe-report.ts DIR/samples.jsonl [--top 12] [--json out.json]
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const file = argv[0];
const top = +(argv[argv.indexOf('--top') + 1] ?? 12) || 12;
type Rec = { t: number; id: string; hand: string; anim: string; clip: string; ikW: number; clear: number | null; scale: number; len: Record<string, number>; rot: Record<string, number[]>; reachL: number; reachR: number; headL: number; headR: number };
const recs: Rec[] = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const HINGES = ['LeftForeArm', 'RightForeArm', 'LeftLeg', 'RightLeg'];

// hinge axis per joint: the angle-weighted mean of the rotation axes, sign-aligned to the first big one
const dom: Record<string, number[]> = {};
for (const j of HINGES) {
  let ref: number[] | null = null;
  const acc = [0, 0, 0];
  for (const r of recs) {
    const v = r.rot[j] && swingOnly(r.rot[j]);
    if (!v || v[0] < 15) continue;
    const a = v.slice(1);
    if (!ref) ref = a;
    const s = a[0] * ref[0] + a[1] * ref[1] + a[2] * ref[2] < 0 ? -1 : 1;
    for (let k = 0; k < 3; k++) acc[k] += s * a[k] * v[0];
  }
  const n = Math.hypot(...acc) || 1;
  dom[j] = acc.map((x) => x / n);
}

/** swing (bend) and twist (about the bone, local +Y) of an axis-angle rotation in the joint's rest frame, degrees */
/** the swing part (rotation with the twist about local +Y removed) as [angle deg, axis] */
function swingOnly(v: number[]): number[] {
  const a = (v[0] * Math.PI) / 180;
  const s = Math.sin(a / 2);
  const q = [v[1] * s, v[2] * s, v[3] * s, Math.cos(a / 2)];
  const tw = 2 * Math.atan2(q[1], q[3]);
  const ht = -tw / 2;
  // q * twist^-1, twist^-1 = (0, sin(-tw/2), 0, cos(-tw/2))
  const [x, y, z, w] = q, ty = Math.sin(ht), tww = Math.cos(ht);
  const r = [x * tww - z * ty, y * tww + w * ty, z * tww + x * ty, w * tww - y * ty];
  if (r[3] < 0) for (let k = 0; k < 4; k++) r[k] = -r[k];
  const ang = 2 * Math.acos(Math.min(1, r[3]));
  const sn = Math.sqrt(Math.max(1e-12, 1 - r[3] * r[3]));
  return [(ang * 180) / Math.PI, r[0] / sn, r[1] / sn, r[2] / sn];
}
function swingTwist(v: number[]): { swing: number; twist: number } {
  const a = (v[0] * Math.PI) / 180;
  const s = Math.sin(a / 2);
  const q = [v[1] * s, v[2] * s, v[3] * s, Math.cos(a / 2)];
  const tw = 2 * Math.atan2(q[1], q[3]);
  const twist = ((((tw * 180) / Math.PI + 540) % 360) - 180);
  // swing = q * twist^-1: its angle
  const ht = tw / 2;
  const t = [0, Math.sin(ht), 0, Math.cos(ht)];
  const w = q[3] * t[3] + q[0] * t[0] + q[1] * t[1] + q[2] * t[2];
  const swing = (2 * Math.acos(Math.min(1, Math.abs(w))) * 180) / Math.PI;
  return { swing, twist };
}

type Hit = { kind: string; v: number; r: Rec; what: string };
const hits: Hit[] = [];
for (const r of recs) {
  for (const [b, x] of Object.entries(r.len)) if (Math.abs(x - 1) > 0.03) hits.push({ kind: 'len', v: Math.abs(x - 1), r, what: `${b} x${x}` });
  for (const s of ['L', 'R'] as const) {
    const re = r[`reach${s}`];
    if (re > 1.0) hits.push({ kind: 'reach', v: re - 1, r, what: `${s} ${re}` });
    const hd = r[`head${s}`];
    if (hd < 0.11) hits.push({ kind: 'head', v: 0.11 - hd, r, what: `${s} ${hd} m` });
  }
  for (const j of HINGES) {
    const v = r.rot[j] && swingOnly(r.rot[j]);
    if (!v) continue;
    const a = v.slice(1);
    const c = a[0] * dom[j][0] + a[1] * dom[j][1] + a[2] * dom[j][2];
    const flex = v[0] * c;
    const off = v[0] * Math.sqrt(Math.max(0, 1 - c * c));
    if (flex < -8) hits.push({ kind: 'hyper', v: -flex, r, what: `${j} flex ${flex.toFixed(0)}` });
    if (off > 40) hits.push({ kind: 'offaxis', v: off, r, what: `${j} off ${off.toFixed(0)} (flex ${flex.toFixed(0)})` });
  }
  for (const j of ['LeftHand', 'RightHand']) {
    if (!r.rot[j]) continue;
    const st = swingTwist(r.rot[j]);
    if (st.swing > 75) hits.push({ kind: 'wrist', v: st.swing, r, what: `${j} bend ${st.swing.toFixed(0)} twist ${st.twist.toFixed(0)}` });
    if (Math.abs(st.twist) > 80) hits.push({ kind: 'wristTwist', v: Math.abs(st.twist), r, what: `${j} twist ${st.twist.toFixed(0)} (bend ${st.swing.toFixed(0)})` });
  }
  for (const j of ['LeftForeArm', 'RightForeArm']) {
    if (!r.rot[j]) continue;
    const st = swingTwist(r.rot[j]);
    if (Math.abs(st.twist) > 100) hits.push({ kind: 'foreTwist', v: Math.abs(st.twist), r, what: `${j} twist ${st.twist.toFixed(0)} (bend ${st.swing.toFixed(0)})` });
  }
  const nh = (r.rot.Neck?.[0] ?? 0) + (r.rot.Head?.[0] ?? 0);
  if (nh > 95) hits.push({ kind: 'neck', v: nh, r, what: `neck+head ${nh.toFixed(0)}` });
}

const frames = new Set(recs.map((r) => `${r.t}|${r.id}`)).size;
console.log(`[bodyprobe] ${recs.length} samples, ${frames} puppet-frames, ${new Set(recs.map((r) => r.id)).size} players, game t ${recs[0]?.t}-${recs[recs.length - 1]?.t} s`);
console.log(`hinge axes: ${Object.entries(dom).map(([k, v]) => `${k} (${v.map((x) => x.toFixed(2)).join(', ')})`).join('; ')}`);
const out: Record<string, unknown> = {};
for (const kind of ['len', 'reach', 'hyper', 'offaxis', 'wrist', 'wristTwist', 'foreTwist', 'neck', 'head']) {
  const h = hits.filter((x) => x.kind === kind);
  const byClip = new Map<string, number>();
  for (const x of h) byClip.set(`${x.r.anim}->${x.r.clip}`, (byClip.get(`${x.r.anim}->${x.r.clip}`) ?? 0) + 1);
  console.log(`\n== ${kind}: ${h.length} frames (${((100 * h.length) / Math.max(1, frames)).toFixed(2)} %)  by hint->clip: ${[...byClip].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  // worst, one per (player, second) so a long violation is listed once
  const seen = new Set<string>();
  const worst = h.sort((a, b) => b.v - a.v).filter((x) => {
    const k = `${x.r.id}|${Math.round(x.r.t)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, top);
  for (const x of worst) console.log(`  t ${x.r.t.toFixed(2)} ${x.r.id} (${x.r.hand}) ${x.r.anim}->${x.r.clip} ikW ${x.r.ikW} clear ${x.r.clear}: ${x.what}`);
  out[kind] = worst.map((x) => ({ t: x.r.t, id: x.r.id, hand: x.r.hand, anim: x.r.anim, clip: x.r.clip, ikW: x.r.ikW, what: x.what }));
}
const j = argv.indexOf('--json');
if (j >= 0) fs.writeFileSync(argv[j + 1], JSON.stringify(out, null, 1));

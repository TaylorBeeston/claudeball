/** One play of a tools/fly/turn.ts run, frame by frame: npx tsx tools/fly/rows.ts <dir>/<name>.json [from=-0.6] [to=1.6] [every=1] */
import fs from 'node:fs';
const [f, a = '-0.6', b = '1.6', ev = '1'] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(f, 'utf8'));
const T = d.play.t;
d.rows.forEach((r: any, i: number) => {
  const dt = r.t - T;
  if (dt < +a || dt > +b || i % +ev) return;
  const v = (r.v ?? []).filter((x: string) => x.startsWith('foot:')).map((x: string) => x.replace('foot:', '')).join(' ');
  console.log(`${dt >= 0 ? '+' : ''}${dt.toFixed(3)} ${String(r.anim).padEnd(16)} ${String(r.clip).padEnd(22)} face ${r.facing.toFixed(2).padStart(6)} yaw ${r.yaw.toFixed(2).padStart(6)} v ${r.speed.toFixed(2)} ${r.ball ? 'B' : '-'} sh ${Math.hypot(r.rx - r.sx, r.rz - r.sz).toFixed(2)} L${r.locked.map(Number).join('')} ${r.gt ? `gt ${Math.hypot(r.gt[0] - r.sx, r.gt[2] - r.sz).toFixed(2)}@${r.gt[1].toFixed(2)} in ${(r.catchIn ?? -1).toFixed(2)}` : ''} ${r.pk ? `pk ${Math.hypot(r.pk[0] - r.sx, r.pk[2] - r.sz).toFixed(2)}@${r.pk[1].toFixed(2)} w ${r.gw.toFixed(2)}` : ''} ${v}`);
});

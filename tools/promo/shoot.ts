/**
 * Capture one shot from a JSON spec (or a shot id from shots.ts) and make a contact sheet: for trying camera moves and checking fixes.
 *
 *   npx tsx tools/promo/shoot.ts '{"id":"t","seed":43,"tod":"night","start":4070,"anchor":4072,"dur":4,"camera":{...}}' [--every 0.25] [--size 960x540] [--fps 30] [--audio] [--hud] [--no-build]
 *   npx tsx tools/promo/shoot.ts <shot id> ...
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build, startPreview } from '../perf/lib';
import { PROMO_DIR, buildKey, captureShot, openChrome, shotDir, type PromoShot, type RenderSettings } from './capture';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
let shot: PromoShot;
if (argv[0].trim().startsWith('{')) shot = JSON.parse(argv[0]);
else {
  const { SHOTS } = await import('./shots');
  shot = SHOTS.find((s) => s.id === argv[0])!;
  if (!shot) throw new Error(`no shot ${argv[0]}`);
}
if (argv.includes('--audio')) shot.audio = true;
else if (shot.audio === undefined) shot.audio = false;
if (argv.includes('--hud')) shot.hud = true;
build(argv.includes('--no-build'));
const [w, h] = opt('size', '960x540').split('x').map(Number);
const rs: RenderSettings = { width: w, height: h, dpr: 1, fps: +opt('fps', '30'), format: 'jpeg', quality: 90, buildKey: buildKey() };
const srv = await startPreview();
const chrome = await openChrome(rs);
try {
  const m = await captureShot(chrome, srv.url, shot, rs);
  const dir = shotDir(shot.id, rs);
  const every = Math.max(1, Math.round(+opt('every', '0.25') * rs.fps));
  const args: string[] = [];
  for (let i = 0; i < m.frames; i += every) args.push('-label', `${(i / rs.fps).toFixed(2)}s sim ${m.info[i].sim.toFixed(2)}`, path.join(dir, `${String(i).padStart(5, '0')}.${m.ext}`));
  const out = path.join(PROMO_DIR, 'sheets', `${shot.id}.jpg`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('montage', [...args, '-tile', '6x', '-geometry', '400x225+3+3', '-pointsize', '13', '-background', '#111', '-fill', '#eee', out]);
  console.log('[shoot] sheet', out);
  if (m.speech.length) console.log('[shoot] speech', JSON.stringify(m.speech.map((s) => [s.t, (s.ev as { type: string; text?: string }).text ?? (s.ev as { type: string }).type])));
} finally {
  await chrome.close();
  srv.stop();
}

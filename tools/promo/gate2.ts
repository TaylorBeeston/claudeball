/** Gate 2 (and a smoke test of the capture): one short shot, frames saved; prints per-frame sim time and whether frames differ. */
import fs from 'node:fs';
import path from 'node:path';
import { build, startPreview } from '../perf/lib';
import { buildKey, captureShot, openChrome, shotDir, type PromoShot, type RenderSettings } from './capture';
const audio = process.argv.includes('--audio');
build(process.argv.includes('--no-build'));
const rs: RenderSettings = { width: 960, height: 540, dpr: 1, fps: 30, format: 'jpeg', quality: 92, buildKey: buildKey() };
const shot: PromoShot = {
  id: 'gate2', seed: 40, tod: 'night', start: 618.6, anchor: 619.79, dur: 3, audio, preroll: 6,
  camera: { mode: 'path', keys: [
    { t: 0, pos: [1.2, 1.0, -4.5], look: [0, 1.0, 6], fov: 30, aperture: 0.4, focus: { at: 'batter', off: [0, 1.2, 0] } },
    { t: 3, pos: [-0.6, 1.3, -3.6], look: [0, 1.6, 10], fov: 34, aperture: 0.4, focus: { at: 'batter', off: [0, 1.2, 0] } },
  ] },
};
const s = await startPreview();
const chrome = await openChrome(rs);
try {
  const m = await captureShot(chrome, s.url, shot, rs);
  console.log(m.info.map((f) => `${f.i}:${f.sim.toFixed(3)}:${f.shot}:${f.events.join('+')}`).join(' '));
  const dir = shotDir(shot.id, rs);
  const sizes = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).map((f) => fs.statSync(path.join(dir, f)).size);
  console.log('sizes', sizes.join(' '));
} finally {
  await chrome.close();
  s.stop();
}

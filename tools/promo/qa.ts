/**
 * QA sweeps for the promo: the real broadcast (director cameras, HUD, replays, B-roll) around scouted moments, a picture every
 * `--every` seconds, labelled contact sheets per sweep (shot name + sim time) for frame-by-frame review.
 *
 *   npx tsx tools/promo/qa.ts --spans 40:600:90:night,30:3900:120:day [--every 0.5] [--size 960x540] [--hud 1] [--out DIR] [--no-build]
 *   (seed:startSimTime:seconds:tod)
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
const every = +opt('every', '0.5');
const [w, h] = opt('size', '960x540').split('x').map(Number);
const out = opt('out', path.join(PROMO_DIR, 'qa'));
build(argv.includes('--no-build'));
const fps = 30;
const rs: RenderSettings = { width: w, height: h, dpr: 1, fps, format: 'jpeg', quality: 88, buildKey: buildKey(), stride: Math.max(1, Math.round(every * fps)) };
const spans = opt('spans', '40:600:60:night').split(',').map((s) => {
  const [seed, start, dur, tod, extra] = s.split(':');
  return { seed: +seed, start: +start, dur: +dur, tod: (tod ?? 'day') as 'day', extra };
});
const srv = await startPreview();
const chrome = await openChrome(rs);
try {
  for (const sp of spans) {
    const id = `qa-${sp.seed}-${sp.start}-${sp.tod}`;
    const shot: PromoShot = { id, seed: sp.seed, tod: sp.tod, start: sp.start, anchor: sp.start, dur: sp.dur, audio: false, hud: opt('hud', '1') === '1', preroll: +opt('preroll', '20'), camera: { mode: 'director', replays: true, broll: true } };
    const m = await captureShot(chrome, srv.url, shot, rs);
    const dir = shotDir(id, rs);
    // blocked views: the park between the camera and its subject (a list per shot kind, for the jank log)
    const blocked = m.info.filter((f) => f.occ);
    const byShot = new Map<string, number>();
    for (const f of blocked) byShot.set(`${f.shot} <- ${f.occ!.hit}`, (byShot.get(`${f.shot} <- ${f.occ!.hit}`) ?? 0) + 1);
    console.log(`[qa] ${id}: ${blocked.length}/${m.info.length} sampled frames blocked`);
    for (const [k, n] of byShot) console.log(`   ${n} x ${k}  e.g. ${JSON.stringify(blocked.find((f) => `${f.shot} <- ${f.occ!.hit}` === k)!.occ)}`);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify(m.info.filter((f, i) => i % (rs.stride ?? 1) === 0), null, 0));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    fs.mkdirSync(out, { recursive: true });
    // sheets of 24 (6x4) labelled with the frame's sim time and the director's shot
    for (let s0 = 0; s0 < files.length; s0 += 24) {
      const args: string[] = [];
      for (const f of files.slice(s0, s0 + 24)) {
        const i = +f.slice(0, 5);
        const fi = m.info[i];
        args.push('-label', `${fi.sim.toFixed(1)} ${fi.shot}${fi.events.length ? ' ' + fi.events.slice(0, 3).join(',') : ''}${fi.occ ? ` BLOCKED:${fi.occ.hit}@${fi.occ.at}/${fi.occ.dist}` : ''}`, path.join(dir, f));
      }
      const sheet = path.join(out, `${id}-${String(s0 / 24).padStart(2, '0')}.jpg`);
      execFileSync('montage', [...args, '-tile', '6x', '-geometry', '400x225+3+3', '-pointsize', '13', '-background', '#111', '-fill', '#eee', sheet]);
      console.log('[qa] sheet', sheet);
    }
  }
} finally {
  await chrome.close();
  srv.stop();
}

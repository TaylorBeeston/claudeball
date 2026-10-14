/**
 * The promo, end to end: `npm run promo:render [-- options]`
 *
 *   1. capture   every shot in shots.ts, frame by frame in headed Chrome on the real GPU, with its game audio (cached per shot by content hash)
 *   2. sheets    a contact sheet per shot (QA)
 *   3. titles    the typography / caption / end-card layer (transparent PNGs), music bed, mix, edit, encodes (see edit.ts, titles.ts, music.ts, mix.ts)
 *
 * Options: --preview (960x540, 30 fps), --4k (3840x2160: the 1920x1080 viewport at device scale 2), --vertical (the 9:16 cut),
 *          --only id,id (capture just these), --stages capture,sheets,... , --force (ignore the cache), --no-build
 * Everything goes to ~/claudeball-promo/ (CB_PROMO_DIR); nothing is written into the repo.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build, startPreview, systemLoad } from '../perf/lib';
import { PROMO_DIR, buildKey, cached, captureShot, openChrome, shotDir, type RenderSettings, type ShotManifest } from './capture';
import { SHOTS } from './shots';
import { buildPicture, encode, fillOverlay, layout, mix, overlayList } from './assemble';
import { BEAT, CUTS, cutTimes } from './edit';
import type { Overlay } from './overlay';
import { renderOverlay } from './titles';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k: string) => argv.includes(`--${k}`);

export function settings(): RenderSettings {
  if (flag('preview')) return { width: 960, height: 540, dpr: 1, fps: 30, format: 'jpeg', quality: 90, buildKey: '' };
  if (flag('4k')) return { width: 1920, height: 1080, dpr: 2, fps: 60, format: 'jpeg', quality: 95, buildKey: '' };
  return { width: 1920, height: 1080, dpr: 1, fps: 60, format: 'jpeg', quality: 95, buildKey: '' };
}

const log = (s: string) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
  console.log(line);
  fs.appendFileSync(path.join(PROMO_DIR, 'render.log'), line + '\n');
};

async function capture(rs: RenderSettings): Promise<Map<string, ShotManifest>> {
  const only = opt('only', '').split(',').filter(Boolean);
  const todo = SHOTS.filter((s) => (!only.length || only.includes(s.id)) && (flag('force') || !cached(s, rs)));
  const out = new Map<string, ShotManifest>();
  for (const s of SHOTS) {
    const m = cached(s, rs);
    if (m) out.set(s.id, m);
  }
  if (!todo.length) {
    log(`[render] capture: all ${SHOTS.length} shots cached`);
    return out;
  }
  const load = systemLoad();
  log(`[render] capture: ${todo.length} of ${SHOTS.length} shots (${rs.width * rs.dpr}x${rs.height * rs.dpr} @ ${rs.fps}) | GPU ${load.gpu} | load ${load.loadavg.join(' ')}`);
  const srv = await startPreview();
  let chrome = await openChrome(rs);
  try {
    for (const s of todo) {
      try {
        out.set(s.id, await captureShot(chrome, srv.url, s, rs, log));
      } catch (e) {
        log(`[render] ${s.id} FAILED: ${(e as Error).message.split('\n')[0]}`);
        // a crashed tab / browser: start a fresh one for the next shot
        await chrome.close().catch(() => {});
        chrome = await openChrome(rs);
      }
    }
  } finally {
    await chrome.close();
    srv.stop();
  }
  return out;
}

function sheets(rs: RenderSettings, shots: Map<string, ShotManifest>) {
  const dir = path.join(PROMO_DIR, 'sheets');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, m] of shots) {
    const sd = shotDir(id, rs);
    const n = Math.min(24, m.frames);
    const args: string[] = [];
    for (let k = 0; k < n; k++) {
      const i = Math.round((k * (m.frames - 1)) / Math.max(1, n - 1));
      const f = m.info[i];
      args.push('-label', `${(i / m.fps).toFixed(2)}s ${f.sim.toFixed(2)} ${f.shot}`, path.join(sd, `${String(i).padStart(5, '0')}.${m.ext}`));
    }
    const out = path.join(dir, `${id}.jpg`);
    execFileSync('montage', [...args, '-tile', '6x', '-geometry', '400x225+3+3', '-pointsize', '13', '-background', '#111', '-fill', '#eee', out]);
  }
  log(`[render] sheets -> ${dir}`);
}

/** what the booth said in the cuts that quote it (the captured lines, timed to the edit) */
function quotes(shots: Map<string, ShotManifest>): Overlay[] {
  const { starts } = cutTimes();
  const out: Overlay[] = [];
  CUTS.forEach((c, i) => {
    if (!c.quote) return;
    const m = shots.get(c.shot);
    const dur = c.beats * BEAT;
    for (const s of m?.speech ?? []) {
      const ev = s.ev as { type: string; text?: string; name?: string; speaker?: string; channel?: string; expectedDurationMs?: number };
      if (ev.type !== 'speechStart' || ev.channel !== 'booth' || s.t < c.in - 0.3 || s.t > c.in + dur - 0.4) continue;
      const t0 = Math.max(starts[i], starts[i] + s.t - c.in);
      out.push({ k: 'quote', t0, t1: Math.min(starts[i] + dur + 2.5, t0 + Math.max(1.6, (ev.expectedDurationMs ?? 2000) / 1000 + 0.4)), who: ev.name ?? 'Booth', role: ev.speaker === 'color' ? 'analyst' : 'play-by-play', text: `\u201c${ev.text}\u201d` });
    }
  });
  return out;
}

async function main() {
  fs.mkdirSync(PROMO_DIR, { recursive: true });
  build(flag('no-build'));
  const rs = { ...settings(), buildKey: buildKey() };
  const stages = opt('stages', 'capture,sheets,titles,mix,picture,encode').split(',');
  const shots = await capture(rs);
  if (stages.includes('sheets')) sheets(rs, shots);
  const tag = flag('preview') ? 'preview' : flag('4k') ? '4k' : '1080p';
  const out = path.join(PROMO_DIR, 'edit', tag);
  fs.mkdirSync(out, { recursive: true });
  const L = layout(rs);
  const ovl = path.join(out, 'ovl');
  if (stages.includes('titles')) {
    const chrome = await openChrome(rs);
    try {
      const has = await renderOverlay(chrome, [...overlayList(L), ...quotes(shots)], L.W, L.H, L.fps, L.frames, ovl, log);
      fillOverlay(L, has, ovl);
    } finally {
      await chrome.close();
    }
  }
  if (stages.includes('mix')) mix(rs, shots, out, log);
  const pic = stages.includes('picture') ? buildPicture(rs, shots, L, out, log) : path.join(out, 'pic');
  if (stages.includes('encode')) {
    const file = path.join(PROMO_DIR, flag('preview') ? 'promo-preview-540p30.mp4' : flag('4k') ? 'promo-16x9-2160p60.mp4' : 'promo-16x9-1080p60.mp4');
    encode(L, pic, ovl, path.join(out, 'master.wav'), file, { bitrate: flag('preview') ? '6M' : flag('4k') ? '60M' : '20M', preview: flag('preview') }, log);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

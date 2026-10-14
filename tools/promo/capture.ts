/**
 * Frame-by-frame capture of one promo shot in a real headed Chrome on the real GPU (the perf tools' launcher), through the in-game
 * runtime `src/promo/runtime.ts` (`?promo`): seek, pre-roll, then per frame `__promo.frame()` + `Page.captureScreenshot`.
 * Frames are cached in ~/claudeball-promo/cache/<shot>/ with a manifest and a content hash (shot spec + render settings + the build), so a
 * re-run only redoes shots whose hash changed. The shot's game audio (rendered offline in the same pass) is saved as audio.wav.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { writeWav } from '../audio/render';
import { ROOT, launchChrome, type Chrome } from '../perf/lib';
import type { ShotSetup } from '../../src/promo/runtime';

export const PROMO_DIR = process.env.CB_PROMO_DIR ?? path.join(os.homedir(), 'claudeball-promo');

export interface PromoShot extends Omit<ShotSetup, 'fps' | 'frames' | 'randomSeed' | 'audioPreroll' | 'preroll' | 'hud' | 'audio'> {
  seed: number;
  tempo?: 'quick' | 'standard' | 'broadcast';
  /** seconds of output */
  dur: number;
  preroll?: number;
  audioPreroll?: number;
  hud?: boolean;
  audio?: boolean;
  randomSeed?: number;
  /** what the shot is for (shot list) */
  note?: string;
  /** output-second ranges whose frames are saved (the rest are played but not grabbed): set from the edit for full-size renders */
  keep?: [number, number][];
  /** a portrait shot (the vertical cut): the render settings' viewport turned on its side */
  portrait?: boolean;
  /** a viewport of its own (CSS px and device scale), e.g. a phone's 412x892 @ 2.625, whatever the render settings */
  viewport?: { w: number; h: number; dpr: number };
  /** a touch device (mobile emulation, coarse pointer: the phone policies of the game apply) */
  touch?: boolean;
  quality?: 'low' | 'medium' | 'high' | 'ultra';
}

export interface RenderSettings {
  /** CSS viewport and device scale factor: 1920x1080@1 (1080p), 1920x1080@2 (4K), 960x540@1 (preview); portrait shots swap */
  width: number;
  height: number;
  dpr: number;
  fps: number;
  /** jpeg quality (png = lossless) */
  format: 'jpeg' | 'png';
  quality: number;
  /** the build the frames come from (dist bundle names carry content hashes) */
  buildKey: string;
  /** QA sweeps: tick `stride` frames per saved picture (the game still runs at `fps`) */
  stride?: number;
}

export interface ShotManifest {
  id: string;
  hash: string;
  frames: number;
  fps: number;
  size: [number, number];
  ext: string;
  gpu: string;
  info: { i: number; sim: number; speed: number; shot: string; replay: boolean; events: string[]; occ?: { hit: string; at: number; dist: number; cam: number[]; tgt: number[] } | null }[];
  audio: { file: string; sr: number; t0: number } | null;
  speech: { t: number; ev: unknown }[];
  at: string;
  ms: number;
}

export function buildKey(dist = path.join(ROOT, 'dist')): string {
  const b = path.join(dist, 'bundle');
  const names = fs.existsSync(b) ? fs.readdirSync(b).filter((f) => /\.(js|css)$/.test(f)).sort() : [];
  return crypto.createHash('sha1').update(names.join(',')).digest('hex').slice(0, 12);
}

export function shotHash(shot: PromoShot, rs: RenderSettings): string {
  return crypto.createHash('sha1').update(JSON.stringify({ shot, rs })).digest('hex').slice(0, 16);
}

export function shotDir(id: string, rs: RenderSettings) {
  return path.join(PROMO_DIR, 'cache', `${rs.width * rs.dpr}x${rs.height * rs.dpr}@${rs.fps}`, id);
}

export function cached(shot: PromoShot, rs: RenderSettings): ShotManifest | null {
  const f = path.join(shotDir(shot.id, rs), 'manifest.json');
  if (!fs.existsSync(f)) return null;
  const m = JSON.parse(fs.readFileSync(f, 'utf8')) as ShotManifest;
  return m.hash === shotHash(shot, rs) ? m : null;
}

const fromB64 = (s: string) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
};

/** one Chrome for many shots: the persistent profile keeps the HD voice model in its cache */
export async function openChrome(rs: RenderSettings): Promise<Chrome> {
  return launchChrome({ width: Math.min(rs.width, 1920), height: Math.min(rs.height, 1080), profile: path.join(PROMO_DIR, 'chrome-profile'), uncapped: true });
}

export async function captureShot(chrome: Chrome, url: string, shot: PromoShot, rs: RenderSettings, log: (s: string) => void = console.log): Promise<ShotManifest> {
  const hash = shotHash(shot, rs);
  const dir = shotDir(shot.id, rs);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const page: Page = await chrome.ctx.newPage();
  const cdp: CDPSession = await chrome.ctx.newCDPSession(page);
  const [w, h, dpr] = shot.viewport ? [shot.viewport.w, shot.viewport.h, shot.viewport.dpr] : shot.portrait ? [rs.height, rs.width, rs.dpr] : [rs.width, rs.height, rs.dpr];
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: !!shot.touch });
  if (shot.touch) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
    if (/\[promo|\[audio\]/.test(m.text())) log(`   [page] ${m.text().slice(0, 200)}`);
  });
  const q = new URLSearchParams({ promo: '1', autostart: '1', noaudio: '1', seed: String(shot.seed), tempo: shot.tempo ?? 'standard', tod: shot.tod, quality: shot.quality ?? 'ultra', subtitles: 'off' });
  await page.goto(`${url}?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window as unknown as { __promo?: unknown }).__promo, null, { timeout: 300000 });
  try {
    if (shot.audio !== false) {
      const v = await page.evaluate(() => (window as unknown as { __promo: { voices(): Promise<string> } }).__promo.voices());
      if (v !== 'ready') throw new Error(`HD voices: ${v}`);
    }
    const setup: ShotSetup = {
      ...shot,
      fps: rs.fps,
      frames: Math.round(shot.dur * rs.fps),
      preroll: shot.preroll ?? 12,
      audioPreroll: shot.audioPreroll ?? 8,
      hud: shot.hud ?? false,
      audio: shot.audio !== false,
      randomSeed: shot.randomSeed ?? shot.seed * 7919 + Math.round(shot.start * 10),
    };
    if (rs.stride && rs.stride > 1) await page.evaluate((n) => ((window as unknown as { __promo: { qa: number } }).__promo.qa = n), rs.stride);
    const ready = await page.evaluate((s) => (window as unknown as { __promo: { setup(s: unknown): Promise<{ sim: number; gpu: string }> } }).__promo.setup(s), setup as unknown as Record<string, unknown>);
    log(`[capture] ${shot.id}: seed ${shot.seed} at sim ${ready.sim.toFixed(2)} | ${ready.gpu}`);
    if (!/NVIDIA/.test(ready.gpu)) log(`[capture] WARNING: not on the NVIDIA GPU (${ready.gpu})`);
    const info: ShotManifest['info'] = [];
    const ext = rs.format === 'png' ? 'png' : 'jpg';
    let last = Date.now();
    const tFrames = Date.now();
    let msTick = 0, msShot = 0, msWrite = 0;
    const stride = rs.stride ?? 1;
    for (let i = 0; i < setup.frames; i++) {
      const kept = !shot.keep || shot.keep.some(([a, b]) => i / rs.fps >= a - 1e-6 && i / rs.fps <= b + 1e-6);
      if ((stride > 1 && i % stride !== 0) || !kept) {
        info.push(await page.evaluate(() => (window as unknown as { __promo: { frame(): Promise<ShotManifest['info'][number]> } }).__promo.frame()));
        continue;
      }
      const a = performance.now();
      // HUD shots need the page (DOM over the canvas): a CDP screenshot (~100-200 ms); everything else reads the canvas in the draw's own task (~5 ms)
      const grab = setup.hud ? undefined : { type: rs.format === 'png' ? 'image/png' : 'image/jpeg', quality: rs.quality / 100 };
      const { image, ...fi } = await page.evaluate((g) => (window as unknown as { __promo: { frame(g?: unknown): Promise<ShotManifest['info'][number] & { image?: string }> } }).__promo.frame(g), grab);
      info.push(fi);
      const b = performance.now();
      const data = image ? image.slice(image.indexOf(',') + 1) : ((await cdp.send('Page.captureScreenshot', rs.format === 'png' ? { format: 'png', optimizeForSpeed: true } : { format: 'jpeg', quality: rs.quality })) as { data: string }).data;
      const c = performance.now();
      fs.writeFileSync(path.join(dir, `${String(i).padStart(5, '0')}.${ext}`), Buffer.from(data, 'base64'));
      msTick += b - a;
      msShot += c - b;
      msWrite += performance.now() - c;
      if (Date.now() - last > 10000 || i === setup.frames - 1) {
        last = Date.now();
        const n = i + 1;
        log(`[capture] ${shot.id}: frame ${n}/${setup.frames} sim ${fi.sim.toFixed(2)} ${fi.shot} (${((Date.now() - tFrames) / n).toFixed(0)} ms/frame: tick ${(msTick / n).toFixed(0)}, screenshot ${(msShot / n).toFixed(0)}, write ${(msWrite / n).toFixed(0)})`);
      }
    }
    let audio: ShotManifest['audio'] = null;
    let speech: ShotManifest['speech'] = [];
    if (setup.audio) {
      const a = await page.evaluate(() => (window as unknown as { __promo: { finishAudio(): Promise<{ sr: number; channels: string[]; t0: number; speech: { t: number; ev: unknown }[] } | null> } }).__promo.finishAudio());
      if (a) {
        const chs = a.channels.map(fromB64);
        // the game's own broadcast mix, and the stems the edit mixes from: the park (before the booth's duck) and the booth
        writeWav(path.join(dir, 'audio.wav'), chs.slice(0, 2), a.sr);
        if (chs.length >= 6) {
          writeWav(path.join(dir, 'park.wav'), chs.slice(2, 4), a.sr);
          writeWav(path.join(dir, 'booth.wav'), chs.slice(4, 6), a.sr);
        }
        audio = { file: 'audio.wav', sr: a.sr, t0: a.t0 };
        speech = a.speech.map((s) => ({ t: +(s.t - a.t0).toFixed(3), ev: s.ev }));
      }
    }
    const m: ShotManifest = { id: shot.id, hash, frames: setup.frames, fps: rs.fps, size: [Math.round(w * dpr), Math.round(h * dpr)], ext, gpu: ready.gpu, info, audio, speech, at: new Date().toISOString(), ms: Date.now() - t0 };
    if (errors.length) fs.writeFileSync(path.join(dir, 'errors.txt'), errors.join('\n'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 1));
    log(`[capture] ${shot.id}: ${setup.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s${errors.length ? ` (${errors.length} page errors, see errors.txt)` : ''}`);
    return m;
  } finally {
    await page.close().catch(() => {});
  }
}

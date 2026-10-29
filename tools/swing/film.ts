/**
 * A swing in slow motion in the real game: the build of this checkout (cbv launch), the game played to just before the swing, then stepped by a
 * fixed 1/480 s per frame (16x slow at 30 fps) with a fixed bench camera and replays off (harness knobs: say so next to the clips). Each frame is a
 * screenshot of one view (one engine frame per picture: run again for another view, the game is deterministic); ffmpeg makes the clip.
 *   npx tsx tools/swing/film.ts --at 119.97 --name mid --out <dir> [--view front|hands] [--seed 24] [--tempo broadcast] [--pre 0.12] [--post 0.3]
 * --at: a sim time inside the pitch (e.g. the contact, from `cbv seek`); filming starts --pre s before the swing starts and runs --post s past
 * its planned contact. Writes <out>/<name>-<view>/NNNN.png, <out>/<name>-<view>.mp4 and <out>/<name>-<view>.json (the swing's start, frame times).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CBV = path.join(ROOT, '.claude/skills/verify-claudeball/scripts/cbv');
const AT = +opt('at', '119.97'), NAME = opt('name', 'swing'), OUT = path.resolve(opt('out', path.join(ROOT, 'tools/swing/out/film')));
const PRE = +opt('pre', '0.12'), POST = +opt('post', '0.3'), DT = 1 / 480;
const VIEW = opt('view', 'front');

const cbv = (...a: string[]) => {
  const r = spawnSync(CBV, a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cbv ${a.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
};

async function main() {
  const q = `autostart&seed=${opt('seed', '24')}&tempo=${opt('tempo', 'broadcast')}&innings=9&quality=${opt('quality', 'medium')}&noaudio&tod=day&replays=0&nodof&hud=0`;
  const id = /"session":\s*"([^"]+)"/.exec(cbv('launch', '--query', q, '--size', opt('size', '960x720')))?.[1];
  if (!id) throw new Error('no cbv session');
  const s = JSON.parse(fs.readFileSync(path.join(process.env.CBV_RUN_DIR ?? path.join(os.tmpdir(), 'cbv'), id, 'session.json'), 'utf8'));
  try {
    // to a few seconds before the pitch (turbo), then the last stretch at 1x
    cbv('ff', `s.time >= ${AT - 8}`, '--turbo', '--pause', '--session', id);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${s.cdpPort}`);
    const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(s.base)) ?? browser.contexts()[0].pages()[0];
    await page.evaluate('window.__name = (f) => f');
    // step at 1/60 until the batter has planned this pitch's swing (the sim's world: swingPlan, timed from the pitch's release)
    const info = (await page.evaluate((at) => {
      const e = (window as any).engine;
      e.stop();
      e.fixedDt = undefined;
      e.sim.speed = 1;
      e.sim.paused = false;
      e.director.replaysEnabled = false;
      e.adaptive.enabled = false;
      for (let i = 0; i < 60 * 30; i++) {
        const W = e.sim.game.g._world;
        if (W.swingPlan?.swing && !W.swingPlan.bunt && W.pitch && e.sim.state.time > at - 3) {
          const b = e.sim.state.players.find((p: any) => p.role === 'batter');
          // release, in sim time: the world's tick count at the pitch (TICK = 1/240 s)
          return { pos: b.pos, stance: W.batStance, release: e.sim.state.time - (W.tick - W.pitchTick) / 240, startTime: W.swingPlan.startTime, contact: W.swingPlan.plannedContactTime };
        }
        e.tick(1 / 60, false);
      }
      return null;
    }, AT)) as { pos: { x: number; y: number; z: number }; stance: 'L' | 'R'; release: number; startTime: number; contact: number } | null;
    if (!info) throw new Error('no swing planned near --at');
    const off = info.release;
    const tStart = info.startTime + off, tEnd = info.contact + off + POST;
    const sg = info.stance === 'R' ? 1 : -1;
    const cams: Record<string, { pos: number[]; tgt: number[]; fov: number }> = {
      // in front of the plate, a little to the batter's open side, chest high
      front: { pos: [info.pos.x - sg * 1.2, 1.25, info.pos.z + 4.2], tgt: [info.pos.x - sg * 0.25, 1.0, info.pos.z + 0.2], fov: 38 },
      // the hands: from the pitcher's side, close
      hands: { pos: [info.pos.x - sg * 0.6, 1.3, info.pos.z + 2.2], tgt: [info.pos.x - sg * 0.35, 1.05, info.pos.z + 0.3], fov: 34 },
    };
    // play to PRE before the swing starts (no pictures). The drawn time is the sim's last step plus what the driver has accumulated toward the
    // next one (state.time + acc): every film of this swing starts at the same drawn instant, so before / after frames line up one to one
    const t0 = await page.evaluate((t) => {
      const e = (window as any).engine;
      const now = () => e.sim.state.time + e.sim.acc;
      while (now() < t - 1e-9) e.tick(Math.min(1 / 60, t - now()), false);
      return now();
    }, tStart - PRE);
    fs.mkdirSync(OUT, { recursive: true });
    const dir = path.join(OUT, `${NAME}-${VIEW}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // one engine frame per picture: the engine's per-frame logic (the arms' tracked solve, the grip's turn over three frames) counts frames
    await page.evaluate((c) => {
      const e = (window as any).engine;
      const V = e.camera.position.constructor;
      e.director.bench = { pos: new V(...c.pos), tgt: new V(...c.tgt), fov: c.fov, aperture: 0, cut: true };
    }, cams[VIEW]);
    const times: number[] = [];
    for (let k = 0; ; k++) {
      const t = (await page.evaluate((dt) => {
        const e = (window as any).engine;
        e.tick(dt, true);
        return e.sim.state.time + e.sim.acc;
      }, DT)) as number;
      if (t > tEnd) break;
      times.push(t);
      await page.screenshot({ path: path.join(dir, `${String(k).padStart(4, '0')}.png`) });
    }
    await browser.close().catch(() => {});
    fs.writeFileSync(path.join(OUT, `${NAME}-${VIEW}.json`), JSON.stringify({ query: q, at: AT, swingStart: tStart, contact: info.contact + off, stance: info.stance, dt: DT, cam: cams[VIEW], times }, null, 1));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', path.join(dir, '%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', path.join(OUT, `${NAME}-${VIEW}.mp4`)]);
    console.log(`[film] ${times.length} frames from ${t0.toFixed(4)} s (swing ${tStart.toFixed(3)}, contact ${(info.contact + off).toFixed(3)}) -> ${OUT}/${NAME}-${VIEW}.mp4`);
  } finally {
    try {
      cbv('stop', '--session', id);
    } catch (e) {
      console.log('[film] cbv stop:', String(e).slice(0, 200));
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

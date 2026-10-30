/**
 * Film one stretch of the real game with a camera that follows a player: the batter's walk-up, the on-deck hitter's swing in slow motion, the bench.
 * The build of this checkout (cbv launch), the game fast-forwarded to --at, then stepped by a fixed --dt per frame (one engine frame per picture) with the
 * director's bench camera and replays off (harness knobs: say so next to the clips). ffmpeg makes the clip; every frame's state of the followed player
 * goes to <name>.json (sim hint, clip the puppet plays, position, speed).
 *   npx tsx tools/batter/film.ts --at 69.5 --secs 20 --name walkup --follow batter --cam wide [--dt 0.0333] [--seed 24] [--fps 30] [--out <dir>]
 * --follow: a role (batter, ondeck) or a player id; --cam: wide (the plate area from the infield, following), side (from the field side, close),
 * close (head to toe, front), dugout:<0|1> (the director's dugout shot for away / home), or px/py/pz:tx/ty/tz:fov (fixed).
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
const AT = +opt('at', '69.5'), SECS = +opt('secs', '10'), DT = +opt('dt', String(1 / 30)), NAME = opt('name', 'film');
const OUT = path.resolve(opt('out', path.join(ROOT, 'tools/batter/out')));
const FOLLOW = opt('follow', 'batter'), CAM = opt('cam', 'wide');

const cbv = (...a: string[]) => {
  const r = spawnSync(CBV, a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cbv ${a.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
};

async function main() {
  const q = `autostart&seed=${opt('seed', '24')}&tempo=${opt('tempo', 'broadcast')}&innings=9&quality=${opt('quality', 'medium')}&noaudio&tod=day&replays=0&nodof&hud=0`;
  const launch = ['launch', '--query', q, '--size', opt('size', '960x540'), ...(argv.includes('--no-build') ? ['--no-build'] : [])];
  const id = /"session":\s*"([^"]+)"/.exec(cbv(...launch))?.[1];
  if (!id) throw new Error('no cbv session');
  const s = JSON.parse(fs.readFileSync(path.join(process.env.CBV_RUN_DIR ?? path.join(os.tmpdir(), 'cbv'), id, 'session.json'), 'utf8'));
  try {
    if (AT > 2) cbv('ff', `s.time >= ${AT - 2}`, '--turbo', '--pause', '--session', id);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${s.cdpPort}`);
    const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(s.base)) ?? browser.contexts()[0].pages()[0];
    await page.evaluate('window.__name = (f) => f');
    await page.evaluate((at) => {
      const e = (window as any).engine;
      e.stop();
      e.fixedDt = undefined;
      e.sim.speed = 1;
      e.sim.paused = false;
      e.director.replaysEnabled = false;
      e.adaptive.enabled = false;
      const now = () => e.sim.state.time + e.sim.acc;
      while (now() < at - 1e-9) e.tick(Math.min(1 / 60, at - now()), true);
    }, AT);
    const dir = path.join(OUT, NAME);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const frames: unknown[] = [];
    const n = Math.round(SECS / DT);
    for (let k = 0; k < n; k++) {
      const f = await page.evaluate(
        ({ dt, follow, cam }) => {
          const e = (window as any).engine;
          const st = e.sim.state;
          const p = st.players.find((q: any) => q.id === follow) ?? st.players.find((q: any) => q.role === follow);
          const V = e.camera.position.constructor;
          const c = (pos: number[], tgt: number[], fov: number) => (e.director.bench = { pos: new V(...pos), tgt: new V(...tgt), fov, aperture: 0, cut: true });
          if (cam.split(':').length === 3 && cam.includes('/')) {
            const [a, b, fov] = cam.split(':');
            c(a.split('/').map(Number), b.split('/').map(Number), +fov);
          } else if (cam.startsWith('bench:')) {
            // the seated players of a team (0 away, 1 home) from in front, along the way they face
            const [, team, dist] = cam.split(':');
            const sit = st.players.filter((q: any) => q.role === 'bench' && q.team === +team && q.pos.y < -0.3 && Math.hypot(q.vel.x, q.vel.z) < 0.1);
            if (sit.length) {
              const m = sit.reduce((a: number[], q: any) => [a[0] + q.pos.x / sit.length, a[1] + q.pos.y / sit.length, a[2] + q.pos.z / sit.length, a[3] + Math.sin(q.facing), a[4] + Math.cos(q.facing)], [0, 0, 0, 0, 0]);
              const h = Math.hypot(m[3], m[4]) || 1, d = +(dist ?? 7);
              // (above the dugout lip: lower, the front wall hides the bench); the spot is taken once, so the picture holds still
              e.__benchCam ??= [[m[0] + (m[3] / h) * d, 2.1, m[2] + (m[4] / h) * d], [m[0], m[1] + 0.9, m[2]]];
              c(e.__benchCam[0], e.__benchCam[1], 40);
            }
          } else if (cam.startsWith('dugout:')) {
            const d = e.director.dugoutShots[+cam.split(':')[1]] ?? e.director.dugoutShots[0];
            c([d.pos.x, d.pos.y, d.pos.z], [d.target.x, d.target.y, d.target.z], 30);
          } else if (p) {
            const x = p.pos.x, z = p.pos.z, y = Math.max(0, p.pos.y);
            if (cam === 'wide') c([x * 0.35 - Math.sign(x || 1) * 3, 3.2, 13], [x, y + 0.9, z], 30);
            else if (cam === 'side') c([x * 0.8, y + 1.3, z + 5.5], [x, y + 1.0, z], 30);
            else c([x + 0.6, y + 1.2, z + 3.6], [x, y + 1.0, z], 34);
          }
          e.tick(dt, true);
          const pup = p && e.players.puppets.get(p.id);
          // the hands and the chest in the world (for the per-frame hand speed and the hands' place in front of / behind the chest)
          const w3 = (b: any) => (b ? b.getWorldPosition(new V()).toArray().map((x: number) => +x.toFixed(4)) : null);
          const bones = pup?.bones ?? {};
          return {
            t: +(st.time + e.sim.acc).toFixed(4), id: p?.id, role: p?.role, hint: p?.anim, clip: pup?.currentName, clipT: pup?.current ? +pup.current.time.toFixed(4) : null,
            x: p && +p.pos.x.toFixed(3), z: p && +p.pos.z.toFixed(3), v: p && +Math.hypot(p.vel.x, p.vel.z).toFixed(2), yaw: pup?.root ? +pup.root.rotation.y.toFixed(4) : null,
            handL: w3(bones.LeftHand), handR: w3(bones.RightHand), chest: w3(bones.Spine2), hips: w3(bones.Hips),
          };
        },
        { dt: DT, follow: FOLLOW, cam: CAM },
      );
      frames.push(f);
      await page.screenshot({ path: path.join(dir, `${String(k).padStart(4, '0')}.jpg`), quality: 85 });
    }
    await browser.close().catch(() => {});
    fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify({ query: q, at: AT, dt: DT, follow: FOLLOW, cam: CAM, frames }, null, 1));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', opt('fps', '30'), '-i', path.join(dir, '%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', path.join(OUT, `${NAME}.mp4`)]);
    console.log(`[film] ${n} frames from ${AT} s, dt ${DT} -> ${OUT}/${NAME}.mp4`);
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

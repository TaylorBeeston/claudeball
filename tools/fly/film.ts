/**
 * A fly-ball catch in the real game: the build of this checkout (cbv launch), the game played to a few seconds before the catch, then stepped by a
 * fixed --dt per frame (1/60 s = real time at 60 fps; 1/120 = half speed) with a fixed camera beside the fielder that follows him, replays off
 * (harness knobs: say so next to the clips). Writes the frames, an mp4, a contact sheet around the catch and a json of what the puppet did
 * per frame: the root's lift off the ground (a hop), the glove pocket's height, the throwing hand's height and the hint.
 *   npx tsx tools/fly/film.ts --seed 2 --at 963.37 --id DUL-away-b7 --name cf --out <dir> [--tempo quick] [--pre 3] [--post 1.2] [--dt 0.016667]
 *     [--view side|front] [--dist 7]
 * --at: the catch's sim time (tools/fly/catches.ts --rows); --id: the fielder's player id.
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
const AT = +opt('at', '0'), ID = opt('id', ''), NAME = opt('name', 'catch'), OUT = path.resolve(opt('out', path.join(ROOT, 'tools/fly/out/film')));
const PRE = +opt('pre', '3'), POST = +opt('post', '1.2'), DT = +opt('dt', String(1 / 60)), VIEW = opt('view', 'side'), DIST = +opt('dist', '7');

const cbv = (...a: string[]) => {
  const r = spawnSync(CBV, a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cbv ${a.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
};

async function main() {
  if (!AT || !ID) throw new Error('--at <catch sim time> and --id <fielder id> are required');
  const q = `autostart&seed=${opt('seed', '1')}&tempo=${opt('tempo', 'quick')}&innings=9&quality=${opt('quality', 'medium')}&noaudio&tod=day&replays=0&nodof&hud=0`;
  const id = /"session":\s*"([^"]+)"/.exec(cbv('launch', '--query', q, '--size', opt('size', '960x720'), ...(argv.includes('--no-build') ? ['--no-build'] : []), ...(argv.includes('--dev') ? ['--dev'] : [])))?.[1];
  if (!id) throw new Error('no cbv session');
  const s = JSON.parse(fs.readFileSync(path.join(process.env.CBV_RUN_DIR ?? path.join(os.tmpdir(), 'cbv'), id, 'session.json'), 'utf8'));
  try {
    cbv('ff', `s.time >= ${AT - PRE - 6}`, '--turbo', '--pause', '--timeout', '1200', '--session', id);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${s.cdpPort}`);
    const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(s.base)) ?? browser.contexts()[0].pages()[0];
    await page.evaluate('window.__name = (f) => f');
    const t0 = await page.evaluate((t) => {
      const e = (window as any).engine;
      e.stop();
      e.fixedDt = undefined;
      e.sim.speed = 1;
      e.sim.paused = false;
      e.director.replaysEnabled = false;
      e.adaptive.enabled = false;
      const now = () => e.sim.state.time + e.sim.acc;
      while (now() < t - 1e-9) e.tick(Math.min(1 / 60, t - now()), false);
      return now();
    }, AT - PRE);
    const dir = path.join(OUT, `${NAME}-${VIEW}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const rows: (Record<string, unknown> & { t: number })[] = [];
    for (let k = 0; ; k++) {
      const r = (await page.evaluate(
        ([dt, pid, view, dist]) => {
          const e = (window as any).engine;
          const st = e.sim.state;
          const me = st.players.find((p: any) => p.id === pid);
          if (me) {
            // beside him, square to the line from home plate (the ball comes from there), chest high, following him; or in front of him (from the infield)
            const V = e.camera.position.constructor;
            const l = Math.hypot(me.pos.x, me.pos.z) || 1;
            const ux = me.pos.x / l, uz = me.pos.z / l;
            const cx = view === 'front' ? me.pos.x - ux * dist : me.pos.x - uz * dist;
            const cz = view === 'front' ? me.pos.z - uz * dist : me.pos.z + ux * dist;
            e.director.bench = { pos: new V(cx, 1.5, cz), tgt: new V(me.pos.x, 1.3, me.pos.z), fov: 34, aperture: 0, cut: true };
          }
          e.tick(dt, true);
          const pp = e.players.puppets.get(pid);
          const out: Record<string, unknown> = { t: st.time + e.sim.acc, anim: me?.anim, call: me?.calling, catchIn: me?.gloveTarget ? me.catchIn : null, gy: me?.gloveTarget?.y ?? null, hasBall: me?.hasBall };
          if (pp?.root) {
            const P = pp.root.position.constructor;
            const v = new P();
            out.lift = +(pp.root.position.y - (me?.pos.y ?? 0)).toFixed(3);
            if (pp.pocket) out.pocketY = +pp.pocket.getWorldPosition(v).y.toFixed(3);
            const hand = pp.bones?.[me?.throws === 'L' ? 'LeftHand' : 'RightHand'];
            if (hand) out.handY = +hand.getWorldPosition(new P()).y.toFixed(3);
            const head = pp.bones?.Head;
            if (head) out.headY = +head.getWorldPosition(new P()).y.toFixed(3);
            const foot = [pp.bones?.LeftFoot, pp.bones?.RightFoot].filter(Boolean).map((b: any) => b.getWorldPosition(new P()).y);
            if (foot.length) out.footY = +Math.min(...foot).toFixed(3);
          }
          return out;
        },
        [DT, ID, VIEW, DIST] as const,
      )) as Record<string, unknown> & { t: number };
      if (r.t > AT + POST) break;
      rows.push(r);
      await page.screenshot({ path: path.join(dir, `${String(k).padStart(4, '0')}.jpg`), quality: 85, type: 'jpeg' });
    }
    await browser.close().catch(() => {});
    fs.writeFileSync(path.join(OUT, `${NAME}-${VIEW}.json`), JSON.stringify({ query: q, at: AT, id: ID, dt: DT, t0, rows }, null, 1));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(Math.round(1 / DT)), '-i', path.join(dir, '%04d.jpg'), '-vf', 'scale=960:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', path.join(OUT, `${NAME}-${VIEW}.mp4`)]);
    // contact sheets of 12 frames, labelled with the time to the catch: the catch (1.2 s before to 0.5 s after) and the call (2.9 to 0.9 s before)
    const sheet = (from: number, span: number, suffix: string) => {
      const want = Array.from({ length: 12 }, (_, i) => AT + from + (i * span) / 11);
      const pick = want.map((t) => rows.reduce((b, r, i) => (Math.abs(r.t - t) < Math.abs(rows[b].t - t) ? i : b), 0));
      const args = pick.flatMap((i) => ['-label', `${(rows[i].t - AT >= 0 ? '+' : '') + (rows[i].t - AT).toFixed(2)} s  lift ${((rows[i].lift as number) ?? 0).toFixed(2)}`, path.join(dir, `${String(i).padStart(4, '0')}.jpg`)]);
      execFileSync('montage', [...args, '-tile', '6x2', '-geometry', '480x360+2+2', '-pointsize', '18', '-title', `${NAME} (${ID}, catch at ${AT} s)`, path.join(OUT, `${NAME}-${VIEW}-${suffix}.jpg`)]);
    };
    sheet(-1.2, 1.7, 'sheet');
    if (PRE >= 2.9) sheet(-2.9, 2, 'call');
    const lifts = rows.filter((r) => Math.abs(r.t - AT) < 0.6).map((r) => (r.lift as number) ?? 0);
    console.log(`[fly-film] ${rows.length} frames; max lift within 0.6 s of the catch ${Math.max(...lifts).toFixed(3)} m -> ${OUT}/${NAME}-${VIEW}.mp4`);
  } finally {
    try {
      cbv('stop', '--session', id);
    } catch (e) {
      console.log('[fly-film] cbv stop:', String(e).slice(0, 200));
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

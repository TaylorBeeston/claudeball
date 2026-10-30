/**
 * Arms and wrists on film: run cycles (front, back and side strips of one stride) and wrist close-ups of chosen poses, rendered by the real
 * game's renderer on the jank studio puppet (page.ts), with a chosen role (gear, hand variant) and body build. Poses are sampled in Node from
 * the shipped player file and put through the runtime pose passes (constrain.ts, as the static runtime sweep does), so a pose fix in those
 * passes shows here exactly as `jank:check` measures it.
 *   npx tsx tools/jank/armfilm.ts --out <dir> [--what runs,wrists] [--builds athletic,heavy,lean] [--roles runner,fielder] [--pre "<js>"]
 * `--pre` runs in Node before the poses are sampled (e.g. "globalThis.__noGaitArms = true" for the before pictures); `--page-pre` in the page.
 * Writes <dir>/run-<clip>-<role>-<build>.jpg (3 rows: front, back, side; one column per phase) and <dir>/wrist-<pose>-<role>-<build>.jpg
 * (front, back, side, thumb side of the right wrist, then the left), plus <dir>/poses.json (the numbers of every pose).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadRig, sampleClip } from './glb';
import { rigInfo, gripBat } from './validate';
import { withGame } from './run';
import { ROOT } from './sweep';
import { fk, B } from '../../src/engine/pose/skeleton';
import { restInfo, measureJoints } from '../../src/engine/pose/limits';
import { constrainPose, constrainOptsFor, newConstrainState } from '../../src/engine/pose/constrain';
import type { Snapshot } from './agg';
import { armFrame } from './arms';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const OUTD = path.resolve(opt('out', path.join(ROOT, 'tools/jank/out/armfilm')));
const WHAT = opt('what', 'runs,wrists').split(',');
const BUILDS = opt('builds', 'athletic,heavy,lean').split(',');
const ROLES = opt('roles', 'runner,fielder').split(',');
const RUNS = opt('runs', 'jog,run,run_sprint').split(',');
const PHASES = +opt('phases', '8');
const pre = opt('pre', '');
if (pre) new Function(pre)();

/** the sim's physique for each build (weights that push the look's morphs near their ends: playerLook.ts) */
const PHYSIQUE: Record<string, { heightM: number; weightKg: number; build: string }> = {
  athletic: { heightM: 1.85, weightKg: 88, build: 'athletic' },
  heavy: { heightM: 1.85, weightKg: 125, build: 'heavy' },
  stocky: { heightM: 1.85, weightKg: 105, build: 'stocky' },
  lean: { heightM: 1.85, weightKg: 70, build: 'lean' },
};

/** the wrist poses: the clip, the time, the role whose gear / hand variant fits it */
const WRISTS: { name: string; clip: string; t: number; role: string }[] = [
  { name: 'relaxed', clip: 'idle', t: 1.0, role: 'fielder' },
  { name: 'running', clip: 'run', t: 0.17, role: 'runner' },
  { name: 'bat-grip', clip: 'batting_stance', t: 1.0, role: 'batter' },
  { name: 'catching', clip: 'catch_fly', t: 0.55, role: 'fielder' },
  { name: 'throwing', clip: 'throw', t: 0.75, role: 'fielder' },
];

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function main() {
  fs.mkdirSync(OUTD, { recursive: true });
  const rig = await loadRig(path.join(ROOT, 'assets/optimized/players/player_base.glb'));
  const rw = fk(rig.rest);
  fk(rig.rest, rw, rw);
  const R = restInfo(rw);
  const grip = rig.attach.get('Bat_Grip')!;
  const info = rigInfo(rig.rest, grip);
  /** a clip's pose at t through the runtime passes (the clip played from 0 to t, so the passes' time-continuous state is warm) */
  const pose = (clip: string, t: number) => {
    const c = rig.clips.get(clip);
    if (!c) throw new Error(`no clip ${clip}`);
    const st = newConstrainState();
    const dt = 1 / 60;
    let L = sampleClip(c, 0, rig.rest);
    for (let k = 0, n = Math.max(1, Math.round(t / dt)); k <= n; k++) {
      L = sampleClip(c, Math.min(t, k * dt), rig.rest);
      constrainPose(L, R, { ...constrainOptsFor(clip), state: st, dt });
    }
    const w = fk(L, undefined, R.rest);
    const j = measureJoints(w, R);
    const nums = Object.fromEntries((['Left', 'Right'] as const).map((s) => [s, armFrame(w, R, s, j, t)]));
    const bat = /^batting_stance|^swing|^ondeck/.test(clip) ? gripBat(L, info, IDENT, { L: true, R: true }) : null;
    const sn: Snapshot = { lq: Array.from(L.lq), lp: Array.from(L.lp), base: Array.from(L.base), model: IDENT, bat, ctx: { clip, t } };
    return { sn, nums };
  };
  const record: Record<string, unknown> = {};
  await withGame('autostart&seed=24&tempo=standard&innings=1&quality=high&noaudio&tod=day&replays=0&nodof&hud=0', async (page) => {
    await page.evaluate((js) => {
      const e = (window as any).engine;
      e.sim.paused = true;
      e.adaptive.enabled = false;
      if (js) new Function(js)();
    }, opt('page-pre', ''));
    const frames = (n: number) => page.evaluate((k) => new Promise<void>((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    const shoot = async (sn: Snapshot, view: string, role: string, o: Record<string, unknown>, file: string, size: number) => {
      await page.evaluate(([s, v, r, oo]) => (window as any).__jank.studioPose(s, v, r, '', false, oo), [sn, view, role, o] as const);
      await frames(6);
      const raw = file + '.png';
      await page.screenshot({ path: raw });
      // the middle of the 960x720 frame, square
      execFileSync('convert', [raw, '-gravity', 'center', '-crop', '720x720+0+0', '+repage', '-resize', `${size}x${size}`, file]);
      fs.rmSync(raw);
    };
    for (const build of BUILDS) {
      const physique = PHYSIQUE[build];
      if (WHAT.includes('runs'))
        for (const role of ROLES)
          for (const clip of RUNS) {
            const c = rig.clips.get(clip)!;
            const rows: string[] = [];
            for (const view of ['front', 'back', 'side']) {
              const tiles: string[] = [];
              for (let k = 0; k < PHASES; k++) {
                const t = (c.duration * k) / PHASES;
                const { sn, nums } = pose(clip, t);
                record[`run/${clip}/${k}`] = nums;
                const f = path.join(OUTD, `_t${k}.jpg`);
                await shoot(sn, view, role, { physique, anim: clip, cam: { dir: view === 'front' ? [0, 0, 1] : view === 'back' ? [0, 0, -1] : [1, 0, 0], span: 2.1, at: [0, 1.05, 0] } }, f, 220);
                tiles.push(f);
              }
              const row = path.join(OUTD, `_row-${view}.jpg`);
              execFileSync('montage', [...tiles, '-tile', `${PHASES}x1`, '-geometry', '+1+1', '-background', '#222', row]);
              for (const t of tiles) fs.rmSync(t);
              rows.push(row);
            }
            const out = path.join(OUTD, `run-${clip}-${role}-${build}.jpg`);
            execFileSync('montage', [...rows, '-tile', '1x3', '-geometry', '+0+2', '-background', '#222', '-title', `${clip}  ${role}  ${build}  (rows: front, back, side; one stride, ${PHASES} phases)`, '-pointsize', '14', '-fill', '#fff', out]);
            for (const r of rows) fs.rmSync(r);
            console.log('[armfilm]', out);
          }
      if (WHAT.includes('wrists'))
        for (const wp of WRISTS) {
          const { sn, nums } = pose(wp.clip, wp.t);
          record[`wrist/${wp.name}`] = nums;
          const tiles: string[] = [];
          for (const side of ['Right', 'Left'] as const) {
            // around the wrist joint, a hand's length up the forearm: front / back / outside / inside of the body
            const s = side === 'Left' ? 1 : -1;
            for (const [lab, dir] of [['front', [0.15 * s, 0.25, 1]], ['back', [0.15 * s, 0.25, -1]], ['out', [s, 0.3, 0.2]], ['in', [-s, 0.3, 0.2]]] as const) {
              const f = path.join(OUTD, `_w-${side}-${lab}.jpg`);
              await shoot(sn, 'detail', wp.role, { physique, anim: wp.clip, cam: { dir, span: 0.32, joint: `${side}Hand`, local: [0, -0.02, 0] } }, f, 260);
              execFileSync('convert', [f, '-fill', '#fff', '-pointsize', '13', '-annotate', '+6+16', `${side[0]} ${lab}`, f]);
              tiles.push(f);
            }
          }
          const out = path.join(OUTD, `wrist-${wp.name}-${wp.role}-${build}.jpg`);
          execFileSync('montage', [...tiles, '-tile', '4x2', '-geometry', '+1+1', '-background', '#222', '-title', `${wp.name} (${wp.clip} t=${wp.t})  ${wp.role}  ${build}`, '-pointsize', '14', '-fill', '#fff', out]);
          for (const t of tiles) fs.rmSync(t);
          console.log('[armfilm]', out);
        }
    }
    await page.evaluate(() => (window as any).__jank.studioEnd());
  });
  fs.writeFileSync(path.join(OUTD, 'poses.json'), JSON.stringify(record, null, 1));
  void B;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

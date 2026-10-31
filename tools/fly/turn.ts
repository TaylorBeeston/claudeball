/**
 * A fielder's feet and body yaw around a catch (and the throw after it) in the real game, frame by frame: the build of this checkout, one seeded
 * game, each play stepped at 1/60 s from `--pre` s before to `--post` s after its time with the jank probe on him (tools/jank/page.ts: his final
 * pose validated every frame) and a fixed camera beside him (so he is drawn at full detail). Per play it prints and saves:
 *   skate / slide   frames with a planted heel or ball moving over the ground (`foot:skate`: the root carries it; `foot:slide`: the pose moves it)
 *   yaw rate        the body's turn rate (root yaw), max and p95 (rad/s), and the sim's facing rate (what the body is asked to follow)
 *   swing           the biggest out-and-back of the body yaw after the catch (rad): how far it swung away from both where it started and where it ended
 *   shift           the reach lunge: the root's horizontal offset from the sim's position (m, max) and its speed (m/s, max)
 *
 *   npx tsx tools/fly/turn.ts --seed 2 --tempo quick --play 963.37:DUL-away-b7:cf --play 1457.81:DUL-away-b8:rf [--pre 1.5] [--post 2.5] [--out dir]
 * --play <sim time>:<player id>:<name>: the catch (tools/fly/catches.ts --rows) or a grounder's fielding (cbv seek ... ev.type==='fielded').
 */
import fs from 'node:fs';
import path from 'node:path';
import { withGame } from '../jank/run';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUTF = path.resolve(opt('out', path.join(ROOT, 'tools/fly/out/turn')));
const PRE = +opt('pre', '1.5'), POST = +opt('post', '2.5');
const plays = argv.flatMap((a, i) => (a === '--play' ? [argv[i + 1]] : [])).map((s) => {
  const [t, id, name] = s.split(':');
  return { t: +t, id, name: name ?? id };
}).sort((a, b) => a.t - b.t);

interface Row { t: number; anim: string; clip: string; facing: number; yaw: number; speed: number; ball: boolean; sx: number; sz: number; rx: number; rz: number; v: string[] | null; locked: [boolean, boolean]; gt: number[] | null; catchIn: number | null; gw: number; pk: number[] | null; planted: boolean[] | null }

async function main() {
  if (!plays.length) throw new Error('--play <t>:<id>:<name> (one or more)');
  const q = `autostart&seed=${opt('seed', '2')}&tempo=${opt('tempo', 'quick')}&innings=9&quality=low&noaudio&tod=day&replays=0&nodof&hud=0`;
  const res = await withGame(q, async (page) => {
    await page.evaluate(() => {
      const e = (window as any).engine;
      e.stop();
      e.sim.stepBudgetMs = 1e9;
      e.director.replaysEnabled = false;
      e.adaptive.enabled = false;
      (window as any).__jank.install();
    });
    const out: Record<string, Row[]> = {};
    for (const p of plays) {
      // to the window's start without the probe (the engine's own tick: 0.1 s steps, nothing drawn), then frame by frame with it
      await page.evaluate((t) => {
        const e = (window as any).engine;
        const raw = Object.getPrototypeOf(e).tick;
        const now = () => e.sim.state.time + e.sim.acc;
        while (now() < t - 1e-9) raw.call(e, Math.min(0.1, t - now()), false);
      }, p.t - PRE);
      await page.evaluate((id) => {
        const j = (window as any).__jank;
        j.trace = [];
        j.traceId = id;
      }, p.id);
      const rows: Row[] = [];
      for (;;) {
        const r = (await page.evaluate((pid) => {
          const e = (window as any).engine;
          const st = e.sim.state;
          const me = st.players.find((x: any) => x.id === pid);
          if (me) {
            const V = e.camera.position.constructor;
            const l = Math.hypot(me.pos.x, me.pos.z) || 1;
            e.director.bench = { pos: new V(me.pos.x + (me.pos.z / l) * 8, 1.6, me.pos.z - (me.pos.x / l) * 8), tgt: new V(me.pos.x, 1.2, me.pos.z), fov: 34, aperture: 0, cut: true };
          }
          const j = (window as any).__jank;
          const n0 = j.trace.length;
          e.tick(1 / 60, true);
          const pu = e.players.puppets.get(pid);
          const tr = j.trace.length > n0 ? j.trace[j.trace.length - 1] : null;
          const t = st.time + e.sim.acc;
          const fs = pu?.footState?.feet;
          return {
            t, anim: me?.anim, clip: pu?.currentName, facing: me?.facing, yaw: pu?.root.rotation.y, speed: me ? Math.hypot(me.vel.x, me.vel.z) : 0, ball: !!me?.hasBall,
            sx: me?.pos.x, sz: me?.pos.z, rx: pu?.root.position.x, rz: pu?.root.position.z, v: tr ? tr.v : null, planted: tr ? tr.feet.map((f: any) => f[2]) : null,
            locked: fs ? [fs.Left.locked, fs.Right.locked] : [false, false],
            gt: me?.gloveTarget ? [me.gloveTarget.x, me.gloveTarget.y, me.gloveTarget.z] : null, catchIn: me?.catchIn ?? null, gw: pu?.gloveW ?? 0,
            pk: pu?.pocket ? pu.pocket.getWorldPosition(new (e.camera.position.constructor)()).toArray() : null,
          };
        }, p.id)) as Row;
        if (r.t > p.t + POST) break;
        rows.push(r);
      }
      await page.evaluate(() => ((window as any).__jank.traceId = ''));
      out[p.name] = rows;
    }
    return out;
  });
  fs.mkdirSync(OUTF, { recursive: true });
  for (const p of plays) fs.writeFileSync(path.join(OUTF, `${p.name}.json`), JSON.stringify({ play: p, rows: res[p.name] }, null, 0));
  analyze(plays.map((p) => ({ play: p, rows: res[p.name] })));
}

const THROW = /^(throw|toss|throw_casual|toss_underhand|toss_sidearm_short)$/;
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/**
 * The windows, from the play's own events: `reach` from the catch clip's start (the first frame of a catch / fielding hint) to the catch (the ball
 * in his hand); `turn` the 0.6 s after the catch; `pivot` from the throw decision (a throw hint) to 0.3 s after the ball has left his hand.
 */
function analyze(list: { play: { t: number; id: string; name: string }; rows: Row[] }[]) {
  const lines: string[] = [];
  const summary: Record<string, Record<string, number | null>> = {};
  for (const { play: p, rows } of list) {
    const R = rows.filter((r) => r.t >= p.t - PRE + 0.3);
    const iCatch = R.findIndex((r) => r.ball && r.t >= p.t - 0.2);
    const tCatch = iCatch >= 0 ? R[iCatch].t : p.t;
    let iClip = iCatch;
    while (iClip > 0 && R[iClip - 1].anim !== 'idle' && R[iClip - 1].anim !== 'run' && /catch|field/.test(R[iClip - 1].anim)) iClip--;
    const iThrow = R.findIndex((r) => r.t > tCatch && THROW.test(r.anim));
    const iRel = iThrow >= 0 ? R.findIndex((r, i) => i > iThrow && !r.ball) : -1;
    const tThrow = iThrow >= 0 ? R[iThrow].t : null, tRel = iRel >= 0 ? R[iRel].t : null;
    const win = (a: number, b: number) => R.filter((r) => r.t >= a && r.t < b);
    const W = {
      reach: iClip >= 0 ? win(R[iClip].t, tCatch) : [],
      turn: win(tCatch, tCatch + 0.6),
      pivot: tThrow !== null ? win(tThrow, (tRel ?? tThrow + 0.2) + 0.3) : [],
    };
    const cnt = (rs: Row[], k: string) => rs.filter((r) => r.v?.some((x) => x.startsWith(k + ':'))).length;
    // the body turning over a planted sole (rad): what has to be stepped or pivoted, frame by frame
    const turnPlanted = (rs: Row[]) => rs.slice(1).reduce((a, r, i) => a + (r.planted?.some(Boolean) ? Math.abs(wrap(r.yaw - rs[i].yaw)) : 0), 0);
    // out-and-back after the catch: how far the yaw went beyond the span between its value at the catch and 0.6 s later
    let swing = 0;
    const T = W.turn;
    if (T.length > 2) {
      const y0 = T[0].yaw, y1 = y0 + wrap(T[T.length - 1].yaw - y0);
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      for (const r of T) {
        const y = y0 + wrap(r.yaw - y0);
        swing = Math.max(swing, y < lo ? lo - y : y > hi ? y - hi : 0);
      }
    }
    const sh = (r: Row) => [r.rx - r.sx, r.rz - r.sz];
    const shiftOf = (rs: Row[]) => Math.max(0, ...rs.map((r) => Math.hypot(...sh(r))));
    const shiftV = (rs: Row[]) => Math.max(0, ...rs.slice(1).map((r, i) => Math.hypot(sh(r)[0] - sh(rs[i])[0], sh(r)[1] - sh(rs[i])[1]) / Math.max(1e-6, r.t - rs[i].t)));
    const all = [...W.reach, ...W.turn];
    const s = {
      reachS: +(tCatch - (iClip >= 0 ? R[iClip].t : tCatch)).toFixed(2),
      skateReach: cnt(W.reach, 'foot:skate'), slideReach: cnt(W.reach, 'foot:slide'), floatReach: cnt(W.reach, 'foot:float'),
      skateTurn: cnt(W.turn, 'foot:skate'), slideTurn: cnt(W.turn, 'foot:slide'), floatTurn: cnt(W.turn, 'foot:float'),
      skatePivot: tThrow !== null ? cnt(W.pivot, 'foot:skate') : null, slidePivot: tThrow !== null ? cnt(W.pivot, 'foot:slide') : null,
      yawPlantedTurn: turnPlanted(W.turn), yawPlantedPivot: tThrow !== null ? turnPlanted(W.pivot) : null, swing,
      shiftMax: shiftOf(all), shiftV: shiftV(all), pivotS: tThrow !== null && tRel !== null ? +(tRel - tThrow).toFixed(2) : null,
    };
    summary[p.name] = s;
    const f = (x: number | null, d = 2) => (x === null ? '-' : x.toFixed(d));
    lines.push(`| ${p.name} | ${p.id} @ ${p.t} | ${s.skateReach} / ${s.slideReach} / ${s.floatReach} (${s.reachS} s) | ${s.skateTurn} / ${s.slideTurn} / ${s.floatTurn} | ${f(s.yawPlantedTurn)} | ${f(s.swing)} | ${f(s.shiftMax)} / ${f(s.shiftV, 1)} | ${s.skatePivot ?? '-'} / ${s.slidePivot ?? '-'} | ${f(s.yawPlantedPivot)} (${s.pivotS ?? '-'} s) |`);
  }
  const head = '| play | fielder @ sim time | reach (clip start to catch): skate / slide / float frames | turn (catch to +0.6 s): skate / slide / float | yaw turned over a planted sole after the catch (rad) | yaw out-and-back (rad) | lunge shift max (m) / speed (m/s) | pivot (throw decision to release + 0.3 s): skate / slide | yaw over a planted sole in the pivot (rad) |\n|---|---|---|---|---|---|---|---|---|';
  const md = `${head}\n${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(OUTF, 'table.md'), md);
  fs.writeFileSync(path.join(OUTF, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(md);
}

if (argv.includes('--analyze')) {
  const dir = path.resolve(opt('analyze', OUTF));
  analyze(fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'summary.json').map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).sort((a, b) => a.play.t - b.play.t));
} else
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Jank detector: measures every way a player's body breaks (joint limits, hinge direction, neck, feet, the bat, pops) and ranks the worst.
 *
 *   npx tsx tools/jank/run.ts static              every clip x every shipped player file, raw (Node, ~5 s)
 *   npx tsx tools/jank/run.ts fades               every clip switch the game makes (tools/jank/transitions.json), blended like three's mixer
 *   npx tsx tools/jank/run.ts game --seeds 1,2,3 [--innings 9] [--tempo standard] [--max-sim 6000]
 *                                                 seeded games in the real build (headless Chrome on the GPU through the verify-claudeball
 *                                                 harness), the validator on every fully animated puppet after all runtime overrides
 *   npx tsx tools/jank/run.ts sheets [--top 16]   contact sheets (front + side, skeleton overlay) of the worst frames of the last runs
 *   npx tsx tools/jank/run.ts report              the ranked tables (out/report.md)
 *   npx tsx tools/jank/run.ts all --seeds ...     static, game, fades, report, sheets
 *
 * Output: tools/jank/out/ (git-ignored): static.json, fades.json, game.json, report.md, sheets/*.jpg.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { Agg, family, type Entry, type Snapshot } from './agg';
import { ROOT, loadFiles, manifestLoops, runStatic, shippedPlayers, sweepFade, type Transition } from './sweep';
import { JOINT_LIMITS } from '../../src/engine/pose/limits';

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'all';
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k: string) => argv.includes(`--${k}`);
export const OUT = path.resolve(opt('out', path.join(ROOT, 'tools/jank/out')));
const TRANSITIONS = path.join(ROOT, 'tools/jank/transitions.json');
const CBV = path.join(ROOT, '.claude/skills/verify-claudeball/scripts/cbv');

const save = (name: string, data: unknown) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data));
};
const load = <T>(name: string): T | null => (fs.existsSync(path.join(OUT, name)) ? (JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8')) as T) : null);

export interface RunFile {
  meta: Record<string, unknown>;
  entries: Entry[];
  stats?: Record<string, unknown>;
}

// ---- static / fades ----------------------------------------------------------------------------------------------------------------

export async function doStatic(snapshots = true): Promise<RunFile> {
  const agg = new Agg();
  agg.snapshots = snapshots;
  const t0 = Date.now();
  await runStatic(shippedPlayers(), manifestLoops(), agg);
  const r = { meta: { kind: 'static', files: shippedPlayers(), ms: Date.now() - t0, git: git() }, entries: agg.list() };
  console.log(`[jank] static: ${r.entries.reduce((a, e) => a + (e.src === 'static' ? e.frames : 0), 0)} clip frames in ${r.meta.ms} ms`);
  return r;
}

export async function doFades(snapshots = true): Promise<RunFile> {
  const list = fs.existsSync(TRANSITIONS) ? (JSON.parse(fs.readFileSync(TRANSITIONS, 'utf8')) as { transitions: Transition[] }).transitions : [];
  if (!list.length) console.log('[jank] fades: no tools/jank/transitions.json yet (run the game sweep first)');
  const agg = new Agg();
  agg.snapshots = snapshots;
  const loops = manifestLoops();
  const files = await loadFiles(shippedPlayers());
  for (const tx of list) {
    const f = files.find((x) => x.name === (tx.file || 'player_base')) ?? files[0];
    sweepFade(agg, f.name, f.rig, f.info, tx, loops);
  }
  console.log(`[jank] fades: ${list.length} transitions`);
  return { meta: { kind: 'fades', n: list.length, git: git() }, entries: agg.list() };
}

// ---- browser (through the verify-claudeball harness) ------------------------------------------------------------------------------

interface Session {
  id: string;
  cdpPort: number;
  base: string;
}
function cbv(...args: string[]): string {
  const r = spawnSync(CBV, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`cbv ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function git() {
  try {
    return { head: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), sim: execFileSync('git', ['log', '-1', '--format=%h', '--', 'src/sim'], { cwd: ROOT, encoding: 'utf8' }).trim() };
  } catch {
    return {};
  }
}

async function bundle(): Promise<string> {
  const esbuild = await import('esbuild');
  const r = await esbuild.build({ entryPoints: [path.join(ROOT, 'tools/jank/page.ts')], bundle: true, format: 'iife', write: false, target: 'es2022', logLevel: 'error' });
  return r.outputFiles[0].text;
}

export async function withGame<T>(query: string, fn: (page: Page) => Promise<T>, reuseBuild = false): Promise<T> {
  const out = cbv('launch', '--query', query, '--size', opt('size', '960x720'), ...(reuseBuild || flag('no-build') ? ['--no-build'] : []));
  const id = /"session":\s*"([^"]+)"/.exec(out)?.[1];
  if (!id) throw new Error(`no session in cbv output: ${out}`);
  const runs = process.env.CBV_RUN_DIR ?? path.join(os.tmpdir(), 'cbv');
  const s = JSON.parse(fs.readFileSync(path.join(runs, id, 'session.json'), 'utf8')) as Session;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${s.cdpPort}`);
  try {
    const page = browser.contexts()[0].pages().find((p) => p.url().startsWith(s.base)) ?? browser.contexts()[0].pages()[0];
    await page.evaluate('window.__name = (f) => f');
    await page.addScriptTag({ content: await bundle() });
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
    try {
      cbv('stop', '--session', id);
    } catch (e) {
      console.log('[jank] cbv stop:', String(e).slice(0, 200));
    }
  }
}

export async function doGame(seeds: number[], innings: number, tempo: string, maxSim: number, snapshots = true): Promise<RunFile> {
  const agg = new Agg();
  const trans = new Map<string, Transition & { n: number }>();
  const stats: Record<string, number> = {};
  const per: Record<string, unknown>[] = [];
  let first = true;
  for (const seed of seeds) {
    const q = `autostart&seed=${seed}&tempo=${tempo}&innings=${innings}&quality=low&noaudio&tod=day&replays=0`;
    const t0 = Date.now();
    const res = await withGame(
      q,
      async (page) => {
        await page.evaluate(([snap, sd, pre]) => {
          const e = (window as any).engine;
          e.stop();
          e.fixedDt = 1 / 60;
          e.sim.stepBudgetMs = 1e9;
          e.director.replaysEnabled = false;
          e.adaptive.enabled = false;
          (window as any).__jank.install({ seed: sd });
          if (pre) new Function(pre)();
          if (!snap) (window as any).__jank.state.agg.snapshots = false;
        }, [snapshots, seed, opt('pre', '')] as const);
        let last = 0;
        for (;;) {
          const r = (await page.evaluate(() => (window as any).__jank.run(1200))) as { t: number; over: boolean; inning: number };
          const d = (await page.evaluate(() => (window as any).__jank.drain())) as { entries: Entry[]; stats: any; transitions: (Transition & { n: number })[] };
          agg.merge(d.entries);
          for (const tx of d.transitions) {
            const k = `${tx.file}|${tx.from}|${tx.to}`;
            const o = trans.get(k);
            if (o) o.n = Math.max(o.n, tx.n);
            else trans.set(k, { ...tx });
          }
          if (r.t - last > 300 || r.over) {
            process.stdout.write(`\r[jank] seed ${seed}: sim ${r.t.toFixed(0)} s, inning ${r.inning}, ${((Date.now() - t0) / 1000).toFixed(0)} s wall, probe ${(d.stats.ms / Math.max(1, d.stats.frames)).toFixed(2)} ms/frame   `);
            last = r.t;
          }
          if (r.over || r.t > maxSim) return d.stats;
        }
      },
      !first,
    );
    first = false;
    console.log('');
    per.push({ seed, wall: Date.now() - t0, ...res });
    for (const k of ['frames', 'puppetFrames', 'visibleFrames', 'fkMismatch']) stats[k] = (stats[k] ?? 0) + (res[k] ?? 0);
    for (const k of ['clip', 'blend', 'override']) {
      stats[`attr.${k}`] = (stats[`attr.${k}`] ?? 0) + (res.attr?.[k] ?? 0);
      stats[`attrSev.${k}`] = (stats[`attrSev.${k}`] ?? 0) + (res.attrSev?.[k] ?? 0);
    }
  }
  // the clip switches the game made: written next to the results; the committed list (the crossfade sweep's input, so jank:check's) changes only
  // with --update-transitions (then re-baseline jank:check once)
  const known = fs.existsSync(TRANSITIONS) ? (JSON.parse(fs.readFileSync(TRANSITIONS, 'utf8')) as { transitions: (Transition & { n: number })[] }).transitions : [];
  for (const tx of known) {
    const k = `${tx.file}|${tx.from}|${tx.to}`;
    if (!trans.has(k)) trans.set(k, tx);
  }
  const list = [...trans.values()].map((t) => ({ ...t, file: t.file || 'player_base' })).sort((a, b) => b.n - a.n);
  const body = JSON.stringify({ _: 'clip switches seen in seeded games (tools/jank/run.ts game): from, to, from-clip time, to-clip time, fade (s), times seen', transitions: list }, null, 0).replace(/\},\{/g, '},\n{') + '\n';
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'transitions.json'), body);
  if (flag('update-transitions')) fs.writeFileSync(TRANSITIONS, body);
  const added = list.length - known.length;
  if (added > 0) console.log(`[jank] ${added} clip switches not in tools/jank/transitions.json${flag('update-transitions') ? ' (added)' : ' (see out/transitions.json; --update-transitions adds them)'}`);
  return { meta: { kind: 'game', seeds, innings, tempo, git: git() }, entries: agg.list(), stats: { ...stats, per } };
}

// ---- report ------------------------------------------------------------------------------------------------------------------------

const UNITS: Record<string, string> = { joint: 'deg', len: 'ratio', foot: 'm', 'foot:slide': 'm/s', body: 'm', bat: 'm', 'bat:hand-axis': 'deg', flip: 'deg', spike: 'x cap', yaw: 'deg' };
const unit = (k: string) => UNITS[k] ?? UNITS[k.split(':')[0]] ?? '';

export function familyTable(entries: Entry[], src: (s: string) => boolean) {
  const fam = new Map<string, { frames: number; score: number; max: number; clips: Map<string, number> }>();
  let frames = 0, bad = 0;
  for (const e of entries) {
    if (!src(e.src)) continue;
    frames += e.frames;
    bad += e.bad;
    for (const [k, s] of Object.entries(e.kinds)) {
      const f = family(k);
      const x = fam.get(f) ?? { frames: 0, score: 0, max: 0, clips: new Map() };
      x.frames += s.frames;
      x.score += s.score;
      x.max = Math.max(x.max, s.max);
      x.clips.set(e.clip, (x.clips.get(e.clip) ?? 0) + s.score);
      fam.set(f, x);
    }
  }
  return { frames, bad, rows: [...fam].sort((a, b) => b[1].score - a[1].score) };
}

function mdFamilies(title: string, entries: Entry[], src: (s: string) => boolean, totalFrames?: number) {
  const t = familyTable(entries, src);
  const n = totalFrames ?? t.frames;
  const lines = [`### ${title}`, '', `${t.frames} frames, ${t.bad} with a violation (${((t.bad / Math.max(1, t.frames)) * 100).toFixed(1)} %)`, '', '| kind | frames | per 1k frames | worst | score (sev x s) | worst clips |', '|---|---:|---:|---:|---:|---|'];
  for (const [k, x] of t.rows) {
    const clips = [...x.clips].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c).join(', ');
    lines.push(`| ${k} | ${x.frames} | ${((x.frames / Math.max(1, n)) * 1000).toFixed(1)} | ${x.max.toFixed(k.startsWith('len') ? 3 : 2)} ${unit(k)} | ${x.score.toFixed(1)} | ${clips} |`);
  }
  return lines.join('\n');
}

function mdClips(title: string, entries: Entry[], src: (s: string) => boolean, top = 30, denom?: Map<string, number>) {
  const by = new Map<string, Entry>();
  for (const e of entries) {
    if (!src(e.src)) continue;
    const k = `${e.file}|${e.clip}`;
    const o = by.get(k);
    if (!o) by.set(k, structuredClone({ ...e, kinds: Object.fromEntries(Object.entries(e.kinds).map(([a, b]) => [a, { ...b, worst: undefined }])) }));
    else {
      o.frames += e.frames;
      o.bad += e.bad;
      o.score += e.score;
      for (const [kk, s] of Object.entries(e.kinds)) {
        const t = (o.kinds[kk] ??= { frames: 0, max: 0, sum: 0, score: 0 });
        t.frames += s.frames;
        t.score += s.score;
        t.max = Math.max(t.max, s.max);
      }
    }
  }
  const rows = [...by.values()].sort((a, b) => b.score - a.score).slice(0, top);
  const lines = [`### ${title}`, '', '| # | file / role | clip | bad frames | score | top violations (worst) |', '|---:|---|---|---:|---:|---|'];
  rows.forEach((e, i) => {
    const ks = Object.entries(e.kinds).sort((a, b) => b[1].score - a[1].score).slice(0, 4).map(([k, s]) => `${k} ${s.max.toFixed(k.startsWith('len') ? 3 : 1)}`);
    lines.push(`| ${i + 1} | ${e.file} | ${e.clip} | ${e.bad}/${denom?.get(`${e.file}|${e.clip}`) ?? e.frames} | ${e.score.toFixed(2)} | ${ks.join('; ')} |`);
  });
  return lines.join('\n');
}

export function writeReport() {
  const st = load<RunFile>('static.json'), fd = load<RunFile>('fades.json'), gm = load<RunFile>('game.json');
  const parts = ['# Jank report', '', `Generated ${new Date().toISOString()} from tools/jank/out/*.json. Limits: src/engine/pose/limits.ts (${JOINT_LIMITS.length} joint ranges) and tools/jank/validate.ts.`, ''];
  if (st) {
    parts.push('## Static sweep: every clip, raw (no runtime override)', '', `Files: ${(st.meta.files as string[]).join(', ')}`, '');
    parts.push(mdFamilies('Violations by kind', st.entries, (s) => s === 'static'), '', mdClips('Worst clips', st.entries, (s) => s === 'static', 40), '');
  }
  if (fd) parts.push('## Crossfade sweep: what the blend adds (in neither clip)', '', mdFamilies('Violations by kind', fd.entries, () => true), '', mdClips('Worst transitions', fd.entries, () => true, 30), '');
  if (gm) {
    const s = gm.stats as Record<string, number>;
    parts.push('## Game sweep: final pose after all runtime overrides', '', `Seeds ${(gm.meta.seeds as number[]).join(', ')}, ${gm.meta.innings} innings, tempo ${gm.meta.tempo}. ${s.puppetFrames} fully animated puppet frames (${s.visibleFrames} in the camera's view). Integrity: ${s.fkMismatch ?? '?'} frames where the validator's pose differed from the rendered bones by > 1 cm.`, '');
    const tot = (s['attrSev.clip'] ?? 0) + (s['attrSev.blend'] ?? 0) + (s['attrSev.override'] ?? 0);
    parts.push('Attribution of every violation (severity-weighted share): ' + ['clip', 'blend', 'override'].map((k) => `**${k}** ${(((s[`attrSev.${k}`] ?? 0) / Math.max(1e-9, tot)) * 100).toFixed(0)} % (${s[`attr.${k}`] ?? 0} hits)`).join(', '), '');
    // every validated frame per role and clip (on and off screen): the denominators of the per-clip tables
    const denom = new Map(gm.entries.filter((e) => e.src === 'frames').map((e) => [`${e.file}|${e.clip}`, e.frames]));
    for (const a of ['override', 'blend', 'clip']) {
      parts.push(mdFamilies(`On screen, attributed to ${a}`, gm.entries, (x) => x === `game:${a}`, s.visibleFrames), '', mdClips(`Worst clips on screen (${a}): frames with a violation / all frames of the clip (on and off screen)`, gm.entries, (x) => x === `game:${a}`, 25, denom), '');
    }
    parts.push(mdFamilies('Off screen (all attributions)', gm.entries, (x) => x.startsWith('game-off'), s.puppetFrames - s.visibleFrames), '');
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.md'), parts.join('\n') + '\n');
  console.log(`[jank] wrote ${path.join(OUT, 'report.md')}`);
}

// ---- contact sheets -----------------------------------------------------------------------------------------------------------------

interface Pick {
  label: string;
  kind: string;
  excess: number;
  snap: Snapshot;
  role: string;
}

function pickWorst(files: [string, (s: string) => boolean][], top: number): Pick[] {
  const picks: Pick[] = [];
  for (const [name, src] of files) {
    const r = load<RunFile>(name);
    if (!r) continue;
    // per family: the clips with the highest score, their worst frame
    const cands: (Pick & { score: number })[] = [];
    for (const e of r.entries) {
      if (!src(e.src)) continue;
      const kre = new RegExp(opt('kinds', '.')), cre = new RegExp(opt('clips', '.'));
      if (!cre.test(e.clip)) continue;
      for (const [k, s] of Object.entries(e.kinds)) {
        if (!s.worst || !kre.test(k)) continue;
        const role = e.src.startsWith('game') ? e.file : String(e.file).includes('umpire') ? 'umpire' : String(e.file).includes('coach') ? 'coach1b' : String(e.file).includes('ballkid') ? 'ballkid' : 'fielder';
        cands.push({ label: `${name.replace('.json', '')} ${e.src} ${e.file} ${e.clip}`, kind: k, excess: s.max, snap: s.worst, score: s.score, role });
      }
    }
    // the same clip in every player file: show the base file's
    cands.sort((a, b) => b.score - a.score || (a.label.includes('player_base') ? -1 : 1));
    const seen = new Set<string>();
    for (const c of cands) {
      // one picture per clip and kind family (the same clip in every player file looks the same)
      const k = `${c.label.replace(/ player_\w+ /, ' ')}|${family(c.kind)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      picks.push(c);
      if (picks.filter((p) => p.label.startsWith(name.replace('.json', ''))).length >= top) break;
    }
  }
  return picks;
}

/** joints a violation kind is about (drawn red) */
function hot(kind: string): string[] {
  const k = kind.split(':')[1] ?? '';
  const side = /[A-Za-z]L\./.test(k) || /-L$/.test(k) ? 'Left' : /[A-Za-z]R\./.test(k) || /-R$/.test(k) ? 'Right' : '';
  if (k.startsWith('elbow') || k.startsWith('forearm')) return [`${side}ForeArm`];
  if (k.startsWith('wrist')) return [`${side}Hand`];
  if (k.startsWith('shoulder') || k.startsWith('clavicle')) return [`${side}Arm`];
  if (k.startsWith('knee')) return [`${side}Leg`];
  if (k.startsWith('hip')) return [`${side}UpLeg`];
  if (k.startsWith('ankle')) return [`${side}Foot`];
  if (k.startsWith('neck')) return ['Neck', 'Head'];
  if (k.startsWith('spine')) return ['Spine2'];
  if (/^(Left|Right)/.test(k)) return [k];
  if (kind.startsWith('foot')) return ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'];
  if (kind.startsWith('bat')) return ['LeftHand', 'RightHand'];
  if (kind.startsWith('body')) return ['LeftHand', 'RightHand', 'LeftForeArm', 'RightForeArm'];
  return [];
}

const LINKS: [string, string][] = [
  ['Hips', 'Spine'], ['Spine', 'Spine1'], ['Spine1', 'Spine2'], ['Spine2', 'Neck'], ['Neck', 'Head'],
  ['Spine2', 'LeftShoulder'], ['LeftShoulder', 'LeftArm'], ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'],
  ['Spine2', 'RightShoulder'], ['RightShoulder', 'RightArm'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
  ['Hips', 'LeftUpLeg'], ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['LeftFoot', 'LeftToeBase'],
  ['Hips', 'RightUpLeg'], ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'], ['RightFoot', 'RightToeBase'],
];

export async function doSheets(top: number) {
  const picks = pickWorst(
    [
      ['static.json', (s) => s === 'static'],
      ['fades.json', () => true],
      ['game.json', (s) => s.startsWith('game:')],
    ],
    top,
  );
  if (!picks.length) return console.log('[jank] sheets: nothing to draw (run static / game first)');
  const dir = path.join(OUT, opt('sheet-dir', 'sheets'));
  if (!flag('keep')) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await withGame('autostart&seed=24&tempo=standard&innings=1&quality=medium&noaudio&tod=day&replays=0&nodof&hud=0', async (page) => {
    await page.evaluate(() => {
      const e = (window as any).engine;
      e.sim.paused = true;
      e.adaptive.enabled = false;
    });
    const frames = (n: number) => page.evaluate((k) => new Promise<void>((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    let i = 0;
    for (const p of picks) {
      const tiles: string[] = [];
      const hj = hot(p.kind);
      for (const view of ['front', 'side', 'detail'] as const) {
        await page.evaluate(([sn, v, role, j]) => (window as any).__jank.studioPose(sn, v, role, j), [p.snap, view, p.role, hj[0] ?? 'Head'] as const);
        await frames(6);
        const joints = (await page.evaluate(() => (window as any).__jank.studioJoints())) as Record<string, number[]>;
        const raw = path.join(dir, `_${i}-${view}.png`);
        await page.screenshot({ path: raw });
        // skeleton overlay (red: the joints the violation is about) and crop to the body
        const hotJ = new Set(hot(p.kind));
        const draw: string[] = [];
        for (const [a, b] of LINKS) if (joints[a] && joints[b]) draw.push(`-stroke`, hotJ.has(b) ? '#ff2020' : '#20e0ff', '-strokewidth', '2', '-draw', `line ${joints[a][0]},${joints[a][1]} ${joints[b][0]},${joints[b][1]}`);
        for (const j of hotJ) if (joints[j]) draw.push('-fill', 'none', '-stroke', '#ff2020', '-strokewidth', '2', '-draw', `circle ${joints[j][0]},${joints[j][1]} ${joints[j][0] + 7},${joints[j][1]}`);
        if (joints.batKnob) draw.push('-stroke', '#ffd000', '-strokewidth', '2', '-draw', `line ${joints.batKnob[0]},${joints.batKnob[1]} ${joints.batTip[0]},${joints.batTip[1]}`);
        const xs = Object.values(joints).map((v) => v[0]), ys = Object.values(joints).map((v) => v[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const vw = 960, vh = 720;
        const size = view === 'detail' ? vh : Math.min(vh, Math.max(260, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 120));
        const cxC = view === 'detail' ? vw / 2 : Math.min(vw - size / 2, Math.max(size / 2, cx)), cyC = view === 'detail' ? vh / 2 : Math.min(vh - size / 2, Math.max(size / 2, cy));
        const tile = path.join(dir, `_${i}-${view}.jpg`);
        execFileSync('convert', [raw, ...draw, '-crop', `${Math.round(size)}x${Math.round(size)}+${Math.round(cxC - size / 2)}+${Math.round(cyC - size / 2)}`, '+repage', '-resize', '300x300', '-gravity', 'north', '-background', '#000', '-extent', '300x300', tile]);
        if (!flag('keep-raw')) fs.rmSync(raw);
        else fs.writeFileSync(raw + '.json', JSON.stringify({ joints, cam: await page.evaluate(() => { const e = (window as any).engine; return { pos: e.camera.position.toArray(), fov: e.camera.fov, aspect: e.camera.aspect, bench: !!e.director.bench, w: e.renderer.domElement.width, h: e.renderer.domElement.height, css: e.renderer.domElement.getBoundingClientRect() }; }) }));
        tiles.push(tile);
      }
      const label = `${p.label}  |  ${p.kind} ${p.excess.toFixed(1)}${p.snap.ctx.t !== undefined ? `  |  t=${p.snap.ctx.t}` : ''}${p.snap.ctx.hint ? ` hint=${p.snap.ctx.hint}` : ''}${p.snap.ctx.attr ? ` (${p.snap.ctx.attr})` : ''}${p.snap.ctx.mirrored || p.snap.ctx.hand === 'L' ? ' LEFTY' : ''}`;
      execFileSync('montage', [...tiles, '-tile', '3x1', '-geometry', '+2+2', '-background', '#222', '-title', label.slice(0, 120), '-pointsize', '11', '-fill', '#fff', path.join(dir, `${String(i).padStart(2, '0')}.jpg`)]);
      for (const t of tiles) fs.rmSync(t);
      i++;
    }
    await page.evaluate(() => (window as any).__jank.studioEnd());
  });
  // one overview per source
  for (const src of ['static', 'fades', 'game']) {
    const ix = picks.map((p, k) => (p.label.startsWith(src) ? k : -1)).filter((k) => k >= 0);
    if (!ix.length) continue;
    execFileSync('montage', [...ix.map((k) => path.join(dir, `${String(k).padStart(2, '0')}.jpg`)), '-tile', '4x', '-geometry', '+3+3', '-background', '#111', path.join(dir, `_${src}.jpg`)]);
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(picks.map((p, k) => ({ k, label: p.label, kind: p.kind, excess: p.excess, ctx: p.snap.ctx })), null, 1));
  console.log(`[jank] sheets: ${picks.length} in ${dir}`);
}

// ---- main ---------------------------------------------------------------------------------------------------------------------------

async function main() {
  const seeds = opt('seeds', '1,2,3').split(',').map(Number);
  const innings = +opt('innings', '9'), tempo = opt('tempo', 'standard'), maxSim = +opt('max-sim', '1e9');
  if (mode === 'trace') {
    // npx tsx tools/jank/run.ts trace --seeds 1 --id EUG-home-b1 --from 905 --to 915: every frame of one puppet (validator output, contact points)
    const [from, to] = [+opt('from', '0'), +opt('to', '10')];
    const q = `autostart&seed=${seeds[0]}&tempo=${tempo}&innings=${innings}&quality=low&noaudio&tod=day&replays=0`;
    const tr = await withGame(q, async (page) => {
      await page.evaluate(() => {
        const e = (window as any).engine;
        e.stop();
        e.fixedDt = 1 / 60;
        e.sim.stepBudgetMs = 1e9;
        e.director.replaysEnabled = false;
        (window as any).__jank.install();
      });
      for (;;) {
        const r = (await page.evaluate(() => (window as any).__jank.run(600))) as { t: number };
        if (r.t > from - 10) break;
      }
      await page.evaluate((id) => ((window as any).__jank.traceId = id), opt('id', ''));
      for (;;) {
        const r = (await page.evaluate(() => (window as any).__jank.run(60))) as { t: number; over: boolean };
        if (r.t > to || r.over) break;
      }
      return page.evaluate(() => (window as any).__jank.trace);
    });
    save(`trace-${opt('id', '')}.json`, tr);
    console.log(`[jank] trace: ${(tr as unknown[]).length} frames -> ${path.join(OUT, `trace-${opt('id', '')}.json`)}`);
    return;
  }
  if (mode === 'static' || mode === 'all') save('static.json', await doStatic());
  if (mode === 'game' || mode === 'all') save('game.json', await doGame(seeds, innings, tempo, maxSim));
  if (mode === 'fades' || mode === 'all') save('fades.json', await doFades());
  if (mode !== 'sheets') writeReport();
  if (mode === 'sheets' || mode === 'all') await doSheets(+opt('top', '16'));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}

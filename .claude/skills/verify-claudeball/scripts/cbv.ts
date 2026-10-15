/**
 * cbv: the verify-claudeball harness. Drives the real game in a Chrome of its own over CDP and writes proof into verify-evidence/<session>/.
 * Run it through the wrapper next to this file: `.claude/skills/verify-claudeball/scripts/cbv <command> [options]` (see ../SKILL.md).
 *
 * One session = one server (vite preview of a prod build under /claudeball/, or the vite dev server) + one Chrome (fresh profile, its own CDP port)
 * + one keeper process (holds the CDP session that owns the emulation, the init scripts and the console log). Every other command connects,
 * acts on the session's single tab and disconnects. Nothing here touches a process it did not start.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { CHROME, ROOT, freePort, sleep } from '../../../../tools/perf/lib';
import { fakeVoicesInit, initScript } from '../../../../tools/perf/probe';

const RUNS = process.env.CBV_RUN_DIR ?? path.join(os.tmpdir(), 'cbv');
const EVIDENCE = path.join(ROOT, 'verify-evidence');
const DIST = path.join(ROOT, 'dist-verify');
const VITE = path.join(ROOT, 'node_modules/vite/bin/vite.js');
const SELF = new URL(import.meta.url).pathname;

// ---- argv ---------------------------------------------------------------------------------------------------------------------

const [cmd = 'help', ...rest] = process.argv.slice(2);
const positional: string[] = [];
const opts: Record<string, string | true> = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = rest[i + 1];
    if (v !== undefined && !v.startsWith('--')) (opts[k] = v), i++;
    else opts[k] = true;
  } else positional.push(a);
}
const opt = (k: string, d = '') => (typeof opts[k] === 'string' ? (opts[k] as string) : d);
const flag = (k: string) => opts[k] !== undefined;

// ---- sessions -----------------------------------------------------------------------------------------------------------------

interface Session {
  id: string;
  root: string;
  dir: string;
  evidence: string;
  mode: 'prod' | 'dev';
  headed: boolean;
  serverPort: number;
  serverPid: number;
  cdpPort: number;
  chromePid: number;
  keeperPid: number;
  /** Chrome's crash handler: it leaves Chrome's process group (re-parented, its own group) and its command line has no profile dir */
  crashpadPid?: number;
  profile: string;
  base: string;
  query: string;
  size: string;
  emu: string;
  git: { head: string; dirty: boolean };
  startedAt: string;
}

function git(...a: string[]) {
  try {
    return execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
const gitState = () => ({ head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'src', 'index.html', 'public', 'vite.config.ts') !== '' });

function sessions(): Session[] {
  if (!fs.existsSync(RUNS)) return [];
  return fs
    .readdirSync(RUNS)
    .map((d) => path.join(RUNS, d, 'session.json'))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as Session)
    .filter((s) => s.root === ROOT)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function current(): Session {
  const want = opt('session', process.env.CBV_SESSION ?? '');
  const all = sessions();
  const s = want ? all.find((x) => x.id === want) : all[all.length - 1];
  if (!s) throw new Error(want ? `no session ${want} (cbv list)` : 'no session for this checkout: run `cbv launch` first');
  return s;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const cmdline = (pid: number) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return '';
  }
};
/** the pid is ours: alive and its command line still carries our marker (guards against a recycled pid) */
const ours = (pid: number, marker: string) => pid > 0 && alive(pid) && cmdline(pid).includes(marker);

/** pids listening on a TCP port (ss -ltnp), empty when the port is closed */
function listeners(port: number): number[] {
  try {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    return [...out.matchAll(/pid=(\d+)/g)].map((m) => +m[1]);
  } catch {
    return [];
  }
}
/** the process group a pid belongs to (we start every child as a group leader) */
/** the crash handler our Chrome's processes name in `--crashpad-handler-pid=` (found through Chrome's own process group) */
function crashpadOf(chromePid: number): number | undefined {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || pgid(+d) !== chromePid) continue;
    const m = /--crashpad-handler-pid=(\d+)/.exec(cmdline(+d));
    if (m) return +m[1];
  }
  return undefined;
}
const pgid = (pid: number) => {
  try {
    return +fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[2];
  } catch {
    return -1;
  }
};

// ---- browser ------------------------------------------------------------------------------------------------------------------

async function connect(s: Session): Promise<{ browser: Browser; page: Page }> {
  let browser: Browser | null = null;
  for (let i = 0; i < 40 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${s.cdpPort}`);
    } catch {
      await sleep(250);
    }
  }
  if (!browser) throw new Error(`cannot reach Chrome on CDP port ${s.cdpPort} (cbv doctor)`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().startsWith(s.base)) ?? ctx.pages()[0] ?? (await ctx.newPage());
  // tsx / esbuild wrap named functions in `__name(...)`; the functions below run in the page, which has no such helper
  await page.evaluate('window.__name = window.__name || ((f) => f)').catch(() => {});
  return { browser, page };
}

/** run fn against the session's tab; the CDP connection is dropped afterwards (Chrome and the tab keep running) */
async function withPage<T>(fn: (page: Page, s: Session) => Promise<T>): Promise<T> {
  const s = current();
  const { page } = await connect(s);
  return fn(page, s);
}

const url = (s: Session, query: string) => `${s.base}${query ? `?${query.replace(/^\?/, '')}` : ''}`;

async function waitReady(page: Page, timeoutMs = 240000) {
  await page.waitForFunction(() => {
    const b = (window as unknown as { __boot?: { tti: number; mode: string } }).__boot;
    return !!b && b.tti > 0;
  }, null, { timeout: timeoutMs, polling: 250 });
  return page.evaluate(() => {
    const b = (window as unknown as { __boot: { tti: number; mode: string; missing: string[]; autostart: boolean; steps: Record<string, number> } }).__boot;
    return { tti: b.tti, mode: b.mode, autostart: b.autostart, missing: b.missing, steps: b.steps };
  });
}

// ---- the in-page collector (installed before any page script by the keeper) -------------------------------------------------------

/** console errors / warnings, page errors, every sim + broadcast event with its sim time, and a tap on the audio output (for `cbv audio`) */
function collectorInit() {
  const w = window as unknown as Record<string, any>;
  const cbv = (w.__cbv = { log: [] as unknown[], events: [] as any[], hooked: false, taps: [] as any[] });
  const push = (k: string, args: unknown[]) => {
    cbv.log.push({ t: Math.round(performance.now()), k, msg: args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'object' ? safe(a) : String(a))).join(' ').slice(0, 600) });
    if (cbv.log.length > 2000) cbv.log.shift();
  };
  const safe = (o: unknown) => {
    try {
      return JSON.stringify(o);
    } catch {
      return String(o);
    }
  };
  for (const k of ['error', 'warn'] as const) {
    const orig = console[k].bind(console);
    console[k] = (...a: unknown[]) => (push(k, a), orig(...a));
  }
  addEventListener('error', (e) => push('pageerror', [e.message, (e as ErrorEvent).filename, (e as ErrorEvent).lineno]));
  addEventListener('unhandledrejection', (e) => push('rejection', [String((e as PromiseRejectionEvent).reason)]));
  const strip = (ev: Record<string, unknown>) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ev)) o[k] = v && typeof v === 'object' && 'x' in (v as object) ? [(v as any).x, (v as any).y, (v as any).z].map((n: number) => Math.round(n * 100) / 100) : v;
    return o;
  };
  const hook = setInterval(() => {
    const e = w.engine;
    if (!e || cbv.hooked) return;
    cbv.hooked = true;
    clearInterval(hook);
    e.sim.on((te: { simTime: number; event: Record<string, unknown> }) => {
      if (te.event.type === 'broadcast') return; // the same events arrive below, from the director
      cbv.events.push({ t: Math.round(te.simTime * 100) / 100, ...strip(te.event) });
      if (cbv.events.length > 6000) cbv.events.shift();
    });
    e.broadcast.on((ev: Record<string, unknown>) => {
      cbv.events.push({ t: Math.round(e.sim.state.time * 100) / 100, ...strip(ev), type: `broadcast.${ev.type}` });
      if (cbv.events.length > 6000) cbv.events.shift();
    });
  }, 100);
  // audio: every graph that reaches the speakers also feeds a MediaStream we can record (the game's own nodes are untouched)
  const AN = (w.AudioNode as typeof AudioNode | undefined)?.prototype;
  if (AN) {
    const orig = AN.connect as (...a: unknown[]) => unknown;
    (AN as any).connect = function (this: AudioNode, ...a: unknown[]) {
      const dest = a[0];
      if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode) {
        const ctx = this.context as AudioContext & { __cbvTap?: MediaStreamAudioDestinationNode };
        if (!ctx.__cbvTap && 'createMediaStreamDestination' in ctx) {
          ctx.__cbvTap = ctx.createMediaStreamDestination();
          cbv.taps.push(ctx);
        }
        if (ctx.__cbvTap) orig.call(this, ctx.__cbvTap);
      }
      return orig.apply(this, a);
    };
  }
}

// ---- in-page readers ------------------------------------------------------------------------------------------------------------

/** a compact, JSON-safe picture of the app, the game and the HUD (runs in the page) */
function readState() {
  const w = window as unknown as Record<string, any>;
  const e = w.engine;
  const txt = (sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    return el.innerText.replace(/\s+/g, ' ').trim() || null;
  };
  const dialogs = [...document.querySelectorAll('[role=dialog]')]
    .filter((d) => !(d as HTMLElement).hidden)
    .map((d) => ({ label: d.getAttribute('aria-label'), heading: (d.querySelector('h1,h2') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? null }));
  const bootEl = document.getElementById('cb-boot');
  const boot = bootEl && bootEl.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ? (bootEl.innerText.replace(/\s+/g, ' ').trim() || 'shown') : null;
  const b = w.__boot;
  const out: Record<string, unknown> = { url: location.href, boot: b ? { tti: b.tti, mode: b.mode, missing: b.missing } : null, loadingScreen: boot, dialogs };
  if (!e) return out;
  const s = e.sim.state;
  const d = e.director;
  const appMode = boot && !b?.tti ? 'boot' : dialogs.some((x) => x.label === 'Claudeball menu') ? 'menu' : dialogs.some((x) => x.label === 'Game menu') ? (document.querySelector('[role=dialog][aria-label="Game menu"]')?.textContent?.includes('Play again') ? 'over' : 'paused') : boot ? 'curtain' : e.attract ? 'attract' : 'playing';
  const pc = s.pitchClock;
  const a = w.__audioDebug?.state;
  Object.assign(out, {
    appMode,
    sim: { kind: e.sim.kind, time: +s.time.toFixed(2), paused: e.sim.paused, hold: e.sim.hold, speed: e.sim.speed, skipping: e.sim.skipping },
    game: {
      inning: s.inning, half: s.half, outs: s.outs, count: s.count, score: s.score, runners: s.runners, over: s.over,
      batter: s.batter?.name ?? null, pitcher: s.pitcher?.name ?? null, pitchCount: s.pitchCount ?? null,
      phase: s.phase ?? null, phaseDetail: s.phaseDetail ?? null, lull: s.lull ?? null, umpireCall: s.umpireCall ?? null,
      teams: { away: s.teams.away.abbr ?? s.teams.away.name, home: s.teams.home.abbr ?? s.teams.home.name },
      pitchClock: pc ? { running: pc.running, remaining: +pc.remainingSec.toFixed(1), kind: pc.kind, violation: pc.violation, disengagementsLeft: pc.disengagementsLeft } : null,
    },
    director: { shot: d.shot, auto: d.auto, broll: d.broll?.shot?.kind ?? null, replaying: !!d.replay, replayCaption: d.replay?.caption ?? null, replaysEnabled: d.replaysEnabled, brollEnabled: d.brollEnabled },
    render: { quality: e.qualityName, tod: e.env.todName, fps: Math.round(e.fps), scale: +e.adaptive.scale.toFixed(2), fixedDt: e.fixedDt ?? null, viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`, coarse: matchMedia('(pointer: coarse)').matches },
    hud: { scorebug: txt('.cb-bug'), clock: txt('.cb-clk'), call: txt('.cb-call'), ticker: txt('.cb-tick'), replay: txt('.cb-rep'), card: txt('.cb-card'), final: txt('.cb-final'), box: txt('.cb-box'), captions: txt('.cb-caps') },
    audio: a ? { ctx: a.ctx, ready: a.ready, prepared: a.prepared, muted: a.muted, voices: a.voices, phase: a.phase, organ: a.organ, music: a.music?.playing ?? null, booth: (a.booth?.transcript ?? []).slice(-4) } : w.__audioDebug === undefined ? 'no audio controller (noaudio, or no game started from a click yet)' : null,
  });
  return out;
}

// ---- commands -----------------------------------------------------------------------------------------------------------------

const HEADLESS_GPU = ['--headless=new', '--use-angle=vulkan', '--enable-features=Vulkan,UseSkiaRenderer', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
const HEADED_GPU = ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--window-position=0,0'];

async function launch() {
  const id = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = path.join(RUNS, id);
  const profile = path.join(dir, 'profile');
  const evidence = path.join(EVIDENCE, id);
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const mode = flag('dev') ? 'dev' : 'prod';
  const g = gitState();
  if (mode === 'prod') {
    const stamp = path.join(DIST, 'cbv-stamp.json');
    const reuse = flag('no-build') && fs.existsSync(path.join(DIST, 'index.html'));
    if (!reuse) {
      console.log('[cbv] building the prod bundle (CB_BASE=/claudeball/ vite build --outDir dist-verify)...');
      const b = spawnSync(process.execPath, [VITE, 'build', '--outDir', DIST, '--emptyOutDir'], { cwd: ROOT, env: { ...process.env, CB_BASE: '/claudeball/' }, encoding: 'utf8' });
      fs.writeFileSync(path.join(evidence, 'build.log'), `${b.stdout}\n${b.stderr}`);
      if (b.status !== 0) fs.rmSync(dir, { recursive: true, force: true }); // nothing was started yet: only the scratch folder to remove
      if (b.status !== 0) throw new Error(`vite build failed (${path.relative(ROOT, evidence)}/build.log): ${b.stderr.split('\n').slice(-5).join(' | ')}`);
      for (const l of b.stderr.split('\n')) if (/WARNING/.test(l)) console.log(`[cbv] build: ${l.trim()}`);
      fs.writeFileSync(stamp, JSON.stringify({ ...g, base: '/claudeball/', builtAt: new Date().toISOString() }, null, 1));
    }
  }
  const serverPort = +opt('port', '') || (await freePort());
  const serverLog = fs.openSync(path.join(dir, 'server.log'), 'a');
  const serverArgs = mode === 'prod' ? [VITE, 'preview', '--host', '127.0.0.1', '--port', String(serverPort), '--strictPort', '--outDir', DIST] : [VITE, '--host', '127.0.0.1', '--port', String(serverPort), '--strictPort'];
  const server = spawn(process.execPath, serverArgs, { cwd: ROOT, env: { ...process.env, ...(mode === 'prod' ? { CB_BASE: '/claudeball/' } : {}) }, stdio: ['ignore', serverLog, serverLog], detached: true });
  server.unref();
  const base = `http://127.0.0.1:${serverPort}${mode === 'prod' ? '/claudeball/' : '/'}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try {
      up = (await fetch(base)).ok;
    } catch {
      await sleep(250);
    }
  }
  const size = opt('size', '1280x720');
  const [w, h] = size.split('x').map(Number);
  const cdpPort = await freePort();
  const headed = flag('headed');
  const chromeArgs = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--mute-audio',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--window-size=${w},${h}`,
    ...(headed ? HEADED_GPU : HEADLESS_GPU),
    ...(opt('chrome-flags') ? opt('chrome-flags').split(' ') : []),
    'about:blank',
  ];
  const chromeLog = fs.openSync(path.join(dir, 'chrome.log'), 'a');
  const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', chromeLog, chromeLog], detached: true });
  chrome.unref();
  const s: Session = {
    id, root: ROOT, dir, evidence, mode, headed, serverPort, serverPid: server.pid!, cdpPort, chromePid: chrome.pid!, keeperPid: 0, profile, base,
    query: opt('query', 'menu=1&seed=24&quality=low'), size, emu: opt('emu', ''), git: g, startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s, null, 1));
  if (!up) {
    console.error(`[cbv] the server did not answer at ${base} (see ${dir}/server.log); cleaning up`);
    await stop(s);
    process.exit(1);
  }
  // the keeper holds the CDP session that owns the emulation, the init scripts (they persist across reloads only while it lives) and the console log
  const keeperLog = fs.openSync(path.join(dir, 'keeper.log'), 'a');
  const keeper = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), SELF, '_keep', '--session', id], { cwd: ROOT, stdio: ['ignore', keeperLog, keeperLog], detached: true });
  keeper.unref();
  s.keeperPid = keeper.pid!;
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s, null, 1));
  for (let i = 0; i < 120 && !fs.existsSync(path.join(dir, 'keeper.ready')); i++) await sleep(250);
  if (!fs.existsSync(path.join(dir, 'keeper.ready'))) {
    console.error(`[cbv] the keeper did not attach (see ${dir}/keeper.log); cleaning up`);
    await stop(s);
    process.exit(1);
  }
  const { page } = await connect(s);
  await page.goto(url(s, s.query), { waitUntil: 'load' });
  const boot = await waitReady(page);
  s.crashpadPid = crashpadOf(s.chromePid);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s, null, 1));
  console.log(JSON.stringify({ session: id, url: url(s, s.query), mode, headed, evidence, boot }, null, 1));
  console.log(`[cbv] ready. Next: cbv doctor`);
  process.exit(0);
}

/** the background keeper (started by launch; not for direct use) */
async function keep() {
  const s = current();
  const { browser, page } = await connect(s);
  const cdp = await page.context().newCDPSession(page);
  if (!s.emu) {
    // headless Chrome's window has no fixed viewport (1280x720 gives 1280x633): pin the CSS viewport to --size
    const [w, h] = s.size.split('x').map(Number);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  } else {
    const m = /^(\d+)x(\d+)@([\d.]+)$/.exec(s.emu);
    if (!m) throw new Error(`--emu wants WxH@DPR, got ${s.emu}`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: +m[1], height: +m[2], deviceScaleFactor: +m[3], mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  }
  await page.addInitScript(initScript(collectorInit));
  await page.addInitScript(initScript(fakeVoicesInit)); // headless Chrome has no speech voices: without these the booth and the captions never run
  const consoleFile = path.join(s.evidence, 'console.jsonl');
  const rec = (o: Record<string, unknown>) => fs.appendFileSync(consoleFile, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) || /^\[(boot|cb-|warm)/.test(m.text()) ? rec({ k: m.type(), msg: m.text().slice(0, 800) }) : undefined);
  page.on('pageerror', (e) => rec({ k: 'pageerror', msg: String(e).slice(0, 800) }));
  page.on('response', (r) => r.status() >= 400 && rec({ k: 'http', status: r.status(), url: r.url() }));
  page.on('framenavigated', (f) => f === page.mainFrame() && rec({ k: 'nav', url: f.url() }));
  fs.writeFileSync(path.join(s.dir, 'keeper.ready'), String(process.pid));
  browser.on('disconnected', () => process.exit(0));
  setInterval(() => {}, 1 << 30);
}

async function doctor() {
  const s = current();
  const checks: { name: string; ok: boolean | 'warn'; detail: string }[] = [];
  const add = (name: string, ok: boolean | 'warn', detail: string) => checks.push({ name, ok, detail });
  add('session', true, `${s.id} (${s.mode}${s.headed ? ', headed' : ', headless'}${s.emu ? `, emu ${s.emu}` : ''}) evidence ${path.relative(ROOT, s.evidence)}`);
  // processes and ports: ours, by pid + marker, never by name
  const srvOk = ours(s.serverPid, `--port ${s.serverPort}`);
  const owners = listeners(s.serverPort);
  add('server', srvOk && owners.includes(s.serverPid), `pid ${s.serverPid} ${srvOk ? 'alive' : 'GONE'}; port ${s.serverPort} listeners ${owners.join(',') || 'none'}; cwd ${fs.existsSync(`/proc/${s.serverPid}/cwd`) ? fs.readlinkSync(`/proc/${s.serverPid}/cwd`) : '?'}`);
  const chOk = ours(s.chromePid, s.profile);
  const cdpOwners = listeners(s.cdpPort);
  add('chrome', chOk && cdpOwners.length > 0 && cdpOwners.every((p) => pgid(p) === s.chromePid || p === s.chromePid), `pid ${s.chromePid} ${chOk ? 'alive' : 'GONE'}; CDP ${s.cdpPort} listeners ${cdpOwners.join(',') || 'none'}; profile ${s.profile}`);
  add('keeper', ours(s.keeperPid, s.id), `pid ${s.keeperPid} ${ours(s.keeperPid, s.id) ? 'alive (emulation, init scripts, console log)' : 'GONE: reloads lose the collector and fake voices; relaunch'}`);
  // the right build
  const now = gitState();
  if (s.mode === 'prod') {
    const stampFile = path.join(DIST, 'cbv-stamp.json');
    const stamp = fs.existsSync(stampFile) ? (JSON.parse(fs.readFileSync(stampFile, 'utf8')) as { head: string; dirty: boolean; builtAt: string }) : null;
    let served = '';
    try {
      served = await (await fetch(s.base)).text();
    } catch {
      /* down */
    }
    const built = fs.existsSync(path.join(DIST, 'index.html')) ? fs.readFileSync(path.join(DIST, 'index.html'), 'utf8') : '';
    const fresh = !!stamp && stamp.head === now.head && !stamp.dirty && !now.dirty;
    add('build', !!served && served === built ? (fresh ? true : 'warn') : false, `served index ${served && served === built ? '== dist-verify/index.html' : 'DIFFERS from dist-verify (another build?)'}; built ${stamp?.builtAt ?? '?'} at ${stamp?.head.slice(0, 9) ?? '?'}${stamp?.dirty ? '+dirty' : ''}, checkout ${now.head.slice(0, 9)}${now.dirty ? '+dirty' : ''}${fresh ? '' : ' -> relaunch without --no-build to test the current code'}`);
  } else {
    const cwd = fs.existsSync(`/proc/${s.serverPid}/cwd`) ? fs.readlinkSync(`/proc/${s.serverPid}/cwd`) : '';
    add('build', cwd === ROOT, `dev server cwd ${cwd || '?'} (serves this checkout's live sources, HMR)`);
  }
  // the page
  if (chOk) {
    try {
      const { page } = await connect(s);
      const r = await page.evaluate(() => {
        const w = window as unknown as Record<string, any>;
        let gpu = 'no engine';
        const e = w.engine;
        if (e) {
          const gl = e.renderer.getContext();
          const x = gl.getExtension('WEBGL_debug_renderer_info');
          gpu = x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown';
        }
        const b = w.__boot;
        const a = w.__audioDebug?.state;
        return {
          url: location.href, gpu, webgl2: !!e?.renderer.capabilities.isWebGL2, boot: b ? { tti: b.tti, mode: b.mode, missing: b.missing } : null, simKind: e?.sim.kind,
          collector: !!w.__cbv, hooked: !!w.__cbv?.hooked, errors: (w.__cbv?.log ?? []).filter((l: { k: string }) => l.k !== 'warn').length,
          audio: a ? `${a.ctx}${a.ready ? ', sounds ready' : `, preparing ${a.prepared}`}${a.muted ? ', muted' : ''}` : w.__audioDebug === undefined ? (new URLSearchParams(location.search).has('noaudio') ? 'off (?noaudio)' : 'no controller yet (attached by the Start Game click / autostart)') : 'controller without state',
          speech: typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices().length : 0,
        };
      });
      add('page', r.url.startsWith(s.base), r.url);
      add('webgl', r.webgl2 && !/swiftshader|llvmpipe|software/i.test(r.gpu) ? true : r.webgl2 ? 'warn' : false, `${r.gpu}${/swiftshader|llvmpipe|software/i.test(r.gpu) ? ' (SOFTWARE: no GPU; screenshots ok, fps meaningless)' : ''}`);
      add('boot', !!r.boot && r.boot.tti > 0 && r.boot.missing.length === 0, r.boot ? `interactive in ${r.boot.tti} ms, mode ${r.boot.mode}, missing assets: ${r.boot.missing.join(', ') || 'none'}` : 'no __boot (not the game?)');
      add('sim', r.simKind === 'sim', `sim kind ${r.simKind} (mock = ?mock or src/sim missing)`);
      add('collector', r.collector && r.hooked, r.collector ? (r.hooked ? 'events + console collector installed' : 'installed, engine not hooked yet') : 'MISSING (page loaded without the keeper: cbv reload)');
      add('audio', true, `${r.audio}; speech voices ${r.speech}`);
      add('console', r.errors === 0 ? true : 'warn', `${r.errors} error(s) captured in the page (cbv log)`);
    } catch (err) {
      add('page', false, String(err).split('\n')[0]);
    }
  }
  const bad = checks.filter((c) => c.ok === false).length;
  for (const c of checks) console.log(`${c.ok === true ? 'ok  ' : c.ok === 'warn' ? 'WARN' : 'FAIL'} ${c.name.padEnd(9)} ${c.detail}`);
  fs.appendFileSync(path.join(s.evidence, 'doctor.txt'), `# ${new Date().toISOString()}\n${checks.map((c) => `${c.ok === true ? 'ok' : c.ok === 'warn' ? 'WARN' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n')}\n`);
  console.log(bad ? `[cbv] doctor: ${bad} failure(s): do not drive this instance` : '[cbv] doctor: worth driving');
  process.exit(bad ? 1 : 0);
}

async function stop(s: Session) {
  const killed: string[] = [];
  const kill = async (pid: number, marker: string, label: string) => {
    if (!ours(pid, marker)) return;
    const g = pgid(pid);
    try {
      process.kill(g === pid ? -pid : pid, 'SIGTERM');
    } catch {
      /* gone */
    }
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(150);
    if (alive(pid)) {
      try {
        process.kill(g === pid ? -pid : pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    killed.push(`${label} ${pid}`);
  };
  await kill(s.keeperPid, s.id, 'keeper');
  await kill(s.chromePid, s.profile, 'chrome');
  await kill(s.serverPid, `--port ${s.serverPort}`, 'server');
  // the crash handler usually exits with Chrome; if it outlived it, it is ours to remove (same pid we recorded, still a crashpad handler)
  if (s.crashpadPid) {
    for (let i = 0; i < 10 && ours(s.crashpadPid, 'chrome_crashpad_handler'); i++) await sleep(200);
    if (ours(s.crashpadPid, 'chrome_crashpad_handler')) {
      try {
        process.kill(s.crashpadPid, 'SIGTERM');
        killed.push(`crashpad ${s.crashpadPid}`);
      } catch {
        /* gone */
      }
    }
  }
  await sleep(300);
  const open = [s.serverPort, s.cdpPort].filter((p) => listeners(p).length);
  for (const f of ['server.log', 'chrome.log', 'keeper.log']) if (fs.existsSync(path.join(s.dir, f)) && fs.existsSync(s.evidence)) fs.copyFileSync(path.join(s.dir, f), path.join(s.evidence, f));
  fs.rmSync(s.dir, { recursive: true, force: true });
  const files = fs.existsSync(s.evidence) ? fs.readdirSync(s.evidence) : [];
  console.log(`[cbv] stopped ${s.id}: ${killed.join(', ') || 'nothing was running'}; ports ${open.length ? `STILL OPEN ${open.join(',')}` : 'closed'}; scratch removed; evidence kept: ${path.relative(ROOT, s.evidence)}/ (${files.length} files)`);
  return open.length === 0;
}

async function goto(query: string, reload = false) {
  await withPage(async (page, s) => {
    if (reload) await page.reload({ waitUntil: 'load' });
    else await page.goto(url(s, query), { waitUntil: 'load' });
    const boot = await waitReady(page);
    console.log(JSON.stringify({ url: page.url(), boot }));
  });
}

async function state() {
  await withPage(async (page, s) => {
    const st = await page.evaluate(readState);
    const name = opt('save', '');
    if (name) fs.writeFileSync(path.join(s.evidence, `${name}.state.json`), JSON.stringify(st, null, 1));
    console.log(JSON.stringify(st, null, flag('compact') ? 0 : 1));
  });
}

async function shot(name: string) {
  if (!name) throw new Error('cbv shot <name>');
  await withPage(async (page, s) => {
    const cdp = await page.context().newCDPSession(page);
    const d = (await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 })) as { data: string };
    const file = path.join(s.evidence, `${name}.jpg`);
    fs.writeFileSync(file, Buffer.from(d.data, 'base64'));
    const st = await page.evaluate(readState);
    fs.writeFileSync(path.join(s.evidence, `${name}.state.json`), JSON.stringify(st, null, 1));
    console.log(`${path.relative(ROOT, file)} (+ .state.json)  ${(st as { appMode?: string }).appMode ?? ''} ${JSON.stringify((st as { hud?: { scorebug?: string } }).hud?.scorebug ?? '')}`);
  });
}

async function aria(name: string) {
  await withPage(async (page, s) => {
    const snap = await page.locator('body').ariaSnapshot();
    if (name) fs.writeFileSync(path.join(s.evidence, `${name}.aria.txt`), snap);
    console.log(snap);
  });
}

async function click() {
  await withPage(async (page, s) => {
    const role = opt('role');
    const loc = opt('testid') ? page.getByTestId(opt('testid')) : role ? page.getByRole(role as Parameters<Page['getByRole']>[0], { name: opt('name') || undefined, exact: flag('exact') }) : page.getByText(opt('text'), { exact: true });
    const target = opt('in') ? page.getByRole('dialog', { name: opt('in') }).locator(loc) : loc;
    if (s.emu) {
      // a phone: a real touch at the element's centre (a mouse click turned into touch races the menu's fade-out and reports a false timeout)
      const box = await target.first().boundingBox({ timeout: +opt('timeout', '10000') });
      if (!box) throw new Error('element not visible');
      const cdp = await page.context().newCDPSession(page);
      const pt = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await target.first().click({ timeout: +opt('timeout', '10000') });
    await sleep(+opt('settle', '400'));
    console.log(`clicked ${opt('testid') ? `testid=${opt('testid')}` : role ? `${role} "${opt('name')}"` : `text "${opt('text')}"`}`);
  });
}

async function press(keys: string[]) {
  await withPage(async (page) => {
    for (const k of keys) {
      await page.keyboard.press(k);
      await sleep(+opt('gap', '250'));
    }
    console.log(`pressed ${keys.join(' ')}`);
  });
}

async function tap(x: number, y: number) {
  await withPage(async (page) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    console.log(`tapped ${x},${y}`);
  });
}

async function evaluate(js: string) {
  await withPage(async (page) => {
    const r = await page.evaluate(`(async () => { const engine = window.engine; const s = engine?.sim.state; return (${js}); })()`);
    console.log(JSON.stringify(r, null, 1));
  });
}

/**
 * Let the game play until a condition holds: `s` = the sim's current state, `ev` = one event (sim + broadcast, see `cbv events`), `e` = the engine.
 * The game runs at 1x / 2x / 4x through the same knob as the 1 / 2 / 3 keys; `--turbo` (a harness knob, label it) fixes the step to 0.1 s per frame at
 * 4x so a long jump takes seconds. Replays hold the sim, so they are switched off during the jump unless --keep-replays; the settings are restored after.
 */
async function ff(cond: string) {
  if (!cond) throw new Error('cbv ff "<condition on s / ev / e>"');
  await withPage(async (page) => {
    const r = await page.evaluate(
      ([cond, speed, timeoutMs, pause, keepReplays, turbo]) =>
        new Promise((res) => {
          const w = window as unknown as Record<string, any>;
          const e = w.engine;
          const f = new Function('s', 'ev', 'e', `return (${cond});`) as (s: unknown, ev: unknown, e: unknown) => boolean;
          const prev = { speed: e.sim.speed, replays: e.director.replaysEnabled, fixedDt: e.fixedDt, budget: e.sim.stepBudgetMs };
          if (!keepReplays) e.director.replaysEnabled = false;
          e.sim.speed = speed;
          if (turbo) {
            e.fixedDt = 0.1;
            e.sim.stepBudgetMs = 1e9;
          }
          const restore = () => {
            e.sim.speed = prev.speed;
            e.director.replaysEnabled = prev.replays;
            e.fixedDt = prev.fixedDt;
            e.sim.stepBudgetMs = prev.budget;
          };
          let idx = w.__cbv?.events.length ?? 0;
          const t0 = performance.now();
          // a condition that throws every time (a typo: `s.runner`, `ev.typ.x`) must not read as "never happened"
          let evaluated = false;
          let firstError: string | null = null;
          const test = (s: unknown, ev: unknown) => {
            try {
              const r = !!f(s, ev, e);
              evaluated = true;
              return r;
            } catch (err) {
              firstError ??= String(err);
              return false; // e.g. `ev.type` while ev is null: not yet
            }
          };
          const tick = () => {
            const s = e.sim.state;
            let hitEv = null;
            let hit = test(s, null);
            const evs = w.__cbv ? w.__cbv.events.slice(idx) : [];
            idx = w.__cbv?.events.length ?? 0;
            for (const ev of evs) if (!hit && test(s, ev)) ((hit = true), (hitEv = ev));
            if (hit || s.over || performance.now() - t0 > timeoutMs) {
              if (pause && hit) e.sim.paused = true;
              restore();
              res({ ok: hit, over: s.over, wallMs: Math.round(performance.now() - t0), simTime: +s.time.toFixed(2), event: hitEv, inning: s.inning, half: s.half, outs: s.outs, count: s.count, runners: s.runners, score: s.score, ...(evaluated ? {} : { conditionError: firstError ?? 'never evaluated' }) });
            } else requestAnimationFrame(tick);
          };
          tick();
        }),
      [cond, +opt('speed', '4'), +opt('timeout', '300') * 1000, flag('pause'), flag('keep-replays'), flag('turbo')] as const,
    );
    console.log(JSON.stringify(r));
    const ce = (r as { conditionError?: string }).conditionError;
    if (ce) console.error(`[cbv] the condition never evaluated without an error: ${ce} (a typo? s = state, ev = event, e = engine)`);
    if (!(r as { ok: boolean }).ok) process.exitCode = ce ? 4 : 3;
  });
}

/**
 * The player's own fast-forward: press `n` (next half inning) or `.` (next batter) and let the skip finish, repeatedly, until `cond` holds
 * (`s`, `e` as in ff; no events: skipped plays do not cut cameras) or the game is over.
 */
async function next(kind: string) {
  const key = kind === 'batter' ? '.' : kind === 'half' ? 'n' : '';
  if (!key) throw new Error('cbv next half|batter [--until "<cond>"] [--max 30]');
  const cond = opt('until', 'false');
  await withPage(async (page) => {
    const max = +opt('max', '30');
    let r: Record<string, unknown> = {};
    for (let i = 1; i <= max; i++) {
      await page.keyboard.press(key);
      r = (await page.evaluate(
        (cond) =>
          new Promise((res) => {
            const e = (window as unknown as Record<string, any>).engine;
            const f = new Function('s', 'e', `return (${cond});`) as (s: unknown, e: unknown) => boolean;
            const t0 = performance.now();
            const tick = () => {
              const s = e.sim.state;
              if ((!e.sim.skipping && performance.now() - t0 > 100) || performance.now() - t0 > 60000) {
                let hit = false;
                let err: string | null = null;
                try {
                  hit = !!f(s, e);
                } catch (x) {
                  err = String(x);
                }
                res({ hit, err, over: s.over, keysEnabled: e.keysEnabled, simTime: +s.time.toFixed(2), inning: s.inning, half: s.half, outs: s.outs, runners: s.runners, score: s.score, batter: s.batter?.name ?? null });
              } else requestAnimationFrame(tick);
            };
            tick();
          }),
        cond,
      )) as Record<string, unknown>;
      console.log(JSON.stringify({ press: i, key, ...r }));
      if (r.err && i === 1) console.error(`[cbv] the condition threw: ${r.err} (a typo? s = state, e = engine)`);
      if (r.hit || r.over) break;
      if (!r.keysEnabled) throw new Error('hot keys are off (menu, pause or game-over screen up): the skip keys only work while playing');
    }
    if (!r.hit && !(r.over && cond === 'false')) process.exitCode = 3;
  });
}

async function events() {
  await withPage(async (page, s) => {
    const all = (await page.evaluate(() => (window as unknown as { __cbv?: { events: unknown[] } }).__cbv?.events ?? [])) as { t: number; type: string }[];
    const since = +opt('since', '-1');
    const types = opt('type') ? opt('type').split(',') : null;
    const list = all.filter((e) => e.t >= since && (!types || types.some((t) => e.type === t || e.type.startsWith(`${t}.`))));
    const name = opt('save', '');
    if (name) fs.writeFileSync(path.join(s.evidence, `${name}.events.jsonl`), list.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const tail = +opt('tail', '40');
    for (const e of list.slice(-tail)) console.log(JSON.stringify(e));
    console.log(`[cbv] ${list.length} event(s)${name ? ` -> ${path.relative(ROOT, path.join(s.evidence, `${name}.events.jsonl`))}` : ''}`);
  });
}

async function log() {
  await withPage(async (page, s) => {
    const l = (await page.evaluate(() => (window as unknown as { __cbv?: { log: unknown[] } }).__cbv?.log ?? [])) as { k: string; msg: string }[];
    const show = flag('warn') ? l : l.filter((x) => x.k !== 'warn');
    for (const x of show.slice(-+opt('tail', '40'))) console.log(`${x.k.padEnd(9)} ${x.msg}`);
    console.log(`[cbv] page: ${show.length} ${flag('warn') ? 'error/warn' : 'error'} line(s) since the last load; whole session (keeper): ${path.relative(ROOT, path.join(s.evidence, 'console.jsonl'))}`);
  });
}

async function perfCmd() {
  await withPage(async (page, s) => {
    const secs = +opt('secs', '5');
    const r = await page.evaluate(
      (secs) =>
        new Promise((res) => {
          const w = window as unknown as Record<string, any>;
          const e = w.engine;
          const dts: number[] = [];
          let last = performance.now();
          const t0 = last;
          const f = () => {
            const n = performance.now();
            dts.push(n - last);
            last = n;
            if (n - t0 < secs * 1000) requestAnimationFrame(f);
            else {
              const sorted = [...dts].sort((a, b) => a - b);
              const q = (p: number) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
              res({ frames: dts.length, fps: +(dts.length / secs).toFixed(1), p50ms: q(0.5), p95ms: q(0.95), maxms: q(1), quality: e.qualityName, scale: +e.adaptive.scale.toFixed(2), perf: w.__perf ? w.__perf.stats(Math.min(dts.length, 300)) : 'add perf=1 to the query for laps / passes / draw calls' });
            }
          };
          requestAnimationFrame(f);
        }),
      secs,
    );
    const name = opt('save', '');
    if (name) fs.writeFileSync(path.join(s.evidence, `${name}.perf.json`), JSON.stringify(r, null, 1));
    console.log(JSON.stringify(r, null, 1));
  });
}

/** record the game's audio output (the collector's tap) for --secs, save as .webm and print its level per second */
async function audio(name: string) {
  if (!name) throw new Error('cbv audio <name> [--secs 6]');
  await withPage(async (page, s) => {
    const secs = +opt('secs', '6');
    const r = (await page.evaluate(
      (secs) =>
        new Promise<{ error?: string; b64?: string; mime?: string; rms?: number[]; peak?: number; ctx?: string; rate?: number }>((res) => {
          const w = window as unknown as Record<string, any>;
          const ctx = (w.__cbv?.taps ?? []).find((c: AudioContext) => c.state === 'running') ?? w.__cbv?.taps?.[0];
          if (!ctx) return res({ error: 'no audio graph has reached the speakers yet (noaudio? no Start Game click? cbv state shows audio)' });
          const rec = new MediaRecorder(ctx.__cbvTap.stream, { mimeType: 'audio/webm' });
          const chunks: Blob[] = [];
          rec.ondataavailable = (ev) => chunks.push(ev.data);
          rec.onstop = async () => {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const buf = await blob.arrayBuffer();
            let rms: number[] = [];
            let peak = 0;
            try {
              const dec = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(buf.slice(0));
              const d = dec.getChannelData(0);
              for (let i = 0; i < d.length; i += dec.sampleRate) {
                let sum = 0;
                const end = Math.min(d.length, i + dec.sampleRate);
                for (let j = i; j < end; j++) (sum += d[j] * d[j]), (peak = Math.max(peak, Math.abs(d[j])));
                rms.push(+(20 * Math.log10(Math.sqrt(sum / (end - i)) + 1e-9)).toFixed(1));
              }
            } catch {
              rms = [];
            }
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            res({ b64: btoa(bin), mime: blob.type, rms, peak: +(20 * Math.log10(peak + 1e-9)).toFixed(1), ctx: ctx.state, rate: ctx.sampleRate });
          };
          rec.start(250);
          setTimeout(() => rec.stop(), secs * 1000);
        }),
      secs,
    )) as { error?: string; b64?: string; rms?: number[]; peak?: number; ctx?: string; rate?: number };
    if (r.error) {
      console.error(`[cbv] ${r.error}`);
      process.exitCode = 1;
      return;
    }
    const file = path.join(s.evidence, `${name}.webm`);
    fs.writeFileSync(file, Buffer.from(r.b64!, 'base64'));
    const meta = { file: path.relative(ROOT, file), secs, context: r.ctx, sampleRate: r.rate, peakDbfs: r.peak, rmsDbfsPerSecond: r.rms };
    fs.writeFileSync(path.join(s.evidence, `${name}.audio.json`), JSON.stringify(meta, null, 1));
    console.log(JSON.stringify(meta));
  });
}

function sheet() {
  const s = current();
  const name = opt('name', 'sheet');
  const pat = new RegExp(opt('match', '.'));
  const files = fs.readdirSync(s.evidence).filter((f) => f.endsWith('.jpg') && !f.startsWith('_') && pat.test(f)).sort();
  if (!files.length) throw new Error('no screenshots in the evidence folder yet (cbv shot <name>)');
  const out = path.join(s.evidence, `_${name}.jpg`);
  execFileSync('montage', ['-label', '%t', '-pointsize', '16', '-geometry', '480x270+4+4', '-tile', `${Math.min(4, files.length)}x`, '-background', '#222', '-fill', 'white', ...files.map((f) => path.join(s.evidence, f)), out]);
  console.log(`${path.relative(ROOT, out)} (${files.length} shots)`);
}

/**
 * The sim alone in Node (no browser): play seeds until a condition holds and print where, so a drive can jump there. Same condition language as `ff`
 * (`s` = engine-shaped state, `ev` = engine event). Sim events only: director events (broadcast.*: replays, B-roll, cuts) exist only in the page.
 */
async function seek(cond: string) {
  if (!cond) throw new Error('cbv seek "<condition>" [--seeds 1-20] [--tempo broadcast] [--innings 9] [--max 4] [--limit 3600]');
  const { createGame } = await import('../../../../src/sim/index');
  const { RealSimAdapter } = await import('../../../../src/engine/realSimAdapter');
  const f = new Function('s', 'ev', `return (${cond});`) as (s: unknown, ev: unknown) => boolean;
  const [a, b = a] = opt('seeds', '24').split('-').map(Number);
  const tempo = opt('tempo', 'broadcast') as 'broadcast';
  const innings = +opt('innings', '9');
  const max = +opt('max', '3');
  const limit = +opt('limit', '20000'); // seconds of game time per seed
  const all: unknown[] = [];
  for (let seed = a; seed <= b; seed++) {
    const g = new RealSimAdapter(createGame({ seed, tempo, innings } as never) as never);
    const evs: unknown[] = [];
    g.on((ev) => void evs.push(ev));
    let hits = 0;
    let last = -10;
    let evaluated = false;
    let firstError: string | null = null;
    const test = (s: unknown, ev: unknown) => {
      try {
        const r = !!f(s, ev);
        evaluated = true;
        return r;
      } catch (err) {
        firstError ??= String(err);
        return false;
      }
    };
    for (let i = 0; i / 120 < limit && hits < max; i++) {
      g.step(1 / 120);
      // a snapshot costs ~10x a step: look every 0.25 s of game time, and whenever events arrived
      if (i % 30 && !evs.length) continue;
      const s = g.getState();
      const batch = evs.splice(0);
      let hitEv: unknown = null;
      let hit = test(s, null);
      for (const ev of batch) if (!hit && test(s, ev)) ((hit = true), (hitEv = ev));
      if (hit && s.time - last > 5) {
        last = s.time;
        hits++;
        const row = { seed, simTime: +s.time.toFixed(2), inning: s.inning, half: s.half, outs: s.outs, count: s.count, runners: s.runners, score: s.score, batter: s.batter?.name, event: hitEv };
        all.push(row);
        console.log(JSON.stringify(row));
      }
      if (s.over) break;
    }
    if (!evaluated) {
      console.error(`[cbv] seed ${seed}: the condition never evaluated without an error: ${firstError} (a typo? s = state, ev = event)`);
      process.exit(4);
    }
  }
  console.log(`[cbv] ${all.length} hit(s). Jump there: cbv goto "autostart&seed=<seed>&tempo=${tempo}&innings=${innings}&quality=low" then cbv ff "s.time >= <simTime - 3>" --turbo`);
}

// ---- main ---------------------------------------------------------------------------------------------------------------------

const HELP = `cbv - verify-claudeball harness (see .claude/skills/verify-claudeball/SKILL.md)
  launch [--dev] [--headed] [--no-build] [--size 1280x720] [--emu 412x915@2.625] [--query "menu=1&seed=24&quality=low"] [--port N]
  doctor                         read-only health check of the current session (exit 1 = do not drive)
  list                           sessions of this checkout
  stop [--all]                   kill what the session started (by pid + marker), remove scratch, keep evidence
  goto "<query>" | reload        navigate the session tab (waits for __boot.tti)
  click --role button --name "Start Game" [--in "Claudeball menu"] | --testid start | --text "Settings"
  press <key...>                 real key events (Escape, p, 1, 2, 3, n, ., b, c, q, t, Space, Enter)
  tap X Y                        a touch (with --emu sessions)
  state [--save name]            app / game / director / render / HUD / audio as JSON
  shot <name>                    screenshot + state json into the evidence folder
  aria [name]                    ARIA snapshot of the page (menus are dialogs with radiogroups / switches)
  sheet [--name n] [--match re]  contact sheet of the session's screenshots (ImageMagick montage)
  ff "<cond>" [--speed 4] [--turbo] [--pause] [--timeout 300] [--keep-replays]   play until cond(s, ev, e)
  next half|batter [--until "<cond>"] [--max 30]   press n / . (the player's skips) until cond(s, e) or game over
  events [--type t1,t2] [--since T] [--tail 40] [--save name]
  log [--warn] [--tail 40]       console errors captured in the page since the last load
  perf [--secs 5] [--save name]  frame times in the page (+ __perf stats with perf=1)
  audio <name> [--secs 6]        record the game's output to <name>.webm + level per second
  eval "<js>"                    run JS in the page (engine, s in scope); print the JSON result
  seek "<cond>" [--seeds 1-20] [--tempo broadcast] [--innings 9] [--max 3]   find situations in the sim alone (Node)
Options for every command: --session <id> (default: the newest session of this checkout; or CBV_SESSION)`;

async function main() {
  switch (cmd) {
    case 'launch': return launch();
    case '_keep': return keep();
    case 'doctor': return doctor();
    case 'list':
      for (const s of sessions()) console.log(`${s.id}  ${s.mode}  ${s.base}  chrome ${s.chromePid}${ours(s.chromePid, s.profile) ? '' : ' (gone)'}  server ${s.serverPid}${ours(s.serverPid, `--port ${s.serverPort}`) ? '' : ' (gone)'}  evidence ${path.relative(ROOT, s.evidence)}`);
      return;
    case 'stop': {
      const list = flag('all') ? sessions() : [current()];
      let ok = true;
      for (const s of list) ok = (await stop(s)) && ok;
      process.exit(ok ? 0 : 1);
    }
    case 'goto': return goto(positional[0] ?? current().query);
    case 'reload': return goto('', true);
    case 'state': return state();
    case 'shot': return shot(positional[0]);
    case 'aria': return aria(positional[0] ?? '');
    case 'sheet': return sheet();
    case 'click': return click();
    case 'press': return press(positional);
    case 'tap': return tap(+positional[0], +positional[1]);
    case 'eval': return evaluate(positional.join(' '));
    case 'ff': return ff(positional.join(' '));
    case 'next': return next(positional[0]);
    case 'events': return events();
    case 'log': return log();
    case 'perf': return perfCmd();
    case 'audio': return audio(positional[0]);
    case 'seek': return seek(positional.join(' '));
    default:
      console.log(HELP);
  }
}

main()
  .then(() => {
    if (cmd !== '_keep') process.exit(process.exitCode ?? 0);
  })
  .catch((e) => {
    console.error(`[cbv] ${cmd}: ${String(e?.message ?? e).split('\n').slice(0, 3).join(' | ')}`);
    process.exit(2);
  });

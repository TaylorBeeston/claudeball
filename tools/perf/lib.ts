/** Shared helpers for the perf tools: a throwaway headed Chrome with a real GPU, a static server for the build, adb, system load. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
export const ADB = process.env.ADB ?? path.join(os.homedir(), 'Android/Sdk/platform-tools/adb');
export const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome-stable';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

export function sh(cmd: string, args: string[], opts: { timeout?: number } = {}): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `ERR ${(e as Error).message.split('\n')[0]}`;
  }
}

/** what else is using this shared machine: GPU load / memory and the load average (report these with every measurement) */
export function systemLoad() {
  const gpu = sh('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,temperature.gpu,clocks.sm,power.draw', '--format=csv,noheader']);
  const procs = sh('nvidia-smi', ['--query-compute-apps=pid,used_memory,name', '--format=csv,noheader'])
    .split('\n')
    .map((l) => { const [pid, mem, ...n] = l.split(', '); return `${mem.trim()} ${path.basename(n.join(', ').split(' ')[0])}${/--type=gpu-process/.test(l) ? ' (gpu)' : ''} ${pid}`; })
    .filter((l) => !l.startsWith('ERR'));
  return { gpu, gpuProcs: procs, loadavg: os.loadavg().map((x) => +x.toFixed(2)), cpus: os.cpus().length, at: new Date().toISOString() };
}

// ---- the build ---------------------------------------------------------------------------------------------------------------

/** `npx vite build` (typecheck skipped: `npm run build` does that) unless `dist/` is reused */
export function build(reuse: boolean) {
  const dist = path.join(ROOT, 'dist/index.html');
  if (reuse && fs.existsSync(dist)) return;
  console.log('[perf] building (vite build)...');
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

/** `vite preview` on a free port, listening on all interfaces so `adb reverse` / LAN devices can reach it */
export async function startPreview(port?: number): Promise<{ url: string; port: number; stop: () => void }> {
  const p = port ?? (await freePort());
  const child = spawn('npx', ['vite', 'preview', '--host', '0.0.0.0', '--port', String(p), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return { url: `http://localhost:${p}/`, port: p, stop: () => child.kill() };
}

// ---- desktop Chrome -----------------------------------------------------------------------------------------------------------

export interface ChromeOpts {
  /** 'gl' (ANGLE on the driver's GL, the default: it is what Chrome picks on this machine) or 'vulkan' */
  angle?: 'gl' | 'vulkan';
  /** true: no frame-rate limit and no vsync (GPU timing runs); false: normal vsync (what the player sees) */
  uncapped?: boolean;
  width?: number;
  height?: number;
  extraFlags?: string[];
}

export interface Chrome {
  browser: Browser;
  ctx: BrowserContext;
  proc: ChildProcess;
  port: number;
  profile: string;
  flags: string[];
  close: () => Promise<void>;
}

export async function launchChrome(o: ChromeOpts = {}): Promise<Chrome> {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cbperf-chrome-'));
  const angle = o.angle ?? 'gl';
  const flags = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    `--use-angle=${angle}`,
    ...(angle === 'vulkan' ? ['--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE'] : []),
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--enable-precise-memory-info',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${o.width ?? 1920},${o.height ?? 1080}`,
    '--window-position=0,0',
    ...(o.uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
    ...(o.extraFlags ?? []),
    'about:blank',
  ];
  const proc = spawn(CHROME, flags, { stdio: 'ignore' });
  let browser: Browser | null = null;
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      /* not up yet */
    }
  }
  if (!browser) {
    proc.kill();
    throw new Error('Chrome did not start (is a display available?)');
  }
  const ctx = browser.contexts()[0];
  return {
    browser,
    ctx,
    proc,
    port,
    profile,
    flags,
    close: async () => {
      await browser!.close().catch(() => {});
      proc.kill();
      await sleep(300);
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

// ---- emulation (a laptop standing in for a phone) -----------------------------------------------------------------------------

export interface Emulation {
  width: number;
  height: number;
  dpr: number;
  /** CPU slow-down factor (4-6 is a mid/upper phone against a fast laptop core) */
  cpu: number;
  mobile?: boolean;
}

export async function applyEmulation(cdp: CDPSession, e: Emulation) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: e.width, height: e.height, deviceScaleFactor: e.dpr, mobile: e.mobile ?? true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  if (e.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: e.cpu });
}

export async function applyDesktopViewport(cdp: CDPSession, w: number, h: number, dpr = 1) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
}

// ---- tracing -------------------------------------------------------------------------------------------------------------

export const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'v8.execute', 'disabled-by-default-v8.cpu_profiler', 'gpu', 'gpu.angle', 'viz', 'blink.user_timing', 'toplevel', 'latencyInfo', 'disabled-by-default-gpu.service'].join(',');

/** Chrome `Tracing` over CDP -> a gzipped trace-event JSON (open in chrome://tracing, ui.perfetto.dev or the DevTools Performance panel) */
export async function traceStart(cdp: CDPSession, buffer: unknown[]) {
  cdp.on('Tracing.dataCollected', (d: { value: unknown[] }) => buffer.push(...d.value));
  await cdp.send('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReportEvents' } as never);
}

export async function traceStop(cdp: CDPSession, buffer: unknown[], file: string) {
  const done = new Promise<void>((res) => cdp.once('Tracing.tracingComplete', () => res()));
  await cdp.send('Tracing.end');
  await done;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify({ traceEvents: buffer }))));
  return file;
}

// ---- adb -------------------------------------------------------------------------------------------------------------------

export const adb = (...args: string[]) => sh(ADB, args, { timeout: 30000 });

export function adbDevices(): { serial: string; model: string; state: string }[] {
  return adb('devices', '-l')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ serial: l.split(/\s+/)[0], state: l.split(/\s+/)[1], model: /model:(\S+)/.exec(l)?.[1] ?? '' }));
}

/** battery temperature (deg C), thermal status, charging, screen state, battery level */
export function phoneThermal(serial: string) {
  const bat = adb('-s', serial, 'shell', 'dumpsys', 'battery');
  const get = (k: string) => new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(bat)?.[1];
  const thermal = adb('-s', serial, 'shell', 'dumpsys', 'thermalservice');
  const status = /Thermal Status:\s*(\d+)/.exec(thermal)?.[1];
  const temps = [...thermal.matchAll(/Temperature\{mValue=([\d.]+), mType=\d+, mName=([^,]+), mStatus=(\d+)\}/g)].map((m) => `${m[2]}=${(+m[1]).toFixed(1)}C`);
  return {
    batteryC: get('temperature') ? +get('temperature')! / 10 : null,
    level: get('level') ? +get('level')! : null,
    thermalStatus: status ? +status : null,
    sensors: temps.slice(0, 8),
  };
}

export function gz(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(data))));
}

export type { Page, CDPSession };

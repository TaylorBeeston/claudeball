/**
 * Benchmark runner. Drives the deterministic `?bench=1` scenes (src/engine/bench.ts) in a real browser over CDP and writes JSON + markdown to
 * tools/perf/results/.
 *
 *   npm run perf -- [options]             desktop Chrome, real GPU, vsync on (what a player sees)
 *   npm run perf:gpu -- [options]         same, uncapped (no vsync / frame limit): shows how fast the machine could go
 *   npm run perf:emu -- [options]         laptop Chrome emulating a phone (viewport, DPR, touch, CPU slow-down)
 *   npm run perf:phone -- [options]       a USB-connected Android phone's Chrome (adb), same scenes
 *
 * options (all `--key value`):
 *   --presets low,medium,high,ultra   --scenes pitchcam,wide,follow,infield,faces,crowd,dugout,stadium   --tod day|dusk|night (comma list ok)
 *   --frames 360 --warm 90            frames measured per scene / discarded before it
 *   --seed 15  --tempo standard       --scale 1 (internal render scale, adaptive scaler is always off)
 *   --size 1920x1080                  desktop viewport at DPR 1 (default)
 *   --emu 412x915@2.625 --cpu 4       emulation: CSS size, DPR, CPU throttle (perf:emu)
 *   --repeat 1                        repeat the whole matrix (each repeat is a row; compare for noise)
 *   --url http://...                  benchmark this URL instead of building + serving ./dist (e.g. the deployed site)
 *   --no-build                        reuse ./dist
 *   --trace                           capture a Chrome trace of each (preset, scene) run to results/traces/*.json.gz (large; git-ignored)
 *   --shots                           save a PNG of every scene to results/shots/
 *   --angle gl|vulkan                 ANGLE backend (desktop)
 *   --label name                      prefix of the output files
 *   --out path/base                   write path/base.json|.md instead of results/<label>-<target>-<time>
 *   --quiet                           do not print the tables
 *   --extra "a=b&c=d"                 extra query params for the page
 *   --audio                           sound ON (no `noaudio`): Chrome muted (`--mute-audio`: the graph still renders, nothing reaches the speakers),
 *                                     fake speech voices (the same in every build), the probe's audio numbers in the results
 *   --audiotrace                      trace the audio render thread (`webaudio` category): its load per scene (cheap)
 *   --audionodes                      also the per-node-type audio-thread cost (`webaudio.audionode`; heavy: attribution runs only)
 *   --dist work/bisect/dist-x         serve this build folder instead of ./dist (A/B of builds; implies --no-build)
 *   --play 120 [--playwarm 20]        not the bench: the real game (broadcast director, sim at 1x, `?perf=1`) for 120 s after 20 s, one row `play`
 *   --no-probe                        do not inject tools/perf/probe.ts (main-thread time outside the rAF tick, audio controller tick, Web Audio churn)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, adb, adbDevices, applyDesktopViewport, applyEmulation, build, launchChrome, phoneThermal, sleep, startPreview, systemLoad,
  traceStart, traceStop, type Chrome,
} from './lib';
import { markdown, type Run } from './report';
import { fakeVoicesInit, initScript, probeInit } from './probe';
import { audioLoads, audioTraceStart, audioTraceStop } from './audiotrace';
import type { Browser, CDPSession, Page } from 'playwright-core';
import { chromium } from 'playwright-core';

type Args = Record<string, string | true>;
function parse(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) a[k] = true;
    else (a[k] = v), i++;
  }
  return a;
}

const args = parse(process.argv.slice(2));
const target = (args.target as string) ?? 'laptop';
const str = (k: string, d: string) => (typeof args[k] === 'string' ? (args[k] as string) : d);
const list = (k: string, d: string) => str(k, d).split(',').map((s) => s.trim()).filter(Boolean);
const presets = list('presets', 'low,medium,high,ultra');
const scenes = list('scenes', 'pitchcam,wide,follow,infield,faces,crowd');
const tods = list('tod', 'day');
const frames = +str('frames', '360');
const warm = +str('warm', '90');
const repeat = +str('repeat', '1');
const label = str('label', 'run');
const outDir = path.join(ROOT, 'tools/perf/results');
const audio = !!args.audio;
const dist = typeof args.dist === 'string' ? (args.dist as string) : '';

function pageUrl(base: string, preset: string, tod: string): string {
  if (args.play) {
    const q = new URLSearchParams({ perf: '1', autostart: '1', ...(audio ? {} : { noaudio: '1' }), seed: str('seed', '15'), tempo: str('tempo', 'standard'), quality: preset, tod, scale: str('scale', '1') });
    const u = new URL(base);
    for (const [k, v] of new URLSearchParams(str('extra', ''))) q.set(k, v);
    u.search = q.toString();
    return u.toString();
  }
  const q = new URLSearchParams({
    bench: '1', autostart: '1', ...(audio ? {} : { noaudio: '1' }), seed: str('seed', '15'), tempo: str('tempo', 'standard'), quality: preset, tod,
    scenes: scenes.join(','), frames: String(frames), warm: String(warm), scale: str('scale', '1'),
  });
  if (args.shots) q.set('shots', '1');
  const extra = str('extra', '');
  const u = new URL(base);
  const sp = new URLSearchParams(extra);
  for (const [k, v] of sp) q.set(k, v);
  u.search = q.toString();
  return u.toString();
}

async function runOne(page: Page, cdp: CDPSession, url: string, preset: string, tod: string, tag: string) {
  const logs: string[] = [];
  const onConsole = (m: { type(): string; text(): string }) => (m.type() === 'error' || m.type() === 'warning') && logs.length < 20 && logs.push(`${m.type()}: ${m.text().slice(0, 200)}`);
  page.on('console', onConsole);
  const trace: unknown[] = [];
  if (args.trace) await traceStart(cdp, trace);
  const atrace = args.audiotrace && !args.trace ? await audioTraceStart(cdp, !!args.audionodes) : null;
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  if (args.play) return playOne(page, cdp, preset, tod, tag, logs, onConsole, atrace);
  // wait for the benchmark to exist (boot: assets, shader compile, warm-up), then for it to finish
  const t0 = Date.now();
  let seen = '';
  for (;;) {
    const st = await page.evaluate(() => {
      const b = (window as unknown as { __bench?: { done: boolean; progress: string; holding: string | null; error?: string } }).__bench;
      return b ? { done: b.done, progress: b.progress, holding: b.holding, error: b.error } : null;
    }).catch(() => null);
    if (st?.error) throw new Error(`bench error: ${st.error}`);
    if (st?.holding && args.shots) {
      fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
      const file = path.join(outDir, 'shots', `${label}-${target}-${preset}-${tod}-${st.holding}.png`);
      fs.writeFileSync(file, Buffer.from(((await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }).data, 'base64'));
      await page.evaluate(() => ((window as unknown as { __bench: { release: boolean } }).__bench.release = true));
      await sleep(200);
    }
    if (st?.progress && st.progress !== seen) {
      seen = st.progress;
      process.stdout.write(` ${seen}`);
    }
    if (st?.done) break;
    if (Date.now() - t0 > 20 * 60000) throw new Error('timeout waiting for the benchmark');
    await sleep(500);
  }
  const out = await page.evaluate(() => (window as unknown as { __bench: { device: Record<string, unknown>; results: Record<string, unknown>[] } }).__bench);
  // a run whose assets did not load (network hiccup) measures stand-ins, not the game: flag it loudly
  const missing = (await page.evaluate(() => (window as unknown as { __boot?: { missing?: string[] } }).__boot?.missing ?? []).catch(() => [])) as string[];
  if (missing.length) console.log(`\n[perf] WARNING: ${missing.length} asset(s) failed to load in this run (${missing.slice(0, 3).join(', ')}): the numbers are NOT valid, re-run`);
  (out as { missing?: string[] }).missing = missing;
  // what this page really downloaded on first load (resource timing: bytes over the wire, per kind)
  const dl = await page.evaluate(() => {
    const by: Record<string, number> = {};
    let total = 0;
    for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      const n = e.encodedBodySize || e.transferSize || 0;
      const k = /\.glb/.test(e.name) ? 'glb' : /\.(hdr)/.test(e.name) ? 'hdr' : /\.js/.test(e.name) ? 'js' : /\.(webp|png|jpg|ktx2)/.test(e.name) ? 'img' : 'other';
      by[k] = (by[k] ?? 0) + n;
      total += n;
    }
    return { totalMB: +(total / 1048576).toFixed(1), byKindMB: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +(v / 1048576).toFixed(1)])) };
  }).catch(() => null);
  if (dl) (out as { download?: unknown }).download = dl;
  if (atrace) {
    await audioTraceStop(cdp);
    const sr = (out.results[0] as { stats?: { probe?: { ctx?: { sampleRate?: number } } } })?.stats?.probe?.ctx?.sampleRate ?? 48000;
    const loads = audioLoads(atrace as never, sr);
    for (const x of out.results) (x as Record<string, unknown>).audioThread = loads[(x as { scene: string }).scene] ?? null;
  }
  // validity of an audio run: the context really runs (not locked / suspended) and the path (phone / desktop) is the intended one
  if (audio) {
    for (const x of out.results) {
      const pr = (x as { stats: { probe?: { ctx?: { state?: string }; controller?: { locked?: boolean; lowPower?: boolean } } } }).stats.probe;
      if (pr?.ctx?.state !== 'running' || pr?.controller?.locked) console.log(`\n[perf] WARNING: audio not running in ${preset}/${(x as { scene: string }).scene} (ctx ${pr?.ctx?.state}, locked ${pr?.controller?.locked}): the audio numbers are NOT valid`);
    }
  }
  let traceFile: string | undefined;
  if (args.trace) traceFile = await traceStop(cdp, trace, path.join(outDir, 'traces', `${label}-${target}-${preset}-${tod}-${tag}.json.gz`));
  page.off('console', onConsole);
  return { ...out, logs, traceFile };
}

/** --play: the real game for a while; one result row `play` (stats over every frame of the window, the probe's numbers) */
async function playOne(page: Page, cdp: CDPSession, preset: string, tod: string, tag: string, logs: string[], onConsole: (m: { type(): string; text(): string }) => void, atrace: unknown[] | null) {
  const secs = +str('play', '120');
  const warmS = +str('playwarm', '20');
  const t0 = Date.now();
  while (!(await page.evaluate(() => !!(window as unknown as { __perf?: { frames(): unknown[] } }).__perf?.frames().length).catch(() => false))) {
    if (Date.now() - t0 > 180000) throw new Error('timeout waiting for the game');
    await sleep(500);
  }
  process.stdout.write(` playing (warm ${warmS} s, measure ${secs} s)`);
  await sleep(warmS * 1000);
  await page.evaluate(() => (window as unknown as { __probeStart(): boolean }).__probeStart());
  await sleep(secs * 1000);
  const stats = await page.evaluate(() => (window as unknown as { __probeEnd(): unknown }).__probeEnd());
  const canvas = await page.evaluate(() => { const c = document.querySelector('canvas'); return c ? `${c.width}x${c.height}` : ''; });
  const device = await page.evaluate(() => ({ ua: navigator.userAgent, dpr: devicePixelRatio, inner: `${innerWidth}x${innerHeight}`, cores: navigator.hardwareConcurrency }));
  const results: Record<string, unknown>[] = [{ scene: 'play', preset, tod, canvas, pixelRatio: 0, stats }];
  if (atrace) {
    await audioTraceStop(cdp);
    const sr = (stats as { probe?: { ctx?: { sampleRate?: number } } }).probe?.ctx?.sampleRate ?? 48000;
    results[0].audioThread = audioLoads(atrace as never, sr).play ?? null;
  }
  void tag;
  page.off('console', onConsole);
  return { device, results, logs, traceFile: undefined as string | undefined };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const meta: Record<string, unknown> = { label, target, presets, scenes, tods, frames, warm, repeat, args };
  let base = typeof args.url === 'string' ? (args.url as string) : '';
  let stopServer = () => {};
  let chrome: Chrome | null = null;
  let browser: Browser;
  let phoneSerial = '';
  let distPort = 0;
  const stayOn: { prev?: string } = {};

  if (dist) {
    const srv = await startPreview(undefined, dist);
    stopServer = srv.stop;
    base = srv.url;
    meta.dist = dist;
    distPort = srv.port;
  }
  if (target === 'phone') {
    const dev = adbDevices().find((d) => d.state === 'device');
    if (!dev) {
      console.error('No authorized Android device. Enable Developer options > USB debugging, plug in, accept the RSA prompt, then run `adb devices`.');
      process.exit(2);
    }
    phoneSerial = dev.serial;
    meta.phone = { serial: dev.serial, model: dev.model, before: phoneThermal(dev.serial) };
    // serve the local build to the phone through adb reverse (the phone sees http://localhost:PORT)
    if (!base) {
      build(!!args['no-build']);
      const srv = await startPreview();
      stopServer = srv.stop;
      base = srv.url;
      adb('-s', phoneSerial, 'reverse', `tcp:${srv.port}`, `tcp:${srv.port}`);
      meta.adbReverse = srv.port;
    } else if (distPort) {
      adb('-s', phoneSerial, 'reverse', `tcp:${distPort}`, `tcp:${distPort}`);
      meta.adbReverse = distPort;
    }
    stayOn.prev = adb('-s', phoneSerial, 'shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in');
    if (stayOn.prev !== '7' && stayOn.prev !== '3') adb('-s', phoneSerial, 'shell', 'svc', 'power', 'stayon', 'usb');
    adb('-s', phoneSerial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    const cport = 9333;
    // Chrome must be running to expose the socket: start it on about:blank (does not touch other apps or settings)
    adb('-s', phoneSerial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'about:blank', '-p', 'com.android.chrome');
    await sleep(1500);
    // the generic `chrome_devtools_remote` socket is shared by every Chromium-based app / WebView on the phone and may answer from the wrong one (or hang):
    // Chrome's own, pid-specific socket is the reliable one
    const pid = adb('-s', phoneSerial, 'shell', 'pidof', 'com.android.chrome').split(/\s+/)[0];
    const sock = /^\d+$/.test(pid) ? `chrome_devtools_remote_${pid}` : 'chrome_devtools_remote';
    adb('-s', phoneSerial, 'forward', `tcp:${cport}`, `localabstract:${sock}`);
    meta.devtoolsSocket = sock;
    let b: Browser | null = null;
    for (let i = 0; i < 15 && !b; i++) {
      b = await chromium.connectOverCDP(`http://127.0.0.1:${cport}`, { timeout: 8000 }).catch(() => null);
      if (!b) await sleep(1000);
    }
    if (!b) {
      console.error('Could not reach Chrome for Android over CDP. Is the screen unlocked and com.android.chrome the browser opening the URL?');
      process.exit(3);
    }
    browser = b;
  } else {
    if (!base) {
      build(!!args['no-build']);
      const srv = await startPreview();
      stopServer = srv.stop;
      base = srv.url;
    }
    const [w, h] = str('size', '1920x1080').split('x').map(Number);
    chrome = await launchChrome({ angle: str('angle', 'gl') as 'gl' | 'vulkan', uncapped: !!args.uncapped, width: w, height: h, extraFlags: audio ? ['--mute-audio'] : [] });
    browser = chrome.browser;
    meta.chromeFlags = chrome.flags.filter((f) => !f.startsWith('--user-data-dir'));
    meta.version = browser.version();
  }
  meta.url = base;
  meta.loadBefore = systemLoad();
  console.log(`[perf] ${target}: ${presets.join(',')} x ${scenes.join(',')} (${frames} frames, ${warm} warm) ${base}`);

  const run: Run = { meta, results: [] };
  const files: string[] = [];
  try {
    for (let rep = 0; rep < repeat; rep++) {
      for (const tod of tods) {
        for (const preset of presets) {
          const ctx = browser.contexts()[0];
          // a fresh tab each time (on the phone too: the user's own tabs are never touched), closed afterwards
          const page = await ctx.newPage();
          if (!args['no-probe']) await page.addInitScript(initScript(probeInit));
          if (audio) await page.addInitScript(initScript(fakeVoicesInit));
          const cdp = await ctx.newCDPSession(page);
          if (target === 'laptop') await applyDesktopViewport(cdp, ...(str('size', '1920x1080').split('x').map(Number) as [number, number]));
          if (target === 'emu') {
            const m = /^(\d+)x(\d+)@([\d.]+)$/.exec(str('emu', '412x915@2.625'));
            if (!m) throw new Error('--emu WxH@DPR');
            await applyEmulation(cdp, { width: +m[1], height: +m[2], dpr: +m[3], cpu: +str('cpu', '4') });
            meta.emulation = { size: str('emu', '412x915@2.625'), cpuThrottle: +str('cpu', '4') };
          }
          process.stdout.write(`[perf] rep ${rep + 1}/${repeat} ${preset}/${tod}:`);
          const t0 = Date.now();
          const before = phoneSerial ? phoneThermal(phoneSerial) : null;
          const r = await runOne(page, cdp, pageUrl(base, preset, tod), preset, tod, `r${rep}`);
          process.stdout.write(` (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
          run.device ??= r.device;
          if ((r as { download?: unknown }).download) ((meta.download ??= {}) as Record<string, unknown>)[`${preset}/${tod}`] = (r as { download?: unknown }).download;
          if ((r as { missing?: string[] }).missing?.length) ((meta.invalidRuns ??= []) as string[]).push(`${preset}/${tod}`);
          for (const x of r.results) {
            (x as Record<string, unknown>).rep = rep;
            if (before) (x as Record<string, unknown>).thermalBefore = before;
            if (phoneSerial) (x as Record<string, unknown>).thermalAfter = phoneThermal(phoneSerial);
            run.results.push(x as never);
          }
          if (r.logs.length) console.log('  page logs:', r.logs.slice(0, 6));
          if (r.traceFile) files.push(r.traceFile);
          await page.close().catch(() => {});
        }
      }
    }
  } finally {
    meta.loadAfter = systemLoad();
    if (phoneSerial) {
      (meta.phone as Record<string, unknown>).after = phoneThermal(phoneSerial);
      // put the phone back the way it was
      if (stayOn.prev && stayOn.prev !== '7' && stayOn.prev !== '3') adb('-s', phoneSerial, 'shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', stayOn.prev);
      adb('-s', phoneSerial, 'forward', '--remove-all');
      if (meta.adbReverse) adb('-s', phoneSerial, 'reverse', '--remove', `tcp:${meta.adbReverse}`);
    }
    await chrome?.close().catch(() => {});
    stopServer();
  }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const base2 = typeof args.out === 'string' ? (args.out as string) : path.join(outDir, `${label}-${target}-${stamp}`);
  fs.writeFileSync(`${base2}.json`, JSON.stringify(run));
  fs.writeFileSync(`${base2}.md`, markdown(run));
  if (!args.quiet) console.log(markdown(run));
  console.log(`\n[perf] wrote ${base2}.json / .md${files.length ? ` and ${files.length} trace(s)` : ''}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * The audio layer's cost in the running game (headless Chrome, the dev server): the controller's tick time on the main thread
 * (`__audioDebug.controller.debug.tickMs`, a moving average), live voices, output level, errors. `--cpu 4` throttles the CPU like a phone
 * (CDP), `--lowpower` forces the phone path of the audio layer.
 *
 *   npx tsx tools/audio/live.ts [--secs 60] [--cpu 4] [--lowpower] [--seed 12]
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { CHROME, ROOT, freePort, sleep } from '../perf/lib';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const secs = Number(opt('secs', '60'));
const cpu = Number(opt('cpu', '1'));
const lowPower = args.includes('--lowpower');
const audioDebug = args.includes('--audiodebug');

async function main() {
  const port = await freePort();
  const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => (m.type() === 'error' || /\[audio\]/.test(m.text())) && errs.push(m.text().slice(0, 200)));
    await page.goto(`${base}?quality=low&seed=${opt('seed', '12')}${lowPower ? '&lowpower=1' : '&lowpower=0'}&autostart=1${audioDebug ? '&audiodebug=1' : ''}`);
    await page.waitForFunction(() => (window as unknown as { __audioDebug?: unknown }).__audioDebug, null, { timeout: 120000 }).catch(async () => {
      // the start menu: press the start button
      await page.getByText(/start game|play ball/i).first().click({ timeout: 10000 }).catch(() => page.mouse.click(640, 360));
      await page.waitForFunction(() => (window as unknown as { __audioDebug?: unknown }).__audioDebug, null, { timeout: 120000 });
    });
    await page.mouse.click(640, 360);
    if (cpu > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    }
    const series: { tickMs: number; voices: number; rms: number }[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000) {
      await sleep(1000);
      series.push(
        await page.evaluate(() => {
          const c = (window as unknown as { __audioDebug: { controller: any } }).__audioDebug.controller;
          return { tickMs: +c.debug.tickMs.toFixed(3), voices: c.mixer.voiceCount, rms: +c.mixer.level().rms.toFixed(4), ctx: c.mixer.state };
        }),
      );
    }
    const st = series.slice(5);
    const avg = (f: (s: (typeof st)[0]) => number) => +(st.reduce((a, s) => a + f(s), 0) / Math.max(1, st.length)).toFixed(3);
    const extra = await page.evaluate(() => {
      const c = (window as unknown as { __audioDebug: { controller: any } }).__audioDebug.controller;
      return { lowPower: c.lowPower, ctx: c.mixer.state, ready: c.mixer.ready, debug: typeof c.mixer.debugInfo === 'function' ? c.mixer.debugInfo() : null };
    });
    if (audioDebug) console.log(await page.evaluate(() => document.querySelector('.cb-audiodebug')?.textContent ?? '(no panel)'));
    console.log(JSON.stringify({ secs, cpu, ...extra, tickMsAvg: avg((s) => s.tickMs), tickMsMedian: [...st].sort((a, b) => a.tickMs - b.tickMs)[st.length >> 1]?.tickMs, tickMsMax: Math.max(...st.map((s) => s.tickMs)), voicesMax: Math.max(...st.map((s) => s.voices)), rmsAvg: avg((s) => s.rms), errors: errs.slice(0, 10) }, null, 1));
  } finally {
    await browser.close();
    vite.kill();
  }
}

void main().catch((e) => (console.error(e), process.exit(1)));

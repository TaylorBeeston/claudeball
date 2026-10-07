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
    if (args.includes('--fake-voices')) {
      // headless Chrome has no speech voices: a fake engine that "speaks" for a time proportional to the text (onstart / onend), so the
      // speech gate, the booth director and the duck's browser-speech key run as in a real browser
      await page.addInitScript(() => {
        const w = window as unknown as Record<string, unknown>;
        const voices = [{ name: 'Fake David', lang: 'en-US' }, { name: 'Fake Zira', lang: 'en-US' }, { name: 'Fake Alex', lang: 'en-GB' }];
        let cur: ReturnType<typeof setTimeout> | null = null;
        w.SpeechSynthesisUtterance = function (this: Record<string, unknown>, t: string) {
          this.text = t;
        };
        Object.defineProperty(window, 'speechSynthesis', {
          configurable: true,
          value: {
            getVoices: () => voices,
            speaking: false,
            speak(u: { text: string; onstart?: () => void; onend?: () => void }) {
              setTimeout(() => u.onstart?.(), 10);
              cur = setTimeout(() => u.onend?.(), 300 + u.text.length * 55);
            },
            cancel() {
              if (cur) clearTimeout(cur);
            },
            pause() {},
            resume() {},
            addEventListener() {},
          },
        });
      });
    }
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
        await page.evaluate(async () => {
          const c = (window as unknown as { __audioDebug: { controller: any } }).__audioDebug.controller;
          const talk = c.mixer.debugInfo().talk;
          const g = c.mixer.graph;
          return { tickMs: +c.debug.tickMs.toFixed(3), voices: c.mixer.voiceCount, rms: +c.mixer.level().rms.toFixed(4), ctx: c.mixer.state, booth: talk.booth, pa: talk.pa, duckDb: g ? +(await g.duckNow()).toFixed(2) : 0, shot: c.host?.director?.shot, rightX: c.host?.camera?.matrixWorld?.elements?.[0] };
        }),
      );
    }
    const st = series.slice(5);
    const pitchShots = series.filter((x: any) => x.shot === 'pitch').map((x: any) => x.rightX);
    console.log('duck min dB', Math.min(...series.map((x: any) => x.duckDb ?? 0)));
    console.log('booth talking samples', series.filter((x: any) => x.booth).length, 'pa', series.filter((x: any) => x.pa).length, 'pitch-shot camera right.x', pitchShots.slice(0, 5));
    const avg = (f: (s: (typeof st)[0]) => number) => +(st.reduce((a, s) => a + f(s), 0) / Math.max(1, st.length)).toFixed(3);
    // the camera's right vector during the main (pitch) shot: which way third base (+X) points on screen
    const camRight = await page.evaluate(() => {
      const c = (window as unknown as { __audioDebug: { controller: any } }).__audioDebug.controller;
      const host = c.host;
      return { shot: host?.director?.shot, rightX: host?.camera?.matrixWorld?.elements?.[0] };
    });
    console.log('camera', JSON.stringify(camRight));
    const extra = await page.evaluate(() => {
      const c = (window as unknown as { __audioDebug: { controller: any } }).__audioDebug.controller;
      return { lowPower: c.lowPower, ctx: c.mixer.state, ready: c.mixer.ready, debug: typeof c.mixer.debugInfo === 'function' ? c.mixer.debugInfo() : null, cues: Object.keys(c.debug.played).length, playedSfx: Object.fromEntries(Object.entries(c.debug.played as Record<string, number>).filter(([k]) => k.startsWith('sfx:'))) };
    });
    if (audioDebug) console.log(await page.evaluate(() => document.querySelector('.cb-audiodebug')?.textContent ?? '(no panel)'));
    console.log(JSON.stringify({ secs, cpu, ...extra, tickMsAvg: avg((s) => s.tickMs), tickMsMedian: [...st].sort((a, b) => a.tickMs - b.tickMs)[st.length >> 1]?.tickMs, tickMsMax: Math.max(...st.map((s) => s.tickMs)), voicesMax: Math.max(...st.map((s) => s.voices)), rmsAvg: avg((s) => s.rms), errors: errs.slice(0, 10) }, null, 1));
  } finally {
    await browser.close();
    vite.kill();
  }
}

void main().catch((e) => (console.error(e), process.exit(1)));

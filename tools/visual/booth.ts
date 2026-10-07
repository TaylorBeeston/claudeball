/**
 * The broadcast booth in the real app (production build, headed desktop Chrome over CDP): opens the menu, clicks Start Game (the gesture that unlocks
 * audio), lets the pregame play at 1x with fake browser voices (they report start / end like real ones, so the captions run), and prints what the PA,
 * the umpire and the booth said, the booth's own schedule, and a screenshot of the captions with the cast's labels.
 *   npx tsx tools/visual/booth.ts [--seed 42] [--tempo broadcast] [--tod night] [--secs 100] [--out dir] [--no-build] [--enter]
 * (`--enter` starts with the Enter key instead of a click on Start Game.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { build, launchChrome, startPreview } from '../perf/lib';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

async function main() {
  const seed = opt('seed', '42');
  const tempo = opt('tempo', 'broadcast');
  const tod = opt('tod', 'night');
  const secs = Number(opt('secs', '100'));
  const out = opt('out', 'tools/visual/out');
  fs.mkdirSync(out, { recursive: true });
  build(argv.includes('--no-build'));
  const s = await startPreview();
  const chrome = await launchChrome({ width: 1280, height: 720 });
  try {
    const page = await chrome.ctx.newPage();
    // (a string: tsx would wrap a function with helpers that do not exist in the page)
    await page.addInitScript(`
      window.__spoken = [];
      const voices = [{ name: 'Fake David', lang: 'en-US' }, { name: 'Fake Mark', lang: 'en-US' }, { name: 'Fake Guy', lang: 'en-GB' }, { name: 'Fake Zira', lang: 'en-US' }];
      let cur = null;
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        getVoices: () => voices,
        speak(u) {
          const d = 300 + u.text.length * 60;
          window.__spoken.push({ t: Math.round(performance.now()), d, text: u.text, voice: u.voice && u.voice.name });
          setTimeout(() => u.onstart && u.onstart(), 10);
          cur = setTimeout(() => u.onend && u.onend(), d);
        },
        cancel() { clearTimeout(cur); }, pause() {}, resume() {},
      } });
    `);
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${s.url}?seed=${seed}&tempo=${tempo}&tod=${tod}&quality=low&subtitles=all`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__boot?.tti, null, { timeout: 240000 });
    if (argv.includes('--enter')) await page.keyboard.press('Enter'); else await page.click('[data-testid="start"]');
    const t0 = Date.now();
    let shot = false;
    while (Date.now() - t0 < secs * 1000) {
      await page.waitForTimeout(500);
      // the headed window sits on a shared desktop: a stray real click on the sound button mutes the game; undo it (and say so)
      if (await page.evaluate(`(() => { const c = window.__audioDebug.controller; if (!c.settings.muted) return false; c.settings.muted = false; c.settingsChanged(); return true; })()`)) console.log('[booth] sound was muted by a click on the window: unmuted');
      if (!shot) {
        const lab = await page.evaluate(() => [...document.querySelectorAll('.cb-caps *')].map((e) => e.textContent ?? '').join(' | '));
        if (/BISCUIT/.test(lab)) {
          await page.screenshot({ path: path.join(out, `booth-captions-${seed}-${tod}.png`) });
          shot = true;
          console.log('[booth] captions:', lab.slice(0, 300));
        }
      }
    }
    const r = await page.evaluate(() => {
      const w = window as any;
      const d = w.__audioDebug;
      const st = w.engine?.sim?.state;
      const c = d?.controller;
      return { spoken: w.__spoken, transcript: d?.state?.booth?.transcript, director: d?.state?.booth?.director, phase: d?.state?.phase, diag: { time: st?.time, inning: st?.inning, lull: st?.lull, gate: d?.state?.booth?.field, concurrent: d?.state?.booth?.concurrent, gateStats: d?.state?.booth?.gate, speech: d?.state?.speech, snap: c?.booth?.director?.snapshot?.(), pregame: c?.booth?.pregame, locked: c?.isLocked, muted: c?.settings?.muted, commentary: c?.settings?.commentary, speed: w.engine?.sim?.speed, paused: w.engine?.sim?.paused } };
    });
    const start = r.spoken[0]?.t ?? 0;
    for (const x of r.spoken) console.log(`${((x.t - start) / 1000).toFixed(1).padStart(6)}s ${String(x.voice).padEnd(11)} ${x.text}`);
    console.log('director', JSON.stringify(r.director));
    console.log('diag', JSON.stringify(r.diag));
    console.log('errors', JSON.stringify(errs.slice(0, 5)));
    if (!shot) console.log('[booth] no BISCUIT caption seen');
  } finally {
    await chrome.close();
    s.stop();
  }
}
main();

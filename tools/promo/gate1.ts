/** Gate 1: the browser game (bundled sim, Chrome V8) reproduces the Node scout's event times for a seed. */
import { build, launchChrome, startPreview } from '../perf/lib';
const seed = process.argv[2] ?? '40';
const until = +(process.argv[3] ?? '700');
build(process.argv.includes('--no-build'));
const s = await startPreview();
const chrome = await launchChrome({ width: 960, height: 540 });
try {
  const page = await chrome.ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(`${s.url}?autostart&noaudio&seed=${seed}&tempo=standard&quality=low`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__boot?.tti > 0, null, { timeout: 240000 });
  const r = await page.evaluate((until) => {
    const e = (window as any).engine;
    e.stop();
    e.director.replaysEnabled = false;
    e.director.brollEnabled = false;
    e.sim.stepBudgetMs = 1e9;
    const ev: string[] = [];
    e.sim.on((te: any) => { const t = te.event.type; if (['home_run', 'homeRun', 'out', 'safe', 'contact', 'strikeout'].includes(t) || /home/i.test(t)) ev.push(`${t} ${te.simTime.toFixed(2)} ${JSON.stringify(te.event).slice(0, 120)}`); });
    const t0 = performance.now();
    let n = 0;
    e.sim.speed = 60;
    while (e.liveState.time < until) { e.tick(1 / 60, false); n++; }
    return { ms: performance.now() - t0, n, time: e.liveState.time, ev, kind: e.sim.kind };
  }, until);
  console.log(`kind ${r.kind}  ${r.n} ticks in ${r.ms.toFixed(0)} ms -> t ${r.time.toFixed(2)}`);
  console.log(r.ev.join('\n'));
} finally {
  await chrome.close();
  s.stop();
}

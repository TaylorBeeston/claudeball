/**
 * What does "Auto" pick here? Loads the game with no quality given in a fresh profile (so nothing is remembered), with an optional phone-like emulation,
 * and prints the start-up tuner's measurements and decision.
 *   npx tsx tools/perf/tunecheck.ts [--emu 412x915@2.625 --cpu 4] [--no-build] [--url http://host:port/ (another build, e.g. for an A/B)]
 */
import { applyDesktopViewport, applyEmulation, build, launchChrome, startPreview } from './lib';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

async function main() {
  const url = opt('url', '');
  if (!url) build(argv.includes('--no-build'));
  const srv = url ? { url, stop: () => {} } : await startPreview();
  const chrome = await launchChrome({});
  try {
    const page = await chrome.ctx.newPage();
    const cdp = await chrome.ctx.newCDPSession(page);
    const emu = opt('emu', '');
    if (emu) {
      const m = /^(\d+)x(\d+)@([\d.]+)$/.exec(emu)!;
      await applyEmulation(cdp, { width: +m[1], height: +m[2], dpr: +m[3], cpu: +opt('cpu', '4') });
    } else await applyDesktopViewport(cdp, 1920, 1080);
    const lines: string[] = [];
    page.on('console', (msg) => /\[boot\]/.test(msg.text()) && lines.push(msg.text()));
    await page.goto(`${srv.url}?autostart=1&noaudio=1&seed=15`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __boot?: { tti: number } }).__boot?.tti, null, { timeout: 240000 });
    for (const l of lines) console.log(l);
    const q = await page.evaluate(() => (window as unknown as { engine: { qualityName: string } }).engine.qualityName);
    const boot = await page.evaluate(() => (window as unknown as { __boot: { tti: number; steps: Record<string, number> } }).__boot);
    console.log(`[tunecheck] tti ${Math.round(boot.tti)} ms, steps ${JSON.stringify(boot.steps)}`);
    console.log(`[tunecheck] engine runs on: ${q}  (${emu ? `emulated ${emu}, cpu x${opt('cpu', '4')}` : 'desktop 1920x1080'})`);
  } finally {
    await chrome.close();
    srv.stop();
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

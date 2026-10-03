/** Evaluate a JS expression in the running game (production build, desktop Chrome) and print the JSON result: npx tsx tools/visual/probe.ts "<expr>" */
import { build, launchChrome, startPreview } from '../perf/lib';
async function main() {
  build(true);
  const s = await startPreview();
  const chrome = await launchChrome({});
  try {
    const page = await chrome.ctx.newPage();
    await page.goto(`${s.url}?autostart&noaudio&seed=15&quality=high`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as any).__boot?.tti, null, { timeout: 240000 });
    const r = await page.evaluate(process.argv[2]);
    console.log(JSON.stringify(r, null, 1));
  } finally {
    await chrome.close();
    s.stop();
  }
}
main();

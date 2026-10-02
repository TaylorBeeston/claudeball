/**
 * End-to-end check inside the real game: serves a voice pack (with CORS, like Hugging Face), starts the game dev server, pre-sets the
 * "My voice" setting like a returning user, and waits until the game has spoken lines with the custom voice (worker + onnxruntime-web
 * from the CDN + the speech queue). Pass the pack folder as the first argument.
 *   npx tsx tools/announcer/train/game_test.ts ~/claudeball-voice/voicepack
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const pack = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'claudeball-voice/voicepack'));
const shots = process.env.E2E_SHOTS ?? os.tmpdir();

function chromePath(): string {
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) if (fs.existsSync(path.join(base, d, 'chrome-linux64/chrome'))) return path.join(base, d, 'chrome-linux64/chrome');
  throw new Error('no Playwright chromium');
}

async function main() {
  const packPort = 5950 + Math.floor(Math.random() * 40);
  const packServer = http.createServer((req, res) => {
    const f = path.join(pack, decodeURIComponent((req.url ?? '/').split('?')[0]));
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!f.startsWith(pack) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('Content-Type', f.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  });
  await new Promise<void>((r) => packServer.listen(packPort, '127.0.0.1', r));
  const gamePort = 6050 + Math.floor(Math.random() * 40);
  const vite = await createServer({ root, logLevel: 'error', server: { port: gamePort, strictPort: true, host: '127.0.0.1' } });
  await vite.listen();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let ok = false;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript((url) => {
      try {
        localStorage.setItem('claudeball.voicepack.v1', JSON.stringify({ enabled: true, url, source: 'url' }));
      } catch {
        /* ignore */
      }
    }, `http://127.0.0.1:${packPort}/`);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${gamePort}/`);
    await page.mouse.click(640, 400); // a user gesture unlocks audio
    const t0 = Date.now();
    let st: any = null;
    while (Date.now() - t0 < 150000) {
      st = await page.evaluate(() => (window as any).__audioDebug?.state ?? null);
      if (st?.speech?.voice === 'ready' && (st.speech.voiceStats?.generated ?? 0) > 0) break;
      if (st?.speech?.voice === 'error') break;
      await page.waitForTimeout(1000);
    }
    console.log(JSON.stringify({ voice: st?.speech?.voice, voiceStats: st?.speech?.voiceStats, speech: st?.speech && { spoken: st.speech.spoken, dropped: st.speech.dropped }, seconds: Math.round((Date.now() - t0) / 1000) }));
    const panel = await page.evaluate(() => document.querySelector('.cb-myvoice .hint')?.textContent ?? '');
    console.log('panel:', panel);
    await page.screenshot({ path: path.join(shots, 'game-custom-voice.png') });
    ok = st?.speech?.voice === 'ready' && (st.speech.voiceStats?.generated ?? 0) > 0 && (st.speech.voiceStats?.fallbacks ?? 0) < (st.speech.voiceStats?.generated ?? 0);
    if (errors.length) console.log('page errors:', errors.slice(0, 3));
  } finally {
    await browser.close();
    await vite.close();
    packServer.close();
  }
  console.log(ok ? 'PASS: the game spoke with the custom voice' : 'FAIL');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

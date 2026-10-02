/**
 * Headless-browser smoke test of a voice pack: serves the pack folder, loads it through the game's own loader + worker + onnxruntime-web,
 * synthesises a line per style, and reports real-time factors (WASM; WebGPU if the browser has it).
 *
 *   npm run announcer:test            # uses ~/claudeball-voice/voicepack (or CB_VOICEPACK)
 *   npx tsx tools/announcer/train/web_test.ts /path/to/pack
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer, type Plugin } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const pack = path.resolve(process.argv[2] ?? process.env.CB_VOICEPACK ?? path.join(process.env.CB_VOICE_DIR ?? path.join(os.homedir(), 'claudeball-voice'), 'voicepack'));
const ortDir = path.join(root, 'node_modules/onnxruntime-web/dist');

function chromePath(): string {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-linux64/chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('no Playwright chromium found; set PLAYWRIGHT_CHROMIUM');
}

const types: Record<string, string> = { '.json': 'application/json', '.onnx': 'application/octet-stream', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
function statics(): Plugin {
  return {
    name: 'voice-test-statics',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/(pack|ort)\/([^?]+)/.exec(req.url ?? '');
        if (!m) return next();
        const base = m[1] === 'pack' ? pack : ortDir;
        const file = path.join(base, decodeURIComponent(m[2]));
        if (!file.startsWith(base) || !fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end('not found');
        }
        res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(fs.readFileSync(file));
      });
    },
  };
}

async function main() {
  if (!fs.existsSync(path.join(pack, 'voice.json'))) throw new Error(`no voice.json in ${pack}: run npm run announcer:export first`);
  const port = 5600 + Math.floor(Math.random() * 300);
  const server = await createServer({ root, configFile: false, logLevel: 'error', plugins: [statics()], server: { port, strictPort: true, host: '127.0.0.1' }, optimizeDeps: { noDiscovery: true } });
  await server.listen();
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan'] });
  let ok = false;
  try {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/tools/announcer/train/web-test/index.html`);
    await page.waitForFunction(() => (window as unknown as { __result?: { done?: boolean } }).__result?.done === true, null, { timeout: 240000 });
    const r = await page.evaluate(() => (window as unknown as { __result: Record<string, any> }).__result);
    console.log(JSON.stringify(r, null, 1));
    const lines = r.lines as { error?: string; seconds?: number; rms?: number }[];
    ok = !r.error && lines.length > 0 && lines.every((l) => !l.error && (l.seconds ?? 0) > 0.5 && (l.rms ?? 0) > 0.005) && errors.length === 0;
    if (errors.length) console.log('page errors:', errors);
    fs.writeFileSync(path.join(pack, 'web_test_report.json'), JSON.stringify(r, null, 1));
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(ok ? '\nPASS: the voice pack loads and speaks in the browser (onnxruntime-web, WASM)' : '\nFAIL: see the output above');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

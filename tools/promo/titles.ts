/**
 * Renders the typography layer (`overlay.ts`) to transparent PNGs, one per output frame that has something on it, in Chrome (canvas 2D,
 * the fonts loaded from their files: Anton from public/fonts, Roboto Condensed from the system). Returns which frames exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Chrome } from '../perf/lib';
import { ROOT } from '../perf/lib';
import { drawOverlay, type Overlay } from './overlay';

const FONTS: [string, string, string][] = [
  ['Anton', path.join(ROOT, 'public/fonts/anton-latin-400.woff2'), '400'],
  ['Roboto Condensed', '/usr/share/fonts/TTF/RobotoCondensed-Bold.ttf', 'bold'],
  ['Roboto Condensed', '/usr/share/fonts/TTF/RobotoCondensed-Regular.ttf', '400'],
];

export async function renderOverlay(chrome: Chrome, els: Overlay[], W: number, H: number, fps: number, frames: number, outDir: string, log: (s: string) => void = console.log): Promise<boolean[]> {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const page = await chrome.ctx.newPage();
  const cdp = await chrome.ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.min(W, 1920), height: Math.min(H, 1920), deviceScaleFactor: 1, mobile: false });
  await page.goto('about:blank');
  const fonts = FONTS.filter(([, f]) => fs.existsSync(f)).map(([family, f, weight]) => ({ family, weight, b64: fs.readFileSync(f).toString('base64') }));
  await page.evaluate(async (fonts) => {
    for (const f of fonts) {
      const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      const face = new FontFace(f.family, bin.buffer, { weight: f.weight });
      await face.load();
      document.fonts.add(face);
    }
  }, fonts);
  // the draw function goes in as source (tsx may wrap functions in __name)
  await page.addScriptTag({ content: `window.__name = (f) => f; window.drawOverlay = ${drawOverlay.toString()};` });
  await page.evaluate(([w, h]) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    document.body.append(c);
    (window as unknown as { cv: HTMLCanvasElement }).cv = c;
  }, [W, H]);
  const has: boolean[] = [];
  const t0 = Date.now();
  const BATCH = 8;
  for (let i0 = 0; i0 < frames; i0 += BATCH) {
    const res = await page.evaluate(
      ({ i0, n, fps, els }) => {
        const w = window as unknown as { cv: HTMLCanvasElement; drawOverlay: (c: CanvasRenderingContext2D, e: unknown, t: number, W: number, H: number) => boolean };
        const ctx = w.cv.getContext('2d')!;
        const out: (string | null)[] = [];
        for (let i = i0; i < i0 + n; i++) {
          ctx.clearRect(0, 0, w.cv.width, w.cv.height);
          ctx.save();
          const drew = w.drawOverlay(ctx, els, i / fps, w.cv.width, w.cv.height);
          ctx.restore();
          out.push(drew ? w.cv.toDataURL('image/png') : null);
        }
        return out;
      },
      { i0, n: Math.min(BATCH, frames - i0), fps, els },
    );
    res.forEach((d, k) => {
      has[i0 + k] = !!d;
      if (d) fs.writeFileSync(path.join(outDir, `${String(i0 + k).padStart(5, '0')}.png`), Buffer.from(d.slice(d.indexOf(',') + 1), 'base64'));
    });
  }
  await page.close();
  log(`[titles] ${has.filter(Boolean).length} of ${frames} frames with type, ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${outDir}`);
  return has;
}

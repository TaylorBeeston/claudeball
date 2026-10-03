/**
 * Allocation profile: V8 sampling heap profiler over CDP while the bench scene runs; prints the functions that allocate the most (bytes sampled).
 *   npx tsx tools/perf/alloc.ts [--preset medium] [--scene wide] [--secs 12] [--no-build] [--url ...]
 */
import { buildDebug, launchChrome, sleep, startPreview, applyDesktopViewport } from './lib';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

interface Node { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: Node[] }

async function main() {
  let base = opt('url', '');
  let stop = () => {};
  if (!base) {
    buildDebug(argv.includes('--no-build'));
    const s = await startPreview(undefined, 'dist-dbg');
    base = s.url;
    stop = s.stop;
  }
  const chrome = await launchChrome({});
  try {
    const page = await chrome.ctx.newPage();
    const cdp = await chrome.ctx.newCDPSession(page);
    await applyDesktopViewport(cdp, 1920, 1080);
    await page.goto(`${base}?autostart=1&noaudio=1&seed=15&quality=${opt('preset', 'medium')}&bench=1&scenes=${opt('scene', 'wide')}&frames=100000`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __bench?: unknown }).__bench !== undefined, null, { timeout: 180000 });
    await sleep(5000);
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true } as never);
    await sleep(+opt('secs', '12') * 1000);
    const { profile } = (await cdp.send('HeapProfiler.stopSampling')) as { profile: { head: Node } };
    const by = new Map<string, number>();
    let total = 0;
    const walk = (n: Node, path: string[]) => {
      const f = n.callFrame;
      const name = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      if (n.selfSize) {
        by.set(name, (by.get(name) ?? 0) + n.selfSize);
        total += n.selfSize;
      }
      for (const c of n.children) walk(c, [...path, name]);
    };
    walk(profile.head, []);
    const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    console.log(`sampled ${(total / 1048576).toFixed(1)} MB over ${opt('secs', '12')} s (${opt('preset', 'medium')}/${opt('scene', 'wide')})`);
    for (const [k, v] of top) console.log(`${((v / total) * 100).toFixed(1).padStart(5)} %  ${(v / 1048576).toFixed(2).padStart(7)} MB  ${k}`);
  } finally {
    await chrome.close();
    stop();
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

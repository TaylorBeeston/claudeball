/**
 * Main-thread CPU profile of the real game (V8 sampling profiler over CDP) on an unminified build (`dist-dbg/`, readable names): self time
 * and total time per function, and the longest single tasks' stacks. For "what is this long timer callback?" questions.
 *
 *   npx tsx tools/perf/cpuprof.ts [--audio] [--from 0 --secs 20] [--preset medium] [--emu 750x832@2.625 --cpu 2] [--no-build] [--dist dir]
 *        [--extra "k=v"] [--top 40] [--match name]   (--match: also print the callers of functions whose name contains this)
 */
import { applyDesktopViewport, applyEmulation, buildDebug, launchChrome, sleep, startPreview } from './lib';
import { fakeVoicesInit, initScript } from './probe';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const audio = argv.includes('--audio');

interface PNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount: number; children?: number[] }
interface Profile { nodes: PNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] }

async function main() {
  const dist = opt('dist', '');
  if (!dist) buildDebug(argv.includes('--no-build'));
  const srv = await startPreview(undefined, dist || 'dist-dbg');
  const chrome = await launchChrome({ extraFlags: audio ? ['--mute-audio'] : [] });
  try {
    const page = await chrome.ctx.newPage();
    if (audio) await page.addInitScript(initScript(fakeVoicesInit));
    const cdp = await chrome.ctx.newCDPSession(page);
    const emu = /^(\d+)x(\d+)@([\d.]+)$/.exec(opt('emu', ''));
    if (emu) await applyEmulation(cdp, { width: +emu[1], height: +emu[2], dpr: +emu[3], cpu: +opt('cpu', '2') });
    else await applyDesktopViewport(cdp, 1920, 1080);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    const q = new URLSearchParams({ autostart: '1', perf: '1', seed: '15', quality: opt('preset', 'medium'), tempo: 'standard', ...(audio ? {} : { noaudio: '1' }) });
    for (const [k, v] of new URLSearchParams(opt('extra', ''))) q.set(k, v);
    await page.goto(`${srv.url}?${q}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window as unknown as { __perf?: { frames(): unknown[] } }).__perf?.frames().length, null, { timeout: 180000 });
    await sleep(+opt('from', '0') * 1000);
    await cdp.send('Profiler.start');
    await sleep(+opt('secs', '20') * 1000);
    const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: Profile };
    report(profile);
  } finally {
    await chrome.close();
    srv.stop();
  }
  process.exit(0);
}

function report(p: Profile) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const name = (n: PNode) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const callers = new Map<string, Map<string, number>>();
  const match = opt('match', '');
  // per sample: the time it stands for goes to the leaf (self) and once to every distinct function on its stack (total)
  for (let i = 0; i < p.samples.length; i++) {
    const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000;
    let n = byId.get(p.samples[i]);
    if (!n) continue;
    const leaf = name(n);
    self.set(leaf, (self.get(leaf) ?? 0) + dt);
    const seen = new Set<string>();
    while (n) {
      const nm = name(n);
      if (!seen.has(nm)) {
        seen.add(nm);
        total.set(nm, (total.get(nm) ?? 0) + dt);
        if (match && nm.includes(match)) {
          const par = parent.has(n.id) ? byId.get(parent.get(n.id)!) : undefined;
          if (par) {
            const m = callers.get(nm) ?? new Map<string, number>();
            m.set(name(par), (m.get(name(par)) ?? 0) + dt);
            callers.set(nm, m);
          }
        }
      }
      const pid = parent.get(n.id);
      n = pid !== undefined ? byId.get(pid) : undefined;
    }
  }
  const secs = (p.endTime - p.startTime) / 1e6;
  const top = +opt('top', '40');
  const skip = (k: string) => /^\((root|program|idle)\)/.test(k);
  console.log(`\nprofile ${secs.toFixed(1)} s; busy ${(([...self.entries()].filter(([k]) => !/^\((idle|program)\)/.test(k)).reduce((a, [, v]) => a + v, 0)) / secs / 10).toFixed(1)} % of the main thread (excl. idle / program)`);
  console.log('\nself ms (ms/s):');
  for (const [k, v] of [...self.entries()].filter(([k]) => !skip(k)).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${v.toFixed(0).padStart(7)} (${(v / secs).toFixed(2).padStart(6)})  ${k}`);
  console.log('\ntotal ms (ms/s):');
  for (const [k, v] of [...total.entries()].filter(([k]) => !skip(k)).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${v.toFixed(0).padStart(7)} (${(v / secs).toFixed(2).padStart(6)})  ${k}`);
  for (const [k, m] of callers) {
    console.log(`\ncallers of ${k}:`);
    for (const [c, v] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${v.toFixed(0).padStart(7)}  ${c}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

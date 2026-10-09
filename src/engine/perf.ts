/**
 * In-page profiler. Off by default and free when off: every call site is `if (perf.on) ...` (one boolean), nothing is allocated.
 * Turned on by `?perf=1` (overlay + `window.__perf`) or `?bench=1` (the benchmark runner, no overlay).
 *
 * Per frame it records
 *   - `frame`  ms between two rAF callbacks (what the player sees), `js` ms the engine's tick took on the main thread
 *   - `laps`   an additive split of `js` (sim, director, puppets, ..., render): `perf.lap('name')` closes the section that started at the last lap
 *   - `subs`   nested costs that overlap the laps (mixer, IK, getState, ...): `const t = perf.t(); ...; perf.sub('name', t)`
 *   - `outs`   main-thread work outside the rAF tick (the audio controller's timer tick, the phone duck follower ...): `perf.outside('audio', t)`;
 *              credited to the next frame (the interval it delays), so `js + outs` is what the main thread spent per frame (`mainMs`)
 *   - `passes` per render pass (shadow, main, gtao, dof, bloom, output, grade): CPU ms (submit cost, children excluded), GPU ms (timer queries, a few
 *              frames late), draw calls and triangles (diff of `renderer.info`)
 *   - `info`   geometries / textures / programs, JS heap and its drops (garbage collections), long animation frames
 * and `window.__perf.stats()` gives median / p95 / p99 over a rolling window. See tools/perf/README.md.
 */
import type { Camera, Scene, WebGLRenderer } from 'three';

const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const flag = (k: string) => qs.has(k) && !['0', 'false', 'off'].includes((qs.get(k) ?? '').toLowerCase());

export interface PassRec {
  cpu: number;
  gpu: number;
  calls: number;
  tris: number;
}

export interface FrameRec {
  id: number;
  /** rAF delta (ms) */
  frame: number;
  /** tick duration on the main thread (ms) */
  js: number;
  laps: Record<string, number>;
  subs: Record<string, number>;
  /** main-thread ms spent outside the tick since the previous frame (timers: audio ...) */
  outs: Record<string, number>;
  passes: Record<string, PassRec>;
  calls: number;
  tris: number;
  geometries: number;
  textures: number;
  programs: number;
  heapMB: number;
  /** MB the JS heap shrank by since the last frame (a garbage collection ran); 0 otherwise */
  gcMB: number;
  /** MB allocated since the last frame (heap growth, plus whatever a GC freed) */
  allocMB: number;
  /** how long the browser's own frame work took when the page reported a long animation frame (ms), else 0 */
  loaf: number;
  scale: number;
  gpuDone: boolean;
}

export interface Stat {
  n: number;
  mean: number;
  median: number;
  p5: number;
  p95: number;
  p99: number;
  max: number;
}

export function stat(values: number[]): Stat {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, median: 0, p5: 0, p95: 0, p99: 0, max: 0 };
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1) + 0.5)))];
  let s = 0;
  for (const x of v) s += x;
  return { n, mean: s / n, median: q(0.5), p5: q(0.05), p95: q(0.95), p99: q(0.99), max: v[n - 1] };
}

interface GpuQuery {
  q: WebGLQuery;
  frame: FrameRec;
  name: string;
}

const KEEP = 900;
const LONG_MS = 25;

class Perf {
  on = flag('perf') || flag('bench');
  overlay = flag('perf');
  readonly frames: FrameRec[] = [];
  /** `true` once the GPU timer extension is in use */
  gpuTimer = false;
  gpuName = '';
  /** extra info the page wants in every report (preset, scene, scaler state ...) */
  readonly tags: Record<string, string | number | boolean> = {};
  readonly longFrames: { id: number; ms: number; cause: string }[] = [];
  longTasks = 0;
  longTaskMs = 0;

  private cur: FrameRec | null = null;
  private seq = 0;
  private lastLap = 0;
  private tickStart = 0;
  private lastRaf = 0;
  private lastHeap = 0;
  private renderer: WebGLRenderer | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private pending: GpuQuery[] = [];
  private pool: WebGLQuery[] = [];
  private activeQuery: GpuQuery | null = null;
  private stack: { name: string; t0: number; child: number; calls0: number; tris0: number; frame: FrameRec | null }[] = [];
  private loafBuf = 0;
  private overlayEl: HTMLElement | null = null;
  private overlayAt = 0;
  private extra: (() => Record<string, string | number>) | null = null;
  private scaleNow = 1;
  private pendingOuts: Record<string, number> = {};

  // ---- frame -----------------------------------------------------------------------------------------------------------

  /** top of the rAF callback (`ts` is the callback's timestamp) */
  frameBegin(ts: number) {
    if (!this.on) return;
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const f: FrameRec = {
      id: ++this.seq,
      frame: this.lastRaf ? ts - this.lastRaf : 0,
      js: 0,
      laps: {},
      subs: {},
      outs: this.pendingOuts,
      passes: {},
      calls: 0,
      tris: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
      heapMB: heap / 1048576,
      gcMB: 0,
      allocMB: 0,
      loaf: this.loafBuf,
      scale: this.scaleNow,
      gpuDone: !this.gpuTimer,
    };
    this.loafBuf = 0;
    this.pendingOuts = {};
    if (this.lastHeap) {
      const d = (heap - this.lastHeap) / 1048576;
      if (d < -0.25) f.gcMB = -d;
      else f.allocMB = d;
    }
    this.lastHeap = heap;
    this.lastRaf = ts;
    this.cur = f;
    this.tickStart = this.lastLap = performance.now();
    if (this.renderer) {
      const i = this.renderer.info;
      i.reset();
    }
  }

  /** end of the tick (after the render call) */
  frameEnd() {
    const f = this.cur;
    if (!f) return;
    this.lap('end');
    f.js = performance.now() - this.tickStart;
    if (this.renderer) {
      const i = this.renderer.info;
      f.calls = i.render.calls;
      f.tris = i.render.triangles;
      f.geometries = i.memory.geometries;
      f.textures = i.memory.textures;
      f.programs = i.programs?.length ?? 0;
    }
    this.frames.push(f);
    if (this.frames.length > KEEP) this.frames.shift();
    if (f.frame > LONG_MS) {
      const cause = this.cause(f);
      this.longFrames.push({ id: f.id, ms: f.frame, cause });
      if (this.longFrames.length > 200) this.longFrames.shift();
    }
    this.pollGpu();
    this.cur = null;
    if (this.overlay) this.updateOverlay();
  }

  /** why a frame was long: the biggest CPU lap, the GC, or "gpu / vsync" when the main thread was idle for most of it */
  private cause(f: FrameRec): string {
    if (f.gcMB > 4) return 'gc';
    if (f.js < f.frame * 0.55) return f.loaf > f.js * 1.5 ? 'browser (style/layout/raster)' : 'gpu / vsync / compositor';
    let best = '', bv = 0;
    for (const k in f.laps) if (f.laps[k] > bv) [best, bv] = [k, f.laps[k]];
    return `cpu: ${best} ${bv.toFixed(1)} ms`;
  }

  setScale(s: number) {
    this.scaleNow = s;
  }

  // ---- CPU sections -----------------------------------------------------------------------------------------------------

  /** close the section that began at the previous lap / the frame start */
  lap(name: string) {
    const f = this.cur;
    if (!f) return;
    const n = performance.now();
    f.laps[name] = (f.laps[name] ?? 0) + (n - this.lastLap);
    this.lastLap = n;
  }

  /** a timestamp for `sub`, 0 when profiling is off */
  t(): number {
    return this.on ? performance.now() : 0;
  }

  /** add the time since `t0` to the nested bucket `name` (these overlap the laps) */
  sub(name: string, t0: number) {
    const f = this.cur;
    if (!f) return;
    f.subs[name] = (f.subs[name] ?? 0) + (performance.now() - t0);
  }

  /** main-thread work outside the frame's tick (a timer callback) that began at `t0`: credited to the next frame */
  outside(name: string, t0: number) {
    if (!this.on) return;
    this.pendingOuts[name] = (this.pendingOuts[name] ?? 0) + (performance.now() - t0);
  }

  // ---- render passes ----------------------------------------------------------------------------------------------------

  /**
   * Hook a renderer and its pass list. Passes of the composer are wrapped (`render` is replaced), `renderer.shadowMap.render` is wrapped, the GPU timer
   * extension is turned on if present. `info.autoReset` is switched off so the counters cover the whole frame (reset in `frameBegin`).
   */
  attach(renderer: WebGLRenderer, passes: { name: string; pass: { render: (...a: never[]) => void } }[] = []) {
    if (!this.on) return;
    this.renderer = renderer;
    renderer.info.autoReset = false;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (ext && !flag('nogpuq')) {
      this.ext = ext;
      this.gpuTimer = true;
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    for (const { name, pass } of passes) this.wrap(pass, 'render', name);
    this.wrap(renderer.shadowMap, 'render', 'shadow');
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (e.entryType === 'long-animation-frame') this.loafBuf = Math.max(this.loafBuf, e.duration);
          else {
            this.longTasks++;
            this.longTaskMs += e.duration;
          }
        }
      }).observe({ entryTypes: ['long-animation-frame', 'longtask'] });
    } catch {
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            this.longTasks++;
            this.longTaskMs += e.duration;
          }
        }).observe({ entryTypes: ['longtask'] });
      } catch {
        /* not supported */
      }
    }
  }

  /** wrap `obj[method]` so the call is a measured pass called `name` */
  wrap(target: object, method: string, name: string) {
    const obj = target as Record<string, (...a: unknown[]) => unknown>;
    const orig = obj[method];
    if (typeof orig !== 'function' || (orig as unknown as { __perf?: boolean }).__perf) return;
    const self = this;
    const w = function (this: unknown, ...a: unknown[]) {
      self.passBegin(name);
      try {
        return orig.apply(this, a);
      } finally {
        self.passEnd();
      }
    };
    (w as unknown as { __perf: boolean }).__perf = true;
    obj[method] = w;
  }

  passBegin(name: string) {
    const f = this.cur;
    const i = this.renderer?.info.render;
    this.stack.push({ name, t0: performance.now(), child: 0, calls0: i?.calls ?? 0, tris0: i?.triangles ?? 0, frame: f && this.renderer ? f : null });
    if (f) this.gpuSwitch(name, f);
  }

  passEnd() {
    const s = this.stack.pop();
    if (!s || !s.frame || !this.renderer) return;
    // (a pass that began outside a frame, e.g. in the warm-up, records nothing)
    const dt = performance.now() - s.t0;
    const i = this.renderer.info.render;
    const rec = (s.frame.passes[s.name] ??= { cpu: 0, gpu: 0, calls: 0, tris: 0 });
    rec.cpu += dt - s.child;
    rec.calls += i.calls - s.calls0;
    rec.tris += i.triangles - s.tris0;
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.child += dt;
      // the parent's own calls / triangles exclude this child's
      parent.calls0 += i.calls - s.calls0;
      parent.tris0 += i.triangles - s.tris0;
    }
    this.gpuSwitch(parent?.name ?? null, s.frame);
  }

  // ---- GPU timer queries (one TIME_ELAPSED query can be open at a time: nested passes switch the open query) ---------------

  private gpuSwitch(name: string | null, f: FrameRec) {
    const gl = this.gl, ext = this.ext;
    if (!gl || !ext) return;
    if (this.activeQuery) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.pending.push(this.activeQuery);
      this.activeQuery = null;
    }
    if (name === null) return;
    const q = this.pool.pop() ?? gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.activeQuery = { q, frame: f, name };
  }

  private pollGpu() {
    const gl = this.gl, ext = this.ext;
    if (!gl || !ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const p = this.pending[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) {
        const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT) as number;
        const rec = (p.frame.passes[p.name] ??= { cpu: 0, gpu: 0, calls: 0, tris: 0 });
        rec.gpu += ns / 1e6;
      }
      this.pool.push(p.q);
    }
    // a frame is complete once no pending query belongs to it
    const oldest = this.pending[0]?.frame.id ?? Infinity;
    for (const f of this.frames) if (!f.gpuDone && f.id < oldest) f.gpuDone = true;
  }

  // ---- reports ----------------------------------------------------------------------------------------------------------

  reset() {
    this.frames.length = 0;
    this.longFrames.length = 0;
    this.longTasks = 0;
    this.longTaskMs = 0;
    this.pending.length = 0;
  }

  /** a frame's total GPU time (sum of the passes) */
  static gpuOf(f: FrameRec): number {
    let s = 0;
    for (const k in f.passes) s += f.passes[k].gpu;
    return s;
  }

  static renderCpuOf(f: FrameRec): number {
    let s = 0;
    for (const k in f.passes) s += f.passes[k].cpu;
    return s;
  }

  /** statistics over the last `n` complete frames (skipping the first `skip`), as plain JSON */
  stats(n = 300, skip = 0) {
    let fr = this.frames.slice(skip);
    if (this.gpuTimer) fr = fr.filter((f) => f.gpuDone);
    fr = fr.slice(-n);
    const fps = fr.map((f) => (f.frame > 0 ? 1000 / f.frame : 0)).filter((x) => x > 0);
    const keys = <K extends 'laps' | 'subs' | 'outs'>(k: K) => [...new Set(fr.flatMap((f) => Object.keys(f[k])))];
    const passNames = [...new Set(fr.flatMap((f) => Object.keys(f.passes)))];
    const col = (fn: (f: FrameRec) => number) => stat(fr.map(fn));
    const out = {
      frames: fr.length,
      renderer: this.gpuName,
      gpuTimer: this.gpuTimer,
      tags: { ...this.tags },
      fps: stat(fps),
      /** rAF-to-rAF interval: the number the player feels */
      frameMs: col((f) => f.frame),
      /** tick time on the main thread */
      jsMs: col((f) => f.js),
      gpuMs: col((f) => Perf.gpuOf(f)),
      renderCpuMs: col((f) => Perf.renderCpuOf(f)),
      laps: Object.fromEntries(keys('laps').map((k) => [k, col((f) => f.laps[k] ?? 0)])),
      subs: Object.fromEntries(keys('subs').map((k) => [k, col((f) => f.subs[k] ?? 0)])),
      /** main-thread work outside the tick per frame (audio timers ...), and tick + that */
      outs: Object.fromEntries(keys('outs').map((k) => [k, col((f) => f.outs[k] ?? 0)])),
      mainMs: col((f) => { let s = f.js; for (const k in f.outs) s += f.outs[k]; return s; }),
      passes: Object.fromEntries(
        passNames.map((p) => [
          p,
          { cpu: col((f) => f.passes[p]?.cpu ?? 0), gpu: col((f) => f.passes[p]?.gpu ?? 0), calls: col((f) => f.passes[p]?.calls ?? 0), tris: col((f) => f.passes[p]?.tris ?? 0) },
        ]),
      ),
      calls: col((f) => f.calls),
      triangles: col((f) => f.tris),
      geometries: col((f) => f.geometries),
      textures: col((f) => f.textures),
      programs: col((f) => f.programs),
      heapMB: col((f) => f.heapMB),
      allocMBperFrame: col((f) => f.allocMB),
      /** average allocation rate (MB/s): heap growth plus what the collections freed */
      allocMBps: (fr.reduce((a, f) => a + f.allocMB + f.gcMB, 0) / Math.max(1e-3, fr.reduce((a, f) => a + f.frame, 0))) * 1000,
      gcEvents: fr.filter((f) => f.gcMB > 0.25).length,
      gcMBmax: Math.max(0, ...fr.map((f) => f.gcMB)),
      longFramesOver25ms: fr.filter((f) => f.frame > LONG_MS).length,
      longFrameCauses: this.longFrames.slice(-20).map((l) => `${l.ms.toFixed(0)} ms: ${l.cause}`),
      longTasks: this.longTasks,
      longTaskMs: this.longTaskMs,
      scale: col((f) => f.scale),
    };
    return out;
  }

  /** texture memory estimate (bytes) over everything in the scene, by uploaded size incl. mips */
  textureMemory(scene: Scene, renderer: WebGLRenderer) {
    const seen = new Set<unknown>();
    let bytes = 0, count = 0;
    const big: { name: string; w: number; h: number; mb: number }[] = [];
    const add = (t: unknown) => {
      const tex = t as { isTexture?: boolean; image?: { width?: number; height?: number }; mipmaps?: { data?: { byteLength: number } }[]; isCompressedTexture?: boolean; name?: string; generateMipmaps?: boolean; source?: unknown };
      if (!tex || !tex.isTexture || seen.has(tex.source ?? tex)) return;
      seen.add(tex.source ?? tex);
      let b = 0;
      let w = 0, h = 0;
      if (tex.isCompressedTexture && tex.mipmaps) for (const m of tex.mipmaps) b += m.data?.byteLength ?? 0;
      else {
        w = tex.image?.width ?? 0;
        h = tex.image?.height ?? 0;
        b = w * h * 4 * (tex.generateMipmaps === false ? 1 : 1.34);
      }
      bytes += b;
      count++;
      if (b > 4e6) big.push({ name: tex.name || '(unnamed)', w, h, mb: +(b / 1048576).toFixed(1) });
    };
    scene.traverse((o) => {
      const m = (o as { material?: unknown }).material;
      for (const mm of Array.isArray(m) ? m : m ? [m] : []) for (const k in mm as object) add((mm as Record<string, unknown>)[k]);
    });
    void renderer;
    big.sort((a, b) => b.mb - a.mb);
    return { textures: count, mb: +(bytes / 1048576).toFixed(0), biggest: big.slice(0, 12) };
  }

  /** extra lines for the overlay */
  setOverlayExtra(fn: () => Record<string, string | number>) {
    this.extra = fn;
  }

  // ---- overlay ----------------------------------------------------------------------------------------------------------

  private updateOverlay() {
    const now = performance.now();
    if (now - this.overlayAt < 500) return;
    this.overlayAt = now;
    if (!this.overlayEl) {
      const el = document.createElement('pre');
      el.style.cssText = 'position:fixed;left:6px;top:6px;z-index:99999;margin:0;padding:6px 8px;background:rgba(0,0,0,.72);color:#9f9;font:11px/1.25 ui-monospace,monospace;pointer-events:none;white-space:pre;max-width:96vw;overflow:hidden';
      document.body.appendChild(el);
      this.overlayEl = el;
    }
    const s = this.stats(180);
    const f = (x: Stat) => `${x.median.toFixed(1)}/${x.p95.toFixed(1)}`;
    const L: string[] = [];
    L.push(`fps ${s.fps.median.toFixed(0)} (p5 ${s.fps.p5.toFixed(0)})   frame ms med/p95 ${f(s.frameMs)}   js ${f(s.jsMs)}   gpu ${s.gpuTimer ? f(s.gpuMs) : 'n/a'}`);
    L.push(`laps  ${Object.entries(s.laps).filter(([k]) => k !== 'end').map(([k, v]) => `${k} ${v.median.toFixed(1)}`).join('  ')}`);
    const subs = Object.entries(s.subs).filter(([, v]) => v.median >= 0.05);
    if (subs.length) L.push(`subs  ${subs.map(([k, v]) => `${k} ${v.median.toFixed(2)}`).join('  ')}`);
    const outs = Object.entries(s.outs);
    if (outs.length) L.push(`outside the tick (mean ms/frame)  ${outs.map(([k, v]) => `${k} ${v.mean.toFixed(2)} (max ${v.max.toFixed(1)})`).join('  ')}   main ${f(s.mainMs)}`);
    L.push('pass        cpu   gpu  calls   tris');
    for (const [k, v] of Object.entries(s.passes)) L.push(`${k.padEnd(10)} ${v.cpu.median.toFixed(1).padStart(5)} ${(s.gpuTimer ? v.gpu.median.toFixed(1) : '-').padStart(5)} ${v.calls.median.toFixed(0).padStart(6)} ${(v.tris.median / 1000).toFixed(0).padStart(5)}k`);
    L.push(`total draw calls ${s.calls.median.toFixed(0)}  tris ${(s.triangles.median / 1000).toFixed(0)}k  geo ${s.geometries.median.toFixed(0)}  tex ${s.textures.median.toFixed(0)}  prog ${s.programs.median.toFixed(0)}`);
    L.push(`heap ${s.heapMB.median.toFixed(0)} MB  alloc ${(s.allocMBperFrame.median * 60).toFixed(1)} MB/s  GCs ${s.gcEvents}  long>25ms ${s.longFramesOver25ms}  longtasks ${s.longTasks}`);
    if (this.extra) L.push(Object.entries(this.extra()).map(([k, v]) => `${k} ${v}`).join('  '));
    const lf = this.longFrames[this.longFrames.length - 1];
    if (lf) L.push(`last long frame: ${lf.ms.toFixed(0)} ms (${lf.cause})`);
    L.push(`${this.gpuName}`);
    this.overlayEl.textContent = L.join('\n');
  }
}

export const perf = new Perf();
export type { Camera };

if (typeof window !== 'undefined' && perf.on) {
  (window as unknown as { __perf: unknown }).__perf = {
    perf,
    stats: (n?: number, skip?: number) => perf.stats(n, skip),
    reset: () => perf.reset(),
    frames: () => perf.frames,
  };
}

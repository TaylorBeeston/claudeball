/**
 * Build-agnostic in-page probe, injected by the perf runner with `page.addInitScript` before any game code runs, so it measures every build the
 * same way (also builds older than this file). It adds to each bench scene's `stats` (the bench's `perf.stats()` result) a `probe` object:
 *
 *   - main-thread time per frame split into rAF callbacks (the engine tick) and timer callbacks (the audio controller's 30 / 15 Hz tick, the
 *     phone duck follower, booth / organ / speech timers): work outside the rAF tick that the engine's own laps cannot see;
 *   - the audio controller's tick (`__audioDebug.controller.tick`, wrapped on the instance): count, p50 / p95 / p99 / max, and its parts
 *     (booth, crowd, music, cues, speech ...) in ms per second;
 *   - Web Audio churn: nodes created by type (before the scene = the standing graph, during it = per-event creation), connect / disconnect
 *     calls, AudioParam automation calls, AudioBuffers made; all per second of the scene;
 *   - the AudioContext: state, sample rate, base / output latency, `playbackStats` (Chrome: underruns, latency) over the scene, the audio
 *     clock against the wall clock;
 *   - validity facts: audio running / locked, low-power path, live voices.
 * `performance.mark('probe:start:<scene>')` / `probe:end:<scene>` bracket each measured window, so a Chrome trace (`--audiotrace`) can be cut per scene.
 */

/** the function given to `addInitScript`: must be self-contained (it is serialised) */
export function probeInit() {
  const W = window as unknown as Record<string, any>;
  if (W.__probe) return;
  const now = () => performance.now();
  type Frame = { raf: number; timers: number; timerCalls: number; tick: number };
  const P = {
    frames: [] as Frame[],
    cur: { raf: 0, timers: 0, timerCalls: 0, tick: 0 } as Frame,
    lastTs: -1,
    t0: now(),
    nodes: {} as Record<string, number>,
    buffers: 0,
    bufferSamples: 0,
    params: 0,
    paramSets: 0,
    connects: 0,
    disconnects: 0,
    graphMs: 0,
    ticks: [] as number[],
    parts: {} as Record<string, number>,
    ctxs: [] as AudioContext[],
    patched: false,
    perfHooked: false,
    snap: null as null | Record<string, any>,
    n: 0,
    voicesMax: 0,
  };
  W.__probe = P;

  // ---- frames: rAF callbacks (one frame = callbacks sharing a timestamp) -----------------------------------------------------------------
  const raf = W.requestAnimationFrame.bind(window);
  W.requestAnimationFrame = (cb: FrameRequestCallback) =>
    raf((ts: number) => {
      if (ts !== P.lastTs) {
        if (P.lastTs >= 0) P.frames.push(P.cur);
        if (P.frames.length > 40000) P.frames.splice(0, 10000);
        P.cur = { raf: 0, timers: 0, timerCalls: 0, tick: 0 };
        P.lastTs = ts;
        hook();
        if (++P.n % 10 === 0) {
          const v = W.__audioDebug?.controller?.mixer?.voiceCount;
          if (typeof v === 'number' && v > P.voicesMax) P.voicesMax = v;
        }
      }
      const t = now();
      try {
        cb(ts);
      } finally {
        P.cur.raf += now() - t;
      }
    });

  // ---- timers ------------------------------------------------------------------------------------------------------------------------------
  const wrapTimer = (name: 'setTimeout' | 'setInterval') => {
    const orig = W[name].bind(window);
    W[name] = (cb: unknown, ms?: number, ...rest: unknown[]) => {
      if (typeof cb !== 'function') return orig(cb, ms, ...rest);
      return orig(
        (...a: unknown[]) => {
          const t = now();
          try {
            (cb as (...x: unknown[]) => void)(...a);
          } finally {
            P.cur.timers += now() - t;
            P.cur.timerCalls++;
          }
        },
        ms,
        ...rest,
      );
    };
  };
  wrapTimer('setTimeout');
  wrapTimer('setInterval');

  // ---- Web Audio ---------------------------------------------------------------------------------------------------------------------------
  const count = (k: string) => (P.nodes[k] = (P.nodes[k] ?? 0) + 1);
  const BAC = W.BaseAudioContext?.prototype;
  if (BAC) {
    for (const m of Object.getOwnPropertyNames(BAC)) {
      if (!/^create/.test(m) || m === 'createPeriodicWave') continue;
      const d = Object.getOwnPropertyDescriptor(BAC, m);
      if (!d || typeof d.value !== 'function') continue;
      const orig = d.value;
      BAC[m] = function (this: unknown, ...a: unknown[]) {
        const t = now();
        const r = orig.apply(this, a);
        P.graphMs += now() - t;
        if (m === 'createBuffer') {
          P.buffers++;
          P.bufferSamples += (a[0] as number) * (a[1] as number);
        } else count(m.slice(6) + 'Node');
        return r;
      };
    }
  }
  for (const name of ['GainNode', 'BiquadFilterNode', 'DelayNode', 'StereoPannerNode', 'PannerNode', 'ConvolverNode', 'DynamicsCompressorNode', 'WaveShaperNode', 'AudioBufferSourceNode', 'OscillatorNode', 'ConstantSourceNode', 'AnalyserNode', 'ChannelSplitterNode', 'ChannelMergerNode', 'IIRFilterNode', 'AudioWorkletNode', 'MediaElementAudioSourceNode']) {
    const Orig = W[name];
    if (typeof Orig !== 'function') continue;
    const C = class extends Orig {
      constructor(...a: unknown[]) {
        const t = now();
        super(...a);
        P.graphMs += now() - t;
        count(name.replace(/^AudioBufferSource/, 'BufferSource'));
      }
    };
    Object.defineProperty(C, 'name', { value: name });
    W[name] = C;
  }
  if (typeof W.AudioBuffer === 'function') {
    const Orig = W.AudioBuffer;
    const C = class extends Orig {
      constructor(o: { length: number; numberOfChannels?: number }) {
        super(o);
        P.buffers++;
        P.bufferSamples += (o?.length ?? 0) * (o?.numberOfChannels ?? 1);
      }
    };
    Object.defineProperty(C, 'name', { value: 'AudioBuffer' });
    W.AudioBuffer = C;
  }
  if (typeof W.AudioContext === 'function') {
    const Orig = W.AudioContext;
    const C = class extends Orig {
      constructor(...a: unknown[]) {
        super(...a);
        P.ctxs.push(this as unknown as AudioContext);
      }
    };
    Object.defineProperty(C, 'name', { value: 'AudioContext' });
    W.AudioContext = C;
  }
  const AN = W.AudioNode?.prototype;
  if (AN) {
    const c0 = AN.connect, d0 = AN.disconnect;
    AN.connect = function (this: unknown, ...a: unknown[]) {
      const t = now();
      try {
        return c0.apply(this, a);
      } finally {
        P.graphMs += now() - t;
        P.connects++;
      }
    };
    AN.disconnect = function (this: unknown, ...a: unknown[]) {
      const t = now();
      try {
        return d0.apply(this, a);
      } finally {
        P.graphMs += now() - t;
        P.disconnects++;
      }
    };
  }
  const AP = W.AudioParam?.prototype;
  if (AP) {
    for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) {
      const orig = AP[m];
      if (typeof orig !== 'function') continue;
      AP[m] = function (this: unknown, ...a: unknown[]) {
        P.params++;
        return orig.apply(this, a);
      };
    }
    const d = Object.getOwnPropertyDescriptor(AP, 'value');
    if (d?.set) {
      const set = d.set;
      Object.defineProperty(AP, 'value', {
        ...d,
        set(this: unknown, v: number) {
          P.paramSets++;
          set.call(this, v);
        },
      });
    }
  }

  // ---- the audio controller: its tick and the parts of it (whatever exists in this build) ---------------------------------------------
  const PARTS: [string, string][] = [
    ['booth.tick', 'booth'], ['booth.observe', 'booth'], ['booth.replay', 'booth'], ['crowd.update', 'crowd'], ['crowd.observe', 'crowd'], ['ambience.apply', 'crowd'],
    ['music.tick', 'music'], ['music.observe', 'music'], ['speech.pump', 'speech'], ['sink.apply', 'speech'], ['mixer.level', 'level'], ['mapper.map', 'cues'],
  ];
  const PROTO_PARTS: [string, string][] = [['frameCues', 'cues'], ['dispatch', 'cues'], ['boothCtx', 'boothCtx'], ['buildCtx', 'cues'], ['playShot', 'crowd'], ['state', 'state']];
  const timeMethod = (obj: any, m: string, part: string) => {
    const orig = obj?.[m];
    if (typeof orig !== 'function') return;
    obj[m] = function (this: unknown, ...a: unknown[]) {
      const t = now();
      try {
        return orig.apply(this, a);
      } finally {
        P.parts[part] = (P.parts[part] ?? 0) + (now() - t);
      }
    };
  };
  function patchController() {
    const c = W.__audioDebug?.controller;
    if (!c || c.__probed) return;
    c.__probed = true;
    P.patched = true;
    const tick = c.tick;
    if (typeof tick === 'function')
      c.tick = function (this: unknown, ...a: unknown[]) {
        const t = now();
        try {
          return tick.apply(c, a);
        } finally {
          const d = now() - t;
          P.ticks.push(d);
          P.cur.tick += d;
        }
      };
    for (const [path, part] of PARTS) {
      const [o, m] = path.split('.');
      timeMethod(c[o], m, part);
    }
    for (const [m, part] of PROTO_PARTS) timeMethod(c, m, part);
  }

  // ---- bench windows: the bench calls perf.reset() before a scene's measured frames and perf.stats() after them ---------------------
  const pstats = () => {
    const c = P.ctxs[P.ctxs.length - 1] as any;
    const ps = c?.playbackStats;
    return { at: now(), ctxTime: c?.currentTime ?? 0, ps: ps ? { underrunEvents: ps.underrunEvents, underrunDuration: ps.underrunDuration, totalDuration: ps.totalDuration, averageLatency: ps.averageLatency, maximumLatency: ps.maximumLatency } : null };
  };
  const snapshot = () => ({ phase: W.__audioDebug?.controller?.phaseNow ?? null, gameTime: W.__audioDebug?.controller?.host?.liveState?.time ?? null, nodes: { ...P.nodes }, buffers: P.buffers, bufferSamples: P.bufferSamples, params: P.params, paramSets: P.paramSets, connects: P.connects, disconnects: P.disconnects, graphMs: P.graphMs, ...pstats() });
  const stat = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    const n = s.length;
    const q = (p: number) => (n ? s[Math.min(n - 1, Math.floor(p * (n - 1) + 0.5))] : 0);
    return { n, mean: n ? s.reduce((a, b) => a + b, 0) / n : 0, median: q(0.5), p95: q(0.95), p99: q(0.99), max: n ? s[n - 1] : 0 };
  };
  let scene = '';
  function hook() {
    patchController();
    if (P.perfHooked) return;
    const pf = W.__perf?.perf;
    if (!pf) return;
    P.perfHooked = true;
    const reset = pf.reset.bind(pf);
    pf.reset = () => {
      reset();
      scene = String(W.__bench?.progress ?? '');
      P.frames = [];
      P.ticks = [];
      P.parts = {};
      P.voicesMax = 0;
      P.snap = snapshot();
      performance.mark(`probe:start:${scene}`);
    };
    const stats = pf.stats.bind(pf);
    pf.stats = (...a: unknown[]) => {
      const out = stats(...a);
      if (P.snap && W.__bench && !W.__bench.done) {
        performance.mark(`probe:end:${scene}`);
        try {
          out.probe = summary();
        } catch (e) {
          out.probe = { error: String(e) };
        }
      }
      return out;
    };
  }
  // ---- play mode (the real game, no bench): the runner calls __probe.playStart() / __probe.playEnd(); every perf frame is kept meanwhile
  let all: unknown[] | null = null;
  W.__probeStart = () => {
    hook();
    const pf = W.__perf?.perf;
    if (!pf) return false;
    scene = 'play';
    P.frames = [];
    P.ticks = [];
    P.parts = {};
    P.voicesMax = 0;
    P.snap = snapshot();
    pf.reset();
    all = [];
    const arr = pf.frames as unknown[];
    const push = arr.push;
    arr.push = function (this: unknown[], ...x: unknown[]) {
      // each frame tagged with the director's shot (B-roll with its kind), for the per-shot table
      const d = W.engine?.director;
      const shot = d ? `${d.shot}${d.shot === 'broll' && d.broll?.shot?.kind ? `:${d.broll.shot.kind}` : ''}` : '?';
      for (const f of x) (f as { shot?: string }).shot = shot;
      all?.push(...x);
      return push.apply(this, x);
    };
    performance.mark('probe:start:play');
    return true;
  };
  W.__probeEnd = () => {
    const pf = W.__perf?.perf;
    performance.mark('probe:end:play');
    const fake = Object.create(Object.getPrototypeOf(pf));
    Object.assign(fake, { frames: all ?? [], gpuTimer: pf.gpuTimer, gpuName: pf.gpuName, tags: pf.tags, longFrames: pf.longFrames, longTasks: pf.longTasks, longTaskMs: pf.longTaskMs });
    const out = Object.getPrototypeOf(pf).stats.call(fake, (all ?? []).length);
    out.probe = summary();
    // per shot: frames, missed vsyncs (> 1.5 refresh intervals), the engine tick, GPU time, draw calls
    const by: Record<string, { frame: number; js: number; gpu: number; calls: number }[]> = {};
    for (const f of (all ?? []) as { shot?: string; frame: number; js: number; calls: number; passes: Record<string, { gpu: number }> }[]) {
      let g = 0;
      for (const k in f.passes) g += f.passes[k].gpu;
      (by[f.shot ?? '?'] ??= []).push({ frame: f.frame, js: f.js, gpu: g, calls: f.calls });
    }
    const med = (v: number[]) => { const s2 = [...v].sort((a, b) => a - b); return s2.length ? s2[(s2.length - 1) >> 1] : 0; };
    const p95 = (v: number[]) => { const s2 = [...v].sort((a, b) => a - b); return s2.length ? s2[Math.floor(0.95 * (s2.length - 1))] : 0; };
    const iv = med((all ?? []).map((f) => (f as { frame: number }).frame).filter((x) => x > 0));
    out.probe.shots = Object.fromEntries(Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, {
      frames: v.length,
      missed: v.filter((f) => f.frame > iv * 1.5).length,
      jsMed: +med(v.map((f) => f.js)).toFixed(2),
      jsP95: +p95(v.map((f) => f.js)).toFixed(2),
      gpuMed: +med(v.map((f) => f.gpu)).toFixed(2),
      gpuP95: +p95(v.map((f) => f.gpu)).toFixed(2),
      calls: Math.round(med(v.map((f) => f.calls))),
    }]));
    all = null;
    return out;
  };

  /** the standing graph (this build's own counters where it has them) and the voices' peak */
  function graphFacts(c: any) {
    const g = c?.mixer?.graph;
    if (!g) return null;
    const conv = g.conv as ConvolverNode | null | undefined;
    const amb = c.ambience;
    return {
      venueNodes: g.stats?.nodes ?? null,
      bedNodes: amb ? (amb.nodes?.length ?? 0) + (amb.sources?.length ?? 0) : null,
      mics: g.mics?.length ?? null,
      irSeconds: conv?.buffer ? +conv.buffer.duration.toFixed(2) : null,
      irChannels: conv?.buffer?.numberOfChannels ?? null,
      sampleRate: c.mixer?.ctx?.sampleRate ?? null,
      duck: g.duckNode ? 'worklet' : g.keyTap ? 'analyser' : 'none',
      voicesMax: P.voicesMax,
    };
  }

  function summary() {
    const s0 = P.snap!, s1 = snapshot();
    const secs = Math.max(1e-3, (s1.at - s0.at) / 1000);
    const per = (a: number, b: number) => +((b - a) / secs).toFixed(2);
    const nodes: Record<string, number> = {};
    for (const k of new Set([...Object.keys(s0.nodes), ...Object.keys(s1.nodes)])) {
      const d = (s1.nodes[k] ?? 0) - (s0.nodes[k] ?? 0);
      if (d) nodes[k] = +(d / secs).toFixed(2);
    }
    const fr = P.frames.slice(1);
    const c = W.__audioDebug?.controller;
    const ctx = P.ctxs[P.ctxs.length - 1] as any;
    let psDelta = null;
    if (s0.ps && s1.ps) psDelta = { underrunEvents: s1.ps.underrunEvents - s0.ps.underrunEvents, underrunMs: +((s1.ps.underrunDuration - s0.ps.underrunDuration) * 1000).toFixed(1), playedS: +(s1.ps.totalDuration - s0.ps.totalDuration).toFixed(2), avgLatencyMs: +(s1.ps.averageLatency * 1000).toFixed(1), maxLatencyMs: +(s1.ps.maximumLatency * 1000).toFixed(1) };
    const parts: Record<string, number> = {};
    for (const [k, v] of Object.entries(P.parts)) parts[k] = +(v / secs).toFixed(2);
    return {
      secs: +secs.toFixed(2),
      rafMs: stat(fr.map((f) => f.raf)),
      timerMs: stat(fr.map((f) => f.timers)),
      mainMs: stat(fr.map((f) => f.raf + f.timers)),
      timerMsPerSec: +((fr.reduce((a, f) => a + f.timers, 0) / secs)).toFixed(2),
      timerCallsPerSec: +((fr.reduce((a, f) => a + f.timerCalls, 0) / secs)).toFixed(1),
      audioTick: { ...stat(P.ticks), perSec: +(P.ticks.length / secs).toFixed(1), msPerSec: +(P.ticks.reduce((a, b) => a + b, 0) / secs).toFixed(2) },
      audioParts: parts,
      nodesPerSec: nodes,
      graphNodes: (Object.values(s0.nodes) as number[]).reduce((a, b) => a + b, 0),
      graphNodesByType: s0.nodes,
      buffersPerSec: per(s0.buffers, s1.buffers),
      bufferMB: +((s1.bufferSamples * 4) / 1048576).toFixed(1),
      paramCallsPerSec: per(s0.params, s1.params),
      paramSetsPerSec: per(s0.paramSets, s1.paramSets),
      connectsPerSec: per(s0.connects, s1.connects),
      disconnectsPerSec: per(s0.disconnects, s1.disconnects),
      graphCallMsPerSec: +((s1.graphMs - s0.graphMs) / secs).toFixed(3),
      ctx: ctx ? { state: ctx.state, sampleRate: ctx.sampleRate, baseLatencyMs: +(ctx.baseLatency * 1000).toFixed(1), outputLatencyMs: +((ctx.outputLatency ?? 0) * 1000).toFixed(1), clockRatio: +((s1.ctxTime - s0.ctxTime) / secs).toFixed(3), playback: psDelta } : null,
      visibility: document.visibilityState,
      audioGraph: graphFacts(c),
      controller: c ? { lowPower: c.lowPower, locked: c.locked ?? c.isLocked, mixer: c.mixer?.state, ready: c.mixer?.ready, prepared: `${c.mixer?.prepared}/${c.mixer?.totalToPrepare}`, beds: c.ambience?.started, irMs: c.mixer?.graph?.stats?.irMs, voices: c.mixer?.voiceCount, phase: c.phaseNow ?? null, chat: c.debug?.chat ? Object.values(c.debug.chat as Record<string, number>).reduce((a, b) => a + b, 0) : null } : null,
    };
  }
}

/** headless / CI Chrome has no speech voices and real ones go out of process: a fake engine that "speaks" for a time proportional to the text */
export function fakeVoicesInit() {
  const w = window as unknown as Record<string, unknown>;
  const voices = [{ name: 'Fake David', lang: 'en-US', localService: true, default: true, voiceURI: 'fake-david' }, { name: 'Fake Zira', lang: 'en-US', localService: true, default: false, voiceURI: 'fake-zira' }, { name: 'Fake Alex', lang: 'en-GB', localService: true, default: false, voiceURI: 'fake-alex' }];
  let cur: ReturnType<typeof setTimeout> | null = null;
  w.SpeechSynthesisUtterance = function (this: Record<string, unknown>, t: string) {
    this.text = t;
  };
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => voices,
      speaking: false,
      pending: false,
      paused: false,
      speak(u: { text: string; onstart?: () => void; onend?: () => void }) {
        setTimeout(() => u.onstart?.(), 10);
        cur = setTimeout(() => u.onend?.(), 300 + u.text.length * 55);
      },
      cancel() {
        if (cur) clearTimeout(cur);
      },
      pause() {},
      resume() {},
      addEventListener() {},
      removeEventListener() {},
    },
  });
}

/** an init script from one of the functions above (tsx / esbuild wraps named functions in `__name(...)`, which the page does not have) */
export function initScript(fn: () => void): { content: string } {
  return { content: `(() => { const __name = (f) => f; (${fn.toString()})(); })();` };
}

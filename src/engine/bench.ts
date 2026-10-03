/**
 * Deterministic benchmark (`?bench=1`, started by the app after boot; driven by tools/perf/run.ts or by hand).
 *
 *   ?bench=1&autostart&noaudio&seed=15&tempo=standard&quality=high&tod=day&scenes=pitchcam,wide,faces&frames=360&warm=90&scale=1&shots=1
 *
 * - the game steps a fixed 1/60 s per frame (whatever the real frame time), so every preset plays out the same game;
 * - the adaptive resolution scale is off (fixed `scale`, default 1) so presets are comparable;
 * - each scene is a scripted static camera held for `frames` frames after `warm` discarded frames;
 * - results (`perf.stats()` per scene + device facts) land in `window.__bench`; with `shots=1` each scene waits for `__bench.release = true`
 *   after the runner has taken a screenshot.
 */
import { Vector3 } from 'three';
import type { Engine } from './engine';
import { perf } from './perf';

interface Cam {
  pos: Vector3;
  tgt: Vector3;
  fov: number;
  aperture: number;
}

type SceneFn = (e: Engine, out: Cam) => void;

const set = (o: Cam, p: [number, number, number], t: [number, number, number], fov: number, aperture = 1) => {
  o.pos.set(...p);
  o.tgt.set(...t);
  o.fov = fov;
  o.aperture = aperture;
};

const face = new Vector3();
function batterFace(e: Engine, out: Cam, who: 'batter' | 'pitcher') {
  const p = e.liveState.players.find((q) => q.role === who);
  if (p && e.players.faceOf(p.id, face)) {
    out.tgt.copy(face);
    // from the front-side of the player, a little above eye level: the head fills a good part of the picture
    const dir = who === 'batter' ? new Vector3(0.7, 0.15, 2.6) : new Vector3(0.5, 0.15, -2.6);
    out.pos.copy(face).add(dir);
    out.fov = 26;
    out.aperture = 1.2;
  } else set(out, [1, 1.9, 3], [0, 1.6, 0], 26);
}

export const SCENES: Record<string, SceneFn> = {
  /** the classic centre-field telephoto: pitcher, batter, catcher, umpire (few puppets, big magnification) */
  pitchcam: (_e, o) => set(o, [-2.6, 10.5, 121], [0, 1.4, 4], 9, 1),
  /** wide behind home: the whole infield, most of the cast, a lot of stands */
  wide: (_e, o) => set(o, [0, 28, -45], [0, 3, 45], 42, 0.6),
  /** high home camera following the ball into the outfield */
  follow: (_e, o) => set(o, [0, 17, -26], [0, 6, 70], 38, 0.8),
  /** low camera on the infield from the first-base side */
  infield: (_e, o) => set(o, [-28, 3, 10], [0, 1.2, 20], 32, 1),
  /** close-ups of the batter's, then the pitcher's, face (skin / hair / eye shaders at their most expensive) */
  faces: (e, o) => batterFace(e, o, Math.floor(e.liveState.time / 4) % 2 ? 'pitcher' : 'batter'),
  /** a crowd shot */
  crowd: (e, o) => {
    const c = e.director.landmarks.crowdShots?.[0];
    if (c) set(o, [c.pos.x, c.pos.y, c.pos.z], [c.target.x, c.target.y, c.target.z], 30, 1);
    else set(o, [0, 14, 55], [0, 14, 140], 40, 1);
  },
  /** the dugout / bench */
  dugout: (e, o) => {
    const c = e.director.dugoutShots[0];
    if (c) set(o, [c.pos.x, c.pos.y, c.pos.z], [c.target.x, c.target.y, c.target.z], 34, 1);
    else set(o, [-30, 3, 8], [-18, 1, 0], 34, 1);
  },
  /** the stadium from the outfield: the most geometry in view (stands, towers, scoreboard) */
  stadium: (_e, o) => set(o, [0, 32, 150], [0, 18, -20], 55, 0.4),
};

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const num = (k: string, d: number) => {
  const v = Number(params.get(k));
  return params.has(k) && Number.isFinite(v) ? v : d;
};

export interface BenchState {
  done: boolean;
  progress: string;
  device: Record<string, unknown>;
  results: Record<string, unknown>[];
  /** set by the runner after a screenshot (only with shots=1) */
  release: boolean;
  /** name of the scene currently held for a screenshot */
  holding: string | null;
  error?: string;
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

function deviceFacts(e: Engine): Record<string, unknown> {
  const gl = e.renderer.getContext() as WebGL2RenderingContext;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const caps = e.renderer.capabilities;
  return {
    ua: navigator.userAgent,
    renderer: perf.gpuName,
    gpuTimer: perf.gpuTimer,
    dpr: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    inner: `${innerWidth}x${innerHeight}`,
    cores: navigator.hardwareConcurrency,
    deviceMemoryGB: nav.deviceMemory ?? null,
    maxTextureUnits: caps.maxTextures,
    maxVertexTextures: caps.maxVertexTextures,
    maxTextureSize: caps.maxTextureSize,
    maxSamples: caps.maxSamples,
    maxAnisotropy: caps.getMaxAnisotropy(),
    glVersion: String(gl.getParameter(gl.VERSION)),
    coarse: e.coarse,
  };
}

export async function runBench(e: Engine): Promise<BenchState> {
  const state: BenchState = { done: false, progress: 'starting', device: {}, results: [], release: false, holding: null };
  (window as unknown as { __bench: BenchState }).__bench = state;
  try {
    const names = (params.get('scenes') ?? 'pitchcam,wide,follow,infield,faces,crowd').split(',').filter((n) => SCENES[n]);
    const frames = num('frames', 360);
    const warm = num('warm', 90);
    const shots = params.has('shots');
    // deterministic: fixed step per frame, no adaptive scale, no pause/hold
    e.fixedDt = 1 / 60;
    e.sim.stepBudgetMs = 1e9; // the same game on every build / preset, whatever the frame time
    e.adaptive.enabled = false;
    e.adaptive.scale = num('scale', 1);
    e.resize();
    e.sim.paused = false;
    e.sim.speed = 1;
    e.director.replaysEnabled = false;
    state.device = deviceFacts(e);
    const cam: Cam = { pos: new Vector3(), tgt: new Vector3(), fov: 40, aperture: 1 };
    e.director.bench = cam;
    // let the game get going (batter walks up, first pitch) while the first scene's camera is already in place
    for (let i = 0; i < 120; i++) {
      SCENES[names[0]](e, cam);
      await nextFrame();
    }
    for (const name of names) {
      state.progress = name;
      perf.tags.scene = name;
      perf.tags.preset = e.qualityName;
      perf.tags.tod = e.env.todName;
      const fn = SCENES[name];
      const t0 = e.liveState.time;
      for (let i = 0; i < warm; i++) {
        fn(e, cam);
        await nextFrame();
      }
      perf.reset();
      for (let i = 0; i < frames; i++) {
        fn(e, cam);
        await nextFrame();
      }
      // let the GPU timer queries of the last frames come back
      for (let i = 0; i < 8; i++) await nextFrame();
      const stats = perf.stats(frames);
      const info = e.renderer.info;
      state.results.push({
        scene: name,
        preset: e.qualityName,
        tod: e.env.todName,
        gameTime: [+t0.toFixed(2), +e.liveState.time.toFixed(2)],
        pixelRatio: e.renderer.getPixelRatio(),
        canvas: `${e.renderer.domElement.width}x${e.renderer.domElement.height}`,
        scale: e.adaptive.scale,
        memory: { geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0 },
        textureMemory: perf.textureMemory(e.scene, e.renderer),
        stats,
      });
      if (shots) {
        // the game stands still while the runner takes the picture, so two builds show the same frame: first run on to the next quarter-second of game time
        const target = Math.ceil((e.liveState.time + 0.1) / 0.25) * 0.25;
        for (let i = 0; i < 600 && e.liveState.time < target; i++) {
          fn(e, cam);
          await nextFrame();
        }
        e.sim.paused = true;
        for (let i = 0; i < 5; i++) await nextFrame();
        state.holding = name;
        state.release = false;
        while (!state.release) {
          fn(e, cam);
          await nextFrame();
        }
        state.holding = null;
        e.sim.paused = false;
      }
    }
  } catch (err) {
    state.error = String((err as Error)?.stack ?? err);
    console.error('[bench]', err);
  }
  e.director.bench = null;
  e.fixedDt = undefined;
  state.done = true;
  state.progress = 'done';
  return state;
}

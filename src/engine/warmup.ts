/**
 * Boot-time preparation, so that nothing pops in once the game is shown. The sequence (each step reports progress):
 *   1. assets      glTF files, weighted by byte size (assets.ts)
 *   2. sky         the photographic HDRI for the time of day is applied (not just requested)
 *   3. dressing    one update without drawing, so every player puppet exists
 *   4. textures    every texture of the scene uploaded to the GPU (`initTexture`)
 *   5. shaders     `compileAsync` with every hidden variant (hair, beards, gear, claws ...) shown, so their programs exist
 *   6. warm-up     one frame with frustum culling off (all geometry, texture and shadow-caster uploads), then a few frames of a dummy game
 *                  up to its first pitch through the real broadcast cameras (post-processing passes, ball trail, HUD canvases, sim code paths)
 * The caller keeps the canvas hidden meanwhile and starts the real game with `Engine.newGame` afterwards.
 */
import type { Material, Object3D, Texture } from 'three';
import type { Engine } from './engine';
import type { Assets } from './assets';

export interface PrepareProgress {
  /** 0..1 over the whole preparation */
  frac: number;
  /** what is happening now ("Loading players…") */
  stage: string;
}

export interface PrepareOptions {
  /** load the glTF assets (false: procedural placeholders only, `?noassets`) */
  assets: boolean;
  onProgress?: (p: PrepareProgress) => void;
}

export interface PrepareResult {
  assets: Assets | null;
  /** asset files that failed to load (placeholders are used for them) */
  missing: string[];
  /** wall-clock milliseconds per step */
  ms: Record<string, number>;
}

const yieldUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Every texture a material of the scene refers to. */
function sceneTextures(root: Object3D): Set<Texture> {
  const out = new Set<Texture>();
  root.traverse((o) => {
    const m = (o as { material?: Material | Material[] }).material;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      for (const v of Object.values(mat)) if (v && (v as Texture).isTexture) out.add(v as Texture);
    }
  });
  return out;
}

/** Show the hidden variant nodes (and anything else invisible) of the moving parts; returns the function that hides them again. */
function showVariants(e: Engine): () => void {
  const hidden: Object3D[] = [];
  for (const root of [e.players.group, e.ball.group, e.bat.obj, ...e.ensureLooseProps()]) root.traverse((o) => !o.visible && hidden.push(o));
  for (const o of hidden) o.visible = true;
  // parts the level of detail would skip at this camera are compiled and uploaded too
  const lodWas = e.players.lodEnabled;
  e.players.lodEnabled = false;
  e.camera.layers.enableAll();
  for (const p of e.players.allPuppets()) p.lodReset?.();
  return () => {
    for (const o of hidden) o.visible = false;
    e.players.lodEnabled = lodWas;
    e.camera.layers.set(0);
  };
}

/** Draw one frame from the current camera with frustum culling off, so every mesh, texture and shadow caster is uploaded. */
function drawEverything(e: Engine) {
  const culled: Object3D[] = [];
  e.scene.traverse((o) => {
    if (o.frustumCulled) {
      o.frustumCulled = false;
      culled.push(o);
    }
  });
  try {
    e.camera.updateMatrixWorld();
    e.env.update();
    e.env.resize();
    e.post.render(0, 1 / 60);
  } finally {
    for (const o of culled) o.frustumCulled = true;
  }
}

export async function rewarm(e: Engine): Promise<void> {
  e.tick(1e-4, false); // puppets of a new game exist before they are drawn
  const restore = showVariants(e);
  try {
    await e.renderer.compileAsync(e.scene, e.camera);
    await yieldUi();
    drawEverything(e);
  } finally {
    restore();
  }
  e.adaptive.reset();
}

export async function prepareEngine(e: Engine, o: PrepareOptions): Promise<PrepareResult> {
  const ms: Record<string, number> = {};
  let mark = performance.now();
  const lap = (k: string) => {
    const now = performance.now();
    ms[k] = Math.round(now - mark);
    mark = now;
  };
  const report = (frac: number, stage: string) => o.onProgress?.({ frac, stage });

  report(0, 'Loading stadium…');
  let assets: Assets | null = null;
  let missing: string[] = [];
  if (o.assets) {
    try {
      assets = await e.loadAssets((p) => report(p.frac * 0.6, p.label));
      missing = assets.missing.slice();
    } catch (err) {
      console.warn('[boot] assets failed, using placeholders', err);
      missing = ['all assets'];
    }
  }
  lap('assets');

  report(0.6, 'Painting the sky…');
  await e.env.skyReady;
  lap('sky');

  report(0.68, 'Dressing the players…');
  await yieldUi();
  e.tick(1 / 60, false); // builds every puppet (and swaps nothing visible: the canvas is hidden)
  lap('players');

  report(0.72, 'Uploading textures…');
  const tex = [...sceneTextures(e.scene)];
  for (let i = 0; i < tex.length; i++) {
    e.renderer.initTexture(tex[i]);
    if (i % 6 === 5) {
      report(0.72 + 0.08 * (i / tex.length), 'Uploading textures…');
      await yieldUi();
    }
  }
  lap('textures');

  report(0.8, 'Building shaders…');
  const restore = showVariants(e);
  try {
    await e.renderer.compileAsync(e.scene, e.camera);
    report(0.88, 'Building shaders…');
    await yieldUi();
    drawEverything(e);
  } finally {
    restore();
  }
  lap('shaders');

  report(0.9, 'Warming up…');
  await warmGame(e, (f) => report(0.9 + 0.1 * f, 'Warming up…'));
  e.adaptive.reset();
  lap('warm');
  report(1, 'Ready');
  return { assets, missing, ms };
}

/** Play a dummy game up to and through its first pitch with the broadcast cameras and real rendering. */
async function warmGame(e: Engine, progress: (f: number) => void) {
  const sim = e.sim;
  const wasPaused = sim.paused, wasSpeed = sim.speed, wasAttract = e.attract;
  e.attract = false; // the real broadcast cameras, with depth of field (the attract camera has none, so its pass would stay uncompiled)
  let pitched = false;
  const off = sim.on((te) => te.event.type === 'pitch' && (pitched = true));
  sim.paused = false;
  sim.speed = 8;
  try {
    for (let i = 0; i < 400 && !pitched; i++) {
      sim.advance(0.1);
      if (i % 8 === 7) await yieldUi();
    }
    sim.speed = 1;
    const frames = 40;
    for (let i = 0; i < frames; i++) {
      e.tick(1 / 60);
      progress((i + 1) / frames);
      await yieldUi();
    }
  } finally {
    off();
    sim.paused = wasPaused;
    sim.speed = wasSpeed;
    e.attract = wasAttract;
  }
}

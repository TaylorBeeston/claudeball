/**
 * Loads the Blender/glTF assets (`assets/*.glb`, served at `/assets/`), with graceful fallback:
 * every file is optional. Whatever fails to load is simply left undefined and the engine keeps
 * using its procedural placeholder for it.
 *
 * Decoders: meshopt (bundled), Draco and KTX2/Basis (transcoders copied into `public/libs`).
 * `EXT_mesh_gpu_instancing` (stadium seats) is handled by three's GLTFLoader.
 */
import {
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  RepeatWrapping,
  Texture,
  WebGLRenderer,
  type AnimationClip,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export interface CharacterTemplate {
  scene: Group;
  clips: Map<string, AnimationClip>;
  /** names of the nodes this file shows by default (glTF extras `cb_default`), i.e. its pre-configured look */
  defaults: Set<string>;
  /** true for the full `player_base` file, which holds every optional variant (hair styles, beards, accessories, …) */
  full: boolean;
}

/** The part of `players/player_manifest.json` the engine uses: per-clip event times and the glove-closing keys of the catch clips. */
export interface PlayerManifest {
  clips: Record<string, { frames: number; duration_s: number; loop?: boolean; footSpeed?: number; events_s?: Record<string, number>; glove_closed_keys?: [number, number][] }>;
}

/** Default node sets of the role-specific files, applied on top of the full base file: fielders / pitchers, batters / runners, catchers. */
export interface GearSets {
  field?: Set<string>;
  batter?: Set<string>;
  catcher?: Set<string>;
}

export interface Assets {
  base: string;
  field?: Group;
  stadium?: Group;
  ball?: Object3D;
  bat?: Object3D;
  characters: Map<string, CharacterTemplate>;
  gear: GearSets;
  manifest?: PlayerManifest;
  /** true if the files still use the old +X = first base convention (loaded under a mirrored root) */
  mirrored: boolean;
  missing: string[];
}

/** Aggregate loading progress: `frac` in 0..1 (bytes loaded of the known file sizes), `label` names what is loading now. */
export interface LoadProgress {
  frac: number;
  label: string;
}

const LABELS: [RegExp, string][] = [
  [/^(optimized\/)?stadium/, 'Loading stadium…'],
  [/^(optimized\/)?field/, 'Loading the field…'],
  [/players\//, 'Loading players…'],
  [/^(optimized\/)?(ball|bat)/, 'Loading ball and bat…'],
];

const CHARACTERS = ['player_base', 'player_home', 'player_away', 'player_batter', 'player_catcher', 'player_umpire', 'player_umpire_base'];

export async function loadAssets(renderer: WebGLRenderer, base = `${import.meta.env.BASE_URL}assets/`, onProgress?: (p: LoadProgress) => void): Promise<Assets> {
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}libs/draco/`);
  const ktx2 = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}libs/basis/`).detectSupport(renderer);
  const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const out: Assets = { base, characters: new Map(), gear: {}, mirrored: false, missing: [] };

  // Detect the axis convention the files were exported with (old: +X toward first base).
  try {
    const r = await fetch(base + 'field_layout.json', { cache: 'no-cache' });
    if (r.ok) {
      const layout = await r.json();
      const first: [number, number] | undefined = layout?.bases?.first;
      if (first && first[0] > 0) out.mirrored = true;
    }
  } catch {
    /* no layout: assume current contract */
  }

  // byte sizes of the shipped files (`asset_sizes.json`, written by the Vite plugin): the progress bar weights files by them, because
  // `ProgressEvent.total` is 0 without a Content-Length and wrong for compressed responses
  let sizes: Record<string, number> = {};
  try {
    const r = await fetch(base + 'asset_sizes.json', { cache: 'no-cache' });
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) sizes = await r.json();
  } catch {
    /* no table: equal weights */
  }
  const fileWeight = (path: string) => Math.max(1, sizes[path] ?? 1_000_000);
  const progress = new Map<string, { loaded: number; weight: number }>();
  let label = 'Loading stadium…';
  const report = () => {
    let l = 0, w = 0;
    for (const p of progress.values()) {
      l += Math.min(p.loaded, p.weight);
      w += p.weight;
    }
    onProgress?.({ frac: w ? l / w : 0, label });
  };
  const known = ['field.glb', 'stadium.glb', 'ball.glb', 'bat.glb', ...CHARACTERS.map((c) => `players/${c}.glb`)];
  for (const f of known) progress.set(f, { loaded: 0, weight: fileWeight(`optimized/${f}`) });

  // prefer the meshopt+WebP builds in optimized/, fall back to the raw exports
  const load = async (file: string, need?: string) => {
    const order = [`optimized/${file}`, file];
    for (const path of order) {
      try {
        label = LABELS.find(([re]) => re.test(path))?.[1] ?? label;
        const entry = progress.get(file)!;
        const g = await loader.loadAsync(base + path, (e) => {
          entry.loaded = e.loaded;
          if (path === file) entry.weight = Math.max(entry.weight, e.total || e.loaded);
          report();
        });
        entry.loaded = entry.weight;
        report();
        // players need their Bat_Grip / Ball_Grip attachment empties (optimize.sh keeps them; older builds pruned them)
        if (need && !g.scene.getObjectByName(need)) {
          out.missing.push(`${path} (no ${need}, using raw export)`);
          continue;
        }
        return g;
      } catch {
        /* try next */
      }
    }
    out.missing.push(file);
    return null;
  };

  const [field, stadium, ball, bat, ...chars] = await Promise.all([
    load('field.glb'),
    load('stadium.glb'),
    load('ball.glb'),
    load('bat.glb'),
    ...CHARACTERS.map((c) => load(`players/${c}.glb`, 'Bat_Grip')),
  ]);

  for (const p of progress.values()) p.loaded = p.weight;
  report();
  const wrap = (g: Group | undefined) => {
    if (!g) return undefined;
    if (!out.mirrored) return g;
    const w = new Group();
    w.scale.x = -1; // old files: +X = first base, current contract: −X
    w.add(g);
    return w;
  };
  if (field) out.field = wrap(prepWorld(field.scene, renderer));
  if (stadium) out.stadium = wrap(prepWorld(stadium.scene, renderer));
  if (ball) out.ball = ball.scene;
  if (bat) out.bat = bat.scene;
  chars.forEach((c, i) => {
    if (!c) return;
    const clips = new Map<string, AnimationClip>();
    for (const clip of c.animations) clips.set(clip.name, clip);
    const defaults = new Set<string>();
    c.scene.traverse((o) => {
      if (o.userData?.cb_default === 1 || o.userData?.cb_default === true) defaults.add(o.name);
    });
    out.characters.set(CHARACTERS[i], { scene: c.scene, clips, defaults, full: !!c.scene.getObjectByName('Gear_Hair_Long') });
  });
  try {
    const r = await fetch(base + 'players/player_manifest.json', { cache: 'no-cache' });
    if (r.ok) out.manifest = (await r.json()) as PlayerManifest;
  } catch {
    /* no manifest: glove closing falls back to the clip's catch time */
  }
  out.gear = {
    field: out.characters.get('player_home')?.defaults,
    batter: out.characters.get('player_batter')?.defaults,
    catcher: out.characters.get('player_catcher')?.defaults,
  };
  return out;
}

/** Texture wrapping, filtering and z-fight mitigation for the ground layers. */
function prepWorld(root: Group, renderer: WebGLRenderer): Group {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const seen = new Set<Texture>();
  const decals = /^(Chalk|Dirt|Dirt_Cutouts|WarningTrack|Mound|Grass_Infield|HomePlate|Base_|PitchersRubber)/;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as Material[];
    for (const mat of mats) {
      const sm = mat as MeshStandardMaterial;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
        const t = sm[key] as Texture | null | undefined;
        if (t && !seen.has(t)) {
          seen.add(t);
          t.wrapS = t.wrapT = RepeatWrapping;
          t.anisotropy = aniso;
          t.needsUpdate = true;
        }
      }
      if (decals.test(o.name)) {
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = -1;
        mat.polygonOffsetUnits = -2;
      }
    }
    m.receiveShadow = true;
    m.castShadow = !/^(Grass|Dirt|WarningTrack|Chalk)/.test(o.name);
  });
  return root;
}

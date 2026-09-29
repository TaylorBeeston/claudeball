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
}

export interface Assets {
  base: string;
  field?: Group;
  stadium?: Group;
  ball?: Object3D;
  bat?: Object3D;
  characters: Map<string, CharacterTemplate>;
  /** true if the files still use the old +X = first base convention (loaded under a mirrored root) */
  mirrored: boolean;
  missing: string[];
}

const CHARACTERS = ['player_base', 'player_home', 'player_away', 'player_batter', 'player_catcher', 'player_umpire'];

export async function loadAssets(renderer: WebGLRenderer, base = '/assets/', onProgress?: (msg: string) => void): Promise<Assets> {
  const draco = new DRACOLoader().setDecoderPath('/libs/draco/');
  const ktx2 = new KTX2Loader().setTranscoderPath('/libs/basis/').detectSupport(renderer);
  const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const out: Assets = { base, characters: new Map(), mirrored: false, missing: [] };

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

  // prefer the meshopt+WebP builds in optimized/, fall back to the raw exports
  const load = async (file: string) => {
    // use whichever copy is newer (the raw export may have been re-exported after the optimized build)
    const stamp = async (path: string) => {
      try {
        const r = await fetch(base + path, { method: 'HEAD', cache: 'no-cache' });
        return r.ok ? Date.parse(r.headers.get('last-modified') ?? '') || 1 : 0;
      } catch {
        return 0;
      }
    };
    const [to, tr] = await Promise.all([stamp(`optimized/${file}`), stamp(file)]);
    const order = tr > to ? [file, `optimized/${file}`] : [`optimized/${file}`, file];
    for (const path of order) {
      try {
        onProgress?.(`loading ${path}`);
        return await loader.loadAsync(base + path);
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
    ...CHARACTERS.map((c) => load(`players/${c}.glb`)),
  ]);

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
    out.characters.set(CHARACTERS[i], { scene: c.scene, clips });
  });
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

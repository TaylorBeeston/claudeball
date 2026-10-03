/**
 * The crowd atlas: spectators rendered from the real player model (same faces, skin, hair, morphs and cloth as the players) into one texture,
 * once per game (team colours), so the stands can be drawn as cheap instanced billboards (`crowdImpostors.ts`) that look like people.
 *
 * Layout: `ATLAS.cols x ATLAS.rows` cells; cell (person p, pose k) = column (p % PEOPLE_PER_ROW) * POSES + k ... see `cellOf`. Every cell frames the
 * same window of the person's own space (`WINDOW`, metres, feet at y = 0, facing the viewer), so a billboard of that size anchored at the person's
 * feet shows them at the right size whatever the pose: seated and standing poses simply sit lower or higher in the cell.
 */
import {
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  LinearMipmapLinearFilter,
  LinearFilter,
  OrthographicCamera,
  SRGBColorSpace,
  Scene,
  WebGLRenderTarget,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { mulberry32 } from './playerLook';
import type { PlayerSnap, TeamInfo } from './types';
import type { Look } from './characters';

/** the poses every person is rendered in (clip, time in s): seated, seated with the hands together (clapping), standing with both arms up, standing waving one arm */
export const POSES: { clip: string; t: number; fallback?: string }[] = [
  { clip: 'bench_sit', t: 0.6 },
  { clip: 'ballkid_sit', t: 0.5, fallback: 'bench_sit' },
  { clip: 'bench_cheer', t: 0.2, fallback: 'celebrate' },
  { clip: 'ballkid_wave', t: 0.4, fallback: 'bench_cheer' },
];

/** the window of a person's own space every cell shows (metres): x across, y up from the feet */
export const WINDOW = { x0: -0.55, x1: 0.55, y0: 0.35, y1: 2.55 };

export interface CrowdAtlas {
  texture: Texture;
  /** the render target holding the texture (read back by dev tools) */
  target: WebGLRenderTarget;
  cols: number;
  rows: number;
  people: number;
  poses: number;
  /** cell size as a fraction of the texture */
  cellU: number;
  cellV: number;
  dispose(): void;
}

/** cell (column, row) of person `p` in pose `k`: each person's poses sit side by side in a row */
export function cellOf(p: number, k: number, cols: number, poses: number): [number, number] {
  const perRow = Math.floor(cols / poses);
  return [(p % perRow) * poses + k, Math.floor(p / perRow)];
}

const CASUAL = ['#f2f2ee', '#c9cbcf', '#2a2b2e', '#1f2a44', '#b3262e', '#2f5d3a', '#6fa8d8', '#6b1f2a', '#d8792b', '#e0c341', '#8a8f99', '#ffffff', '#3d4f7a', '#a83a64'];
const PANTS = ['#2f4a6e', '#3a5478', '#24324a', '#c2b28e', '#2a2a2c', '#6e6f73', '#4a3c2e'];
const HAIR = ['Gear_Hair', 'Gear_Hair_Buzz', 'Gear_Hair_Curly', 'Gear_Hair_Long', 'Gear_Hair_SidePart', 'Gear_Hair_SlickBack', 'Gear_Hair_Bob', 'Gear_Hair_Ponytail', 'Gear_Hair_Receding', 'Gear_Hair_Balding'];

interface FanSpec {
  snap: PlayerSnap;
  look: Look;
  cap: boolean;
  hair: string;
  jersey: string;
}

function fans(n: number, teams: { home: TeamInfo; away: TeamInfo }, seed: number): FanSpec[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length) % a.length];
  const out: FanSpec[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    // a home crowd: about half wear the home colours, a few the visitors', the rest whatever they had on
    const shirt = r < 0.3 ? teams.home.color : r < 0.4 ? teams.home.trim : r < 0.58 ? teams.away.color : pick(CASUAL);
    const capColor = rnd() < 0.7 ? (rnd() < 0.8 ? teams.home.color : teams.away.color) : pick(CASUAL);
    const h = 1.55 + rnd() * 0.4;
    const build = pick(['lean', 'athletic', 'stocky', 'heavy', 'athletic', 'stocky'] as const);
    const snap: PlayerSnap = {
      id: `fan-${seed}-${i}`,
      team: 1,
      role: 'bench',
      pos: { x: 0, y: 0, z: 0 },
      facing: 0,
      vel: { x: 0, y: 0, z: 0 },
      anim: 'idle',
      physique: { heightM: h, weightKg: 22 * h * h * (build === 'heavy' ? 1.35 : build === 'stocky' ? 1.18 : build === 'lean' ? 0.92 : 1.02), build },
      appearance: { skin: Math.floor(rnd() * 6), hairColor: Math.floor(rnd() * 6), hairStyle: Math.floor(rnd() * 4), facialHair: rnd() < 0.55 ? 0 : rnd() < 0.5 ? 1 : 2, seed: Math.floor(rnd() * 1e9) },
    };
    out.push({
      snap,
      look: { jersey: shirt, pants: pick(PANTS), cap: capColor, sock: shirt, skin: '' },
      cap: rnd() < 0.42,
      hair: pick(HAIR),
      jersey: rnd() < 0.6 ? 'Jersey_ShortSleeve' : 'Jersey',
    });
  }
  return out;
}

export interface AtlasPuppet {
  root: Object3D;
  setTeam(look: Look, team: number): void;
  poseStill?(clip: string, t: number, o: { cap: boolean; hair?: string; jersey?: string }): boolean;
  dispose(): void;
}

/**
 * Render the atlas. `size` 2048 (desktop) or 1024 (phones / Low). `environment` = the scene's image-based light, so skin and cloth read the same
 * as on the field. Returns null when the puppets cannot pose (no glTF players).
 */
export function buildCrowdAtlas(
  renderer: WebGLRenderer,
  makePuppet: (snap: PlayerSnap) => AtlasPuppet,
  teams: { home: TeamInfo; away: TeamInfo },
  o: { size: number; seed?: number; environment?: Texture | null },
): CrowdAtlas | null {
  const size = o.size;
  const cellPx = size / 16; // 128 px wide cells at 2048
  const cols = 16;
  const aspect = (WINDOW.y1 - WINDOW.y0) / (WINDOW.x1 - WINDOW.x0);
  const rows = Math.floor(size / (cellPx * aspect));
  // dev: `window.__crowdPoses` overrides the pose list (tools/visual/atlas.ts --poses)
  const poseList = ((globalThis as { __crowdPoses?: typeof POSES }).__crowdPoses ?? POSES);
  const poses = poseList.length;
  const people = Math.floor(cols / poses) * rows;
  const cellW = cellPx, cellH = Math.floor(cellPx * aspect);
  const rt = new WebGLRenderTarget(size, size, { samples: 4, colorSpace: SRGBColorSpace, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
  const scene = new Scene();
  scene.environment = o.environment ?? null;
  scene.environmentIntensity = 0.55;
  scene.add(new HemisphereLight(0xe4ecff, 0x6a5a48, 0.9));
  scene.add(new AmbientLight(0xffffff, 0.15));
  const key = new DirectionalLight(0xfff4e6, 2.2);
  key.position.set(-1.2, 2.2, 2.4);
  scene.add(key);
  const rim = new DirectionalLight(0xdfe8ff, 0.7);
  rim.position.set(1.5, 1.2, -2);
  scene.add(rim);
  const cam = new OrthographicCamera(WINDOW.x0, WINDOW.x1, WINDOW.y1, WINDOW.y0, 0.1, 20);
  cam.position.set(0, 0, 6);
  cam.layers.enableAll();

  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevShadow = renderer.shadowMap.enabled;
  renderer.setRenderTarget(rt);
  // transparent, but with a neutral colour so filtered / multisampled edges fade to a mid tone instead of black
  renderer.setClearColor(new Color(0.32, 0.28, 0.25), 0);
  renderer.clear(true, true, true);
  renderer.autoClear = false;
  renderer.shadowMap.enabled = false;
  let ok = false;
  try {
    for (const [i, f] of fans(people, teams, o.seed ?? 7).entries()) {
      const p = makePuppet(f.snap);
      if (!p.poseStill) {
        p.dispose();
        return null;
      }
      p.setTeam(f.look, 1);
      scene.add(p.root);
      for (let k = 0; k < poses; k++) {
        const ps = poseList[k];
        if (!p.poseStill(ps.clip, ps.t, f) && !(ps.fallback && p.poseStill(ps.fallback, ps.t, f))) continue;
        const [cx, cy] = cellOf(i, k, cols, poses);
        // three's viewport origin is the bottom-left corner; rows run top to bottom in the atlas
        rt.viewport.set(cx * cellW, size - (cy + 1) * cellH, cellW, cellH);
        rt.scissor.copy(rt.viewport);
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.clearDepth();
        renderer.render(scene, cam);
        ok = true;
      }
      scene.remove(p.root);
      p.dispose();
    }
  } finally {
    rt.scissorTest = false;
    rt.viewport.set(0, 0, size, size);
    rt.scissor.set(0, 0, size, size);
    // one last (empty) render with mipmaps on: three resolves the multisampled target and builds the mip chain once
    rt.texture.generateMipmaps = true;
    rt.texture.minFilter = LinearMipmapLinearFilter;
    renderer.setRenderTarget(rt);
    renderer.render(new Scene(), cam);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.enabled = prevShadow;
  }
  if (!ok) {
    rt.dispose();
    return null;
  }
  rt.texture.anisotropy = 4;
  return {
    texture: rt.texture,
    target: rt,
    cols,
    rows,
    people,
    poses,
    cellU: cellW / size,
    cellV: cellH / size,
    dispose: () => rt.dispose(),
  };
}

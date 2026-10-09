/**
 * The pitch clocks in the park: two small displays on the backstop either side of home plate (facing the pitcher) and two on the batter's eye in center field
 * (facing the hitter), as in MLB parks since 2023. One shared canvas texture (redrawn only when what it shows changes, polled 4x a second) on four quads merged
 * into one mesh: one draw call, no shadows, kept out of the SSAO / DoF depth prepass (`gbufferHidden`). Placed from the glTF stadium's `BackstopNetting` and
 * `BattersEye` when it is adopted, else by MLB-like coordinates.
 */
import { Box3, BufferGeometry, CanvasTexture, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, SRGBColorSpace, type Object3D } from 'three';
import { clockDisplay, type ClockDisplay } from './pitchClockView';
import type { GameState } from './types';

/** One display: centre, which way it faces (+1: toward +Z, i.e. out toward the pitcher; -1: toward home plate), width (m). */
export interface ClockSpot {
  name: string;
  pos: { x: number; y: number; z: number };
  facing: 1 | -1;
  width: number;
}

/** MLB-like placement without the Blender stadium: backstop ~14 m behind the plate, the batter's eye ~121 m out in center. */
export const DEFAULT_SPOTS: ClockSpot[] = [
  { name: 'PitchClock_Backstop_L', pos: { x: 4.2, y: 1.6, z: -13.6 }, facing: 1, width: 1.3 },
  { name: 'PitchClock_Backstop_R', pos: { x: -4.2, y: 1.6, z: -13.6 }, facing: 1, width: 1.3 },
  { name: 'PitchClock_CF_L', pos: { x: 9, y: 4.5, z: 120.5 }, facing: -1, width: 4 },
  { name: 'PitchClock_CF_R', pos: { x: -9, y: 4.5, z: 120.5 }, facing: -1, width: 4 },
];

/** Spots from the stadium model: on the face of the backstop netting's base and of the batter's eye. */
export function spotsFromStadium(root: Object3D): ClockSpot[] {
  const back = root.getObjectByName('BackstopNetting');
  const eye = root.getObjectByName('BattersEye');
  const spots = DEFAULT_SPOTS.map((s) => ({ ...s, pos: { ...s.pos } }));
  if (back) {
    const b = new Box3().setFromObject(back);
    for (const s of spots.slice(0, 2)) s.pos.z = b.max.z + 0.25;
  }
  if (eye) {
    const b = new Box3().setFromObject(eye);
    const half = (b.max.x - b.min.x) / 2;
    const cx = (b.max.x + b.min.x) / 2;
    spots[2].pos = { x: cx + half * 0.62, y: b.min.y + Math.min(4.5, (b.max.y - b.min.y) * 0.4), z: b.min.z - 0.3 };
    spots[3].pos = { x: cx - half * 0.62, y: spots[2].pos.y, z: b.min.z - 0.3 };
  }
  return spots;
}

/** The quads of all displays in one geometry (aspect 2:1, the texture's). */
export function clockGeometry(spots: ClockSpot[]): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  spots.forEach((s, i) => {
    const w = s.width / 2;
    const h = s.width / 4;
    // seen from the front, a display facing +Z has its right edge at +X, one facing -Z (toward home) at -X; counter-clockwise from the front
    const r = s.facing === 1 ? 1 : -1;
    const c = s.pos;
    pos.push(c.x - w * r, c.y - h, c.z, c.x + w * r, c.y - h, c.z, c.x + w * r, c.y + h, c.z, c.x - w * r, c.y + h, c.z);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

const COLORS: Record<ClockDisplay['level'], string> = { normal: '#f4f6f8', amber: '#ffc23a', red: '#ff3b2f' };

export class ParkClocks {
  readonly group = new Group();
  readonly mesh: Mesh;
  private canvas = document.createElement('canvas');
  private tex: CanvasTexture;
  private key = '';
  private poll = 0;
  private blink = false;

  constructor() {
    this.group.name = 'pitch-clocks';
    this.canvas.width = 256;
    this.canvas.height = 128;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    const mat = new MeshBasicMaterial({ map: this.tex, toneMapped: false });
    this.mesh = new Mesh(clockGeometry(DEFAULT_SPOTS), mat);
    this.mesh.name = 'PitchClocks';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false; // (spread over the whole park: one bounding sphere would always be in view anyway)
    this.group.add(this.mesh);
    this.draw(null);
  }

  /** Move the displays onto the adopted stadium model. */
  place(root: Object3D | null): void {
    const old = this.mesh.geometry;
    this.mesh.geometry = clockGeometry(root ? spotsFromStadium(root) : DEFAULT_SPOTS);
    old.dispose();
  }

  /** Called every frame: looks at the clock 4x a second and redraws the shared texture only when what it shows changed. */
  update(s: GameState, dt: number): void {
    if ((this.poll -= dt) > 0) return;
    this.poll = 0.25;
    const d = clockDisplay(s);
    if (d.flash) this.blink = !this.blink;
    const key = d.key + (d.flash ? (this.blink ? 'a' : 'b') : '');
    if (key === this.key) return;
    this.key = key;
    this.draw(d);
  }

  private draw(d: ClockDisplay | null): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#050608';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#23272e';
    g.lineWidth = 6;
    g.strokeRect(3, 3, W - 6, H - 6);
    if (d && d.visible && !(d.flash && this.blink)) {
      g.fillStyle = d.flash ? COLORS.red : COLORS[d.level];
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `800 ${d.text.length > 2 ? 78 : 100}px "Arial Narrow", Arial, sans-serif`;
      g.fillText(d.text, W / 2, H / 2 + 6);
    }
    this.tex.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.tex.dispose();
  }
}


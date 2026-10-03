import {
  AdditiveBlending,
  Box3,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3,
  CylinderGeometry,
  SphereGeometry,
  CapsuleGeometry,
  Quaternion,
} from 'three';
import { DIM, wallDistance } from './dims';
import type { Environment } from './environment';
import type { GameState } from './types';

type P2 = [number, number];
const SCOREBOARD_FLIP_X = false; // assets fixed the screen UVs after the axis flip

/** Closed outline of the seating bowl's front edge, in SCENE coords (x mirrored). */
function buildOutline(): P2[] {
  const pts: P2[] = [];
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const phi = -Math.PI / 4 + (Math.PI / 2) * (i / N);
    const r = wallDistance(phi);
    pts.push([r * Math.sin(phi), r * Math.cos(phi)]);
  }
  const off = 14.5;
  const pole = wallDistance(Math.PI / 4);
  const s2 = Math.SQRT1_2;
  const right: P2[] = [];
  for (let t = pole; t >= 14; t -= 3) right.push([(t + off) * s2, (t - off) * s2]);
  pts.push(...right);
  for (let a = 0.12; a < Math.PI; a += 0.12) pts.push([14.5 * s2 * 1.36 * Math.cos(a), -23 * Math.sin(a)]);
  for (let t = 14; t <= pole; t += 3) pts.push([-(t + off) * s2, (t - off) * s2]);
  return pts.map(([x, z]) => [-x, z] as P2);
}

function chaikin(pts: P2[], iters: number): P2[] {
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const out: P2[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = out;
  }
  return p;
}

interface PathPt {
  x: number;
  z: number;
  nx: number;
  nz: number;
  s: number; // arc length
  wall: boolean; // outfield wall section
  phi: number;
  lowerScale: number;
  upperScale: number;
}

function resample(poly: P2[], ds: number): PathPt[] {
  const n = poly.length;
  const lens: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    lens.push(lens[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lens[n];
  const count = Math.round(total / ds);
  const out: PathPt[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = (k / count) * total;
    while (lens[seg + 1] < s) seg++;
    const a = poly[seg], b = poly[(seg + 1) % n];
    const t = (s - lens[seg]) / (lens[seg + 1] - lens[seg]);
    out.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, nx: 0, nz: 0, s, wall: false, phi: 0, lowerScale: 1, upperScale: 1 });
  }
  // orientation
  let area = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i], b = out[(i + 1) % out.length];
    area += a.x * b.z - b.x * a.z;
  }
  const sign = area > 0 ? 1 : -1; // ccw -> outward normal = (dz, -dx)
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length], b = out[(i + 1) % out.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    out[i].nx = (sign * dz) / l;
    out[i].nz = (-sign * dx) / l;
    const phi = Math.atan2(-out[i].x, out[i].z); // sim phi
    out[i].phi = phi;
    const r = Math.hypot(out[i].x, out[i].z);
    out[i].wall = out[i].z > 20 && Math.abs(phi) < Math.PI / 4 - 0.01 && Math.abs(r - wallDistance(phi)) < 1.2;
  }
  // stand size profile: big behind home & down the lines, smaller/lower in the outfield
  for (const p of out) {
    const a = Math.abs(p.phi);
    const foulness = p.wall ? 0 : 1;
    const outfield = 1 - foulness;
    const eye = Math.exp(-Math.pow(p.phi / 0.17, 2));
    const cornerBoost = smooth((a - 0.35) / 0.4);
    p.lowerScale = foulness ? 1 : 0.62 + 0.25 * cornerBoost - 0.42 * eye;
    p.upperScale = foulness ? 1 : outfield * (0.05 + 0.55 * cornerBoost) * (1 - eye);
  }
  // smooth scales along the path
  for (let it = 0; it < 6; it++) {
    const ls = out.map((p) => p.lowerScale), us = out.map((p) => p.upperScale);
    for (let i = 0; i < out.length; i++) {
      const a = (i + out.length - 1) % out.length, b = (i + 1) % out.length;
      out[i].lowerScale = (ls[a] + 2 * ls[i] + ls[b]) / 4;
      out[i].upperScale = (us[a] + 2 * us[i] + us[b]) / 4;
    }
  }
  return out;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

// Seating profile constants
const LOWER_ROWS = 22;
const UPPER_ROWS = 16;
const ROW_D = 0.9;
const LOWER_RISE = 0.44;
const UPPER_RISE = 0.66;
const BASE_H = 1.5;

interface Row {
  off: number;
  h: number;
  upper: boolean;
}

function rowsAt(p: PathPt): Row[] {
  const rows: Row[] = [];
  const ls = p.lowerScale;
  const us = p.upperScale;
  for (let k = 0; k < LOWER_ROWS; k++) rows.push({ off: 0.7 + k * ROW_D * ls, h: BASE_H + k * LOWER_RISE * ls, upper: false });
  const lowerTopH = BASE_H + LOWER_ROWS * LOWER_RISE * ls;
  const lowerTopO = 0.7 + LOWER_ROWS * ROW_D * ls;
  for (let k = 0; k < UPPER_ROWS; k++)
    rows.push({ off: lowerTopO + 4.5 * us + k * ROW_D * 0.95 * us + 0.001 * k, h: lowerTopH + 2.2 * us + k * UPPER_RISE * us, upper: true });
  return rows;
}

/** Sweep helper: builds a strip-per-segment mesh along the path. */
function buildStandsGeometry(path: PathPt[]): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const N = path.length;
  const seat = new Color(0x1c4f8f), seatAlt = new Color(0x1a3f73), concrete = new Color(0x8a8d90), dark = new Color(0x3a3d42);
  const seatUpper = new Color(0x2a6a45);
  const push = (p: PathPt, off: number, h: number, c: Color, shade: number) => {
    pos.push(p.x + p.nx * off, h, p.z + p.nz * off);
    col.push(c.r * shade, c.g * shade, c.b * shade);
    return pos.length / 3 - 1;
  };
  const strip = (segs: { o0: number; h0: number; o1: number; h1: number; c: Color }[][]) => {
    // segs[i] is the list of segments for path point i
    const M = segs[0].length;
    for (let j = 0; j < M; j++) {
      const base = pos.length / 3;
      for (let i = 0; i < N; i++) {
        const s = segs[i][j];
        const p = path[i];
        const n = 0.92 + 0.08 * Math.sin(i * 0.9);
        push(p, s.o0, s.h0, s.c, n);
        push(p, s.o1, s.h1, s.c, n);
      }
      for (let i = 0; i < N; i++) {
        const a = base + i * 2, b = base + ((i + 1) % N) * 2;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  };
  const all: { o0: number; h0: number; o1: number; h1: number; c: Color }[][] = [];
  for (let i = 0; i < N; i++) {
    const p = path[i];
    const rows = rowsAt(p);
    const segs: { o0: number; h0: number; o1: number; h1: number; c: Color }[] = [];
    // front concrete face from ground to first row
    segs.push({ o0: 0.0, h0: 0.0, o1: 0.0, h1: BASE_H, c: dark });
    segs.push({ o0: 0.0, h0: BASE_H, o1: rows[0].off, h1: BASE_H, c: concrete });
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      const d = (k < LOWER_ROWS ? ROW_D * p.lowerScale : ROW_D * 0.95 * p.upperScale) + 0.0001;
      const c = r.upper ? seatUpper : k % 2 ? seat : seatAlt;
      segs.push({ o0: r.off, h0: r.h, o1: r.off + d, h1: r.h, c }); // tread
      const nextH = k + 1 < rows.length && !(k === LOWER_ROWS - 1) ? rows[k + 1].h : r.h + (r.upper ? UPPER_RISE * p.upperScale : LOWER_RISE * p.lowerScale);
      segs.push({ o0: r.off + d, h0: r.h, o1: r.off + d, h1: nextH, c: concrete }); // riser
      if (k === LOWER_ROWS - 1) {
        // concourse floor to upper deck
        const u = rows[LOWER_ROWS];
        segs.push({ o0: r.off + d, h0: nextH, o1: u.off, h1: nextH, c: concrete });
        segs.push({ o0: u.off, h0: nextH, o1: u.off, h1: u.h, c: dark });
      }
    }
    const last = rows[rows.length - 1];
    segs.push({ o0: last.off + 0.9, h0: last.h + 0.6, o1: last.off + 0.9, h1: last.h + 3.2 * Math.max(0.2, p.upperScale), c: dark });
    all.push(segs);
  }
  // segments must have equal counts per point — they do by construction
  strip(all);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeWallTexture(): CanvasTexture {
  const W = 4096, H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#11301c';
  g.fillRect(0, 0, W, H);
  // pad seams
  g.fillStyle = 'rgba(0,0,0,0.25)';
  for (let x = 0; x < W; x += 64) g.fillRect(x, 0, 3, H);
  const ads: [string, string, string][] = [
    ['HALCYON', '#0d47a1', '#ffffff'], ['NORTHWIND', '#ffffff', '#c62828'], ['BLUE MERIDIAN', '#1b5e20', '#ffeb3b'],
    ['APEX FUEL', '#e65100', '#ffffff'], ['LUMEN', '#212121', '#80deea'], ['STRATA BANK', '#004d40', '#ffffff'],
    ['OTTER TIRE', '#f9a825', '#212121'], ['VERTEX', '#4a148c', '#ffffff'], ['COASTLINE', '#01579b', '#ffcc80'],
    ['QUILL', '#b71c1c', '#ffffff'], ['MERIDIAN AIR', '#263238', '#ffffff'], ['SUNCREST', '#ff6f00', '#1a237e'],
  ];
  let x = 40;
  let i = 0;
  while (x < W - 120) {
    const [t, bg, fg] = ads[i++ % ads.length];
    const w = 260 + (i % 3) * 70;
    g.fillStyle = bg;
    g.fillRect(x, 74, w, 126);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(x, 74, w, 6);
    g.fillStyle = fg;
    g.font = '800 44px "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(t, x + w / 2, 138);
    x += w + 26;
  }
  // padding highlight & yellow home-run line
  g.fillStyle = '#f6d021';
  g.fillRect(0, 0, W, 16);
  const grad = g.createLinearGradient(0, 16, 0, H);
  grad.addColorStop(0, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = grad;
  g.fillRect(0, 16, W, H - 16);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.15, 'rgba(255,244,225,0.8)');
  gr.addColorStop(0.5, 'rgba(255,235,200,0.18)');
  gr.addColorStop(1, 'rgba(255,230,190,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

export interface Stadium {
  group: Group;
  /** procedural placeholder structure (hidden once glTF stadium is adopted) */
  structure: Group;
  /** swap in the Blender stadium (`stadium.glb`); crowd is regenerated from its instanced seats */
  adoptGltf(root: Group, mirrored?: boolean): void;
  /** objects that must not be drawn into the SSAO/DoF depth pass */
  gbufferHidden: Object3D[];
  /** show / hide every spectator and seat mesh (the GTAO depth/normal prepass skips the crowd: hundreds of draw calls for no visible occlusion) */
  crowdVisible(v: boolean): void;
  crowd: { setDensity(d: number): void; setAnimate(a: boolean): void; setSectors(n: number): void; excite(v: number): void; update(t: number, dt: number): void };
  updateScoreboard(s: GameState): void;
  setLightsOn(on: boolean): void;
  /** where the lamp banks of the light towers are (scene coordinates); replaced when the glTF stadium is adopted */
  towers: Vector3[];
  /** position for a crowd cutaway camera: [camera position, target] */
  crowdShots: { pos: Vector3; target: Vector3 }[];
}

export function buildStadium(env: Environment): Stadium {
  const group = new Group();
  group.name = 'stadium';
  const structure = new Group();
  structure.name = 'stadium-structure';
  group.add(structure);
  const gbufferHidden: Object3D[] = [];
  const raw = buildOutline();
  const path = resample(chaikin(raw, 3), 0.62);

  // --- stands ----------------------------------------------------------------------
  const standMat = env.register(new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.02, side: DoubleSide }));
  const stands = new Mesh(buildStandsGeometry(path), standMat);
  stands.castShadow = true;
  stands.receiveShadow = true;
  stands.frustumCulled = false;
  structure.add(stands);

  // --- outfield wall & foul wall -------------------------------------------------------
  {
    const wallTex = makeWallTexture();
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const N = path.length;
    for (let i = 0; i < N; i++) {
      const p = path[i];
      const H = p.wall ? DIM.wallHeight : 1.5;
      pos.push(p.x, 0, p.z, p.x, H, p.z);
      const u = p.s / 95;
      uv.push(u, 0, u, 1);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2, b = ((i + 1) % N) * 2;
      if (i === N - 1) continue;
      // inward-facing quad (toward field)
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // flip winding if normals face away from the field centre
    const n = g.getAttribute('normal');
    const p0 = path[Math.floor(path.length * 0.02)];
    const toCentre = new Vector3(-p0.x, 0, 30 - p0.z);
    const nn = new Vector3(n.getX(Math.floor(path.length * 0.02) * 2), 0, n.getZ(Math.floor(path.length * 0.02) * 2));
    let mat = new MeshStandardMaterial({ map: wallTex, roughness: 0.65, metalness: 0, side: DoubleSide });
    mat = env.register(mat);
    if (nn.dot(toCentre) < 0) {
      const ix = g.getIndex()!;
      for (let i = 0; i < ix.count; i += 3) {
        const t = ix.getX(i + 1);
        ix.setX(i + 1, ix.getX(i + 2));
        ix.setX(i + 2, t);
      }
      g.computeVertexNormals();
    }
    const wall = new Mesh(g, mat);
    wall.castShadow = true;
    wall.receiveShadow = true;
    wall.frustumCulled = false;
    structure.add(wall);
  }

  // --- batter's eye (dark screen behind center field) --------------------------------------------
  {
    const eye = new Mesh(
      new BoxGeometry(34, 13, 1.2),
      env.register(new MeshStandardMaterial({ color: 0x0b1a12, roughness: 0.95 })),
    );
    const r = wallDistance(0) + 4;
    eye.position.set(0, 6.5 + 1.5, r);
    eye.castShadow = eye.receiveShadow = true;
    structure.add(eye);
    const hedge = new Mesh(new BoxGeometry(34, 1.6, 2.4), env.register(new MeshStandardMaterial({ color: 0x143a1a, roughness: 1 })));
    hedge.position.set(0, 0.8, r - 1.5);
    structure.add(hedge);
  }

  // --- backstop & dugouts ------------------------------------------------------------------------
  {
    const padMat = env.register(new MeshStandardMaterial({ color: 0x0f2a44, roughness: 0.7 }));
    const back = new Mesh(new BoxGeometry(34, 2.6, 0.5), padMat);
    back.position.set(0, 1.3, -20.5);
    back.castShadow = back.receiveShadow = true;
    structure.add(back);
    const concrete = env.register(new MeshStandardMaterial({ color: 0x9a9c9e, roughness: 0.85 }));
    const dark = env.register(new MeshStandardMaterial({ color: 0x0c0d10, roughness: 1 }));
    for (const sgn of [-1, 1]) {
      const dug = new Group();
      const box = new Mesh(new BoxGeometry(17, 1.3, 3.0), concrete);
      box.position.y = 0.65;
      const opening = new Mesh(new BoxGeometry(16.4, 0.95, 0.12), dark);
      opening.position.set(0, 0.62, -1.5);
      const bench = new Mesh(new BoxGeometry(14, 0.45, 0.5), env.register(new MeshStandardMaterial({ color: 0x5b3a1e, roughness: 0.9 })));
      bench.position.set(0, 0.28, -0.6);
      dug.add(box, opening, bench);
      // dugout sits along the foul line, facing the field
      const t = 15;
      const off = 11.5;
      dug.position.set(sgn * (t + off) * Math.SQRT1_2, 0, (t - off) * Math.SQRT1_2);
      dug.rotation.y = sgn * ((3 * Math.PI) / 4);
      dug.children.forEach((c) => (c.castShadow = c.receiveShadow = true));
      structure.add(dug);
    }
  }

  // --- scoreboard --------------------------------------------------------------------------------
  const sbCanvas = document.createElement('canvas');
  sbCanvas.width = 1024;
  sbCanvas.height = 384;
  const sbTex = new CanvasTexture(sbCanvas);
  sbTex.colorSpace = SRGBColorSpace;
  const sbMat = new MeshStandardMaterial({ map: sbTex, emissiveMap: sbTex, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.6, color: 0x111111 });
  const sb = new Mesh(new PlaneGeometry(26, 9.75), env.register(sbMat));
  const sbBack = new Mesh(new BoxGeometry(27, 10.8, 1), env.register(new MeshStandardMaterial({ color: 0x14181d, roughness: 0.6 })));
  {
    const phi = -0.62; // sim angle; scene x is mirrored
    const r = wallDistance(phi) + 2.5;
    sb.position.set(-r * Math.sin(phi), 12, r * Math.cos(phi));
    sb.lookAt(0, 8, 0);
    sbBack.position.copy(sb.position);
    sbBack.quaternion.copy(sb.quaternion);
    sbBack.translateZ(-0.6);
    structure.add(sbBack, sb);
  }
  const updateScoreboard = (s: GameState) => {
    const g = sbCanvas.getContext('2d')!;
    g.fillStyle = '#05080c';
    g.fillRect(0, 0, 1024, 384);
    const grad = g.createLinearGradient(0, 0, 0, 384);
    grad.addColorStop(0, '#0d1c33');
    grad.addColorStop(1, '#050a14');
    g.fillStyle = grad;
    g.fillRect(12, 12, 1000, 360);
    g.textBaseline = 'middle';
    g.font = '700 54px Arial, sans-serif';
    g.fillStyle = '#9fb7d8';
    g.textAlign = 'left';
    g.fillText(s.teams.away.abbr, 60, 90);
    g.fillText(s.teams.home.abbr, 60, 170);
    g.fillStyle = '#ffd24a';
    g.font = '800 84px Arial, sans-serif';
    g.textAlign = 'right';
    g.fillText(String(s.score.away), 420, 90);
    g.fillText(String(s.score.home), 420, 170);
    g.font = '700 46px Arial, sans-serif';
    g.textAlign = 'left';
    g.fillStyle = '#e8eef8';
    g.fillText(`${s.half === 'top' ? '▲' : '▼'} ${s.inning}`, 520, 90);
    g.fillText(`B ${s.count.balls}  S ${s.count.strikes}  O ${s.outs}`, 520, 170);
    g.fillStyle = '#7ac0ff';
    g.font = '600 40px Arial, sans-serif';
    g.fillText(`AT BAT: ${s.batter?.name ?? ''}`.toUpperCase(), 60, 290);
    sbTex.needsUpdate = true;
  };
  updateScoreboard({ score: { away: 0, home: 0 }, inning: 1, half: 'top', outs: 0, count: { balls: 0, strikes: 0 }, batter: null, teams: { away: { abbr: 'AWY' }, home: { abbr: 'HOM' } } } as unknown as GameState);

  // --- light towers -------------------------------------------------------------------------------
  const glow = glowTexture();
  const lampMat = new MeshStandardMaterial({ color: 0x222222, emissive: 0xfff2d8, emissiveIntensity: 0, roughness: 0.4 });
  const glares: Sprite[] = [];
  const towers: Vector3[] = [];
  {
    const poleMat = env.register(new MeshStandardMaterial({ color: 0x6b7076, roughness: 0.5, metalness: 0.6 }));
    const spots: [number, number][] = [];
    for (const f of [0.02, 0.2, 0.36, 0.5, 0.64, 0.8, 0.98]) {
      const p = path[Math.floor(f * path.length) % path.length];
      const off = p.wall ? 28 : 48;
      spots.push([p.x + p.nx * off, p.z + p.nz * off]);
    }
    for (const [x, z] of spots) {
      const tw = new Group();
      const pole = new Mesh(new CylinderGeometry(0.5, 0.9, 46, 8), poleMat);
      pole.position.y = 23;
      pole.castShadow = true;
      const bank = new Group();
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 6; c++) {
          const lamp = new Mesh(new BoxGeometry(1.5, 1.2, 0.5), lampMat);
          lamp.position.set((c - 2.5) * 1.8, (r - 1.5) * 1.5, 0);
          bank.add(lamp);
        }
      bank.position.y = 44;
      const frame = new Mesh(new BoxGeometry(11.5, 7.2, 0.4), poleMat);
      frame.position.z = -0.35;
      bank.add(frame);
      tw.add(pole, bank);
      tw.position.set(x, 0, z);
      towers.push(new Vector3(x, 44, z));
      // face the field
      bank.lookAt(0 - x, 30, 30 - z);
      const sp = new Sprite(new SpriteMaterial({ map: glow, color: 0xfff0d8, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, fog: false }));
      sp.scale.setScalar(26);
      sp.position.y = 44;
      sp.position.z = 1.2;
      tw.add(sp);
      glares.push(sp);
      gbufferHidden.push(sp);
      structure.add(tw);
    }
  }
  const setLightsOn = (on: boolean) => {
    lampMat.emissiveIntensity = on ? 9 : 0.05;
    for (const g of glares) (g.material as SpriteMaterial).opacity = on ? 0.9 : 0;
  };

  // --- crowd -----------------------------------------------------------------------------------------
  const crowd = buildCrowd(env, group);
  crowd.setMatrices(crowdMatrices(path));
  // the asset stadium's seat / spectator instancing is split into azimuth sectors (own bounding spheres, so off-screen stands are culled); more sectors
  // cull better and cost more draw calls, so the quality preset picks the count (`setSectors` re-splits the original instanced meshes)
  const chunkSets: { orig: InstancedMesh; chunks: InstancedMesh[]; crowd: boolean }[] = [];
  let wantSectors = 12;
  const setSectors = (n: number) => {
    crowd.setSectors(n);
    if (n === wantSectors) return;
    wantSectors = n;
    for (const set of chunkSets) {
      if (set.crowd) {
        const dead = new Set<InstancedMesh>(set.chunks);
        const keep = crowd.extra.filter((e) => !dead.has(e.mesh));
        crowd.extra.length = 0;
        crowd.extra.push(...keep);
      }
      for (const c of set.chunks) {
        c.removeFromParent();
        c.dispose();
      }
      set.chunks = chunkInstanced(set.orig, n);
      if (set.crowd) for (const c of set.chunks) crowd.extra.push({ mesh: c, total: c.count });
    }
    crowd.setDensity(crowd.density);
  };

  // crowd cutaway shots: pick a few spots in lower-deck stands looking back across the crowd
  const crowdShots: { pos: Vector3; target: Vector3 }[] = [];
  for (const f of [0.1, 0.3, 0.55, 0.7, 0.85]) {
    const p = path[Math.floor(f * path.length)];
    const rows = rowsAt(p);
    const row = rows[Math.min(6, rows.length - 1)];
    const cam = new Vector3(p.x + p.nx * (row.off - 17), Math.max(row.h - 3 + 2.6, 2.2), p.z + p.nz * (row.off - 17));
    const tgt = new Vector3(p.x + p.nx * (row.off + 8), row.h + 3.2, p.z + p.nz * (row.off + 8));
    crowdShots.push({ pos: cam, target: tgt });
  }

  // --- glTF replacement --------------------------------------------------------------------------
  let gltfLamps: MeshStandardMaterial[] = [];
  let gltfLampBase: number[] = [];
  let lightsState = false;
  const gltfGlares: Sprite[] = [];
  const applyLights = () => {
    setLightsOn(lightsState);
    for (const g of gltfGlares) (g.material as SpriteMaterial).opacity = lightsState ? 0.85 : 0;
    gltfLamps.forEach((m, i) => (m.emissiveIntensity = lightsState ? gltfLampBase[i] : 0.03));
  };
  const adoptGltf = (root: Group, mirrored = false) => {
    structure.visible = false;
    root.name = 'stadium-gltf';
    group.add(root);
    root.updateMatrixWorld(true);
    const seatMats: Matrix4[] = [];
    const wm = new Matrix4(), inst = new Matrix4();
    const up = new Vector3(0, 1, 0), p = new Vector3(), q = new Quaternion(), sc = new Vector3();
    const lampSet = new Set<MeshStandardMaterial>();
    root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]) as MeshStandardMaterial[];
      for (const mt of mats) {
        env.register(mt);
        if (mt.transparent) gbufferHidden.push(m);
        if (o.name.endsWith('_Lamps')) lampSet.add(mt);
        if (o.name === 'Scoreboard_Screen') {
          sbTex.flipY = false; // glTF UV convention
          // the flipped-axis export leaves the screen UVs mirrored horizontally (asset issue, reported)
          if (SCOREBOARD_FLIP_X !== mirrored) {
            sbTex.wrapS = RepeatWrapping;
            sbTex.repeat.x = -1;
            sbTex.offset.x = 1;
          }
          sbTex.needsUpdate = true;
          mt.map = sbTex;
          mt.emissiveMap = sbTex;
          mt.emissive.set(0xffffff);
          mt.emissiveIntensity = 1.4;
          mt.color.set(0x222222);
          mt.needsUpdate = true;
        }
      }
      m.receiveShadow = true;
      // the huge bowl / light towers / signage are not worth three extra shadow-cascade passes
      m.castShadow = !mats.some((x) => x.transparent) && /^(Dugout|Wall_Padding|Scoreboard$)/.test(o.name);
      const im = o as InstancedMesh;
      if (im.isInstancedMesh && o.name.startsWith('Seats_T')) {
        // spectators sit on the seat instances
        const bb = im.geometry.boundingBox ?? (im.geometry.computeBoundingBox(), im.geometry.boundingBox!);
        const fill = o.name === 'Seats_T3' ? 0.7 : 0.88;
        let r = 1234 + o.name.charCodeAt(7);
        const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
        wm.copy(im.matrixWorld);
        for (let i = 0; i < im.count; i++) {
          if (rnd() > fill) continue;
          im.getMatrixAt(i, inst);
          inst.premultiply(wm);
          inst.decompose(p, q, sc);
          // seat template faces +Z; sit slightly behind the front edge
          const fwd = new Vector3(0, 0, 1).transformDirection(inst);
          fwd.y = 0;
          fwd.normalize();
          p.addScaledVector(fwd, -0.05).addScaledVector(up, bb.min.y + 0.03 + (bb.max.y - bb.min.y) * 0.18);
          q.setFromAxisAngle(up, Math.atan2(fwd.x, fwd.z) + (rnd() - 0.5) * 0.5);
          const s = 0.92 + rnd() * 0.2;
          sc.set(s, s * (0.92 + rnd() * 0.16), s);
          seatMats.push(new Matrix4().compose(p.clone(), q.clone(), sc.clone()));
        }
      }
    });
    // (placeholder crowd is filled in below, after we know which seats the asset spectators occupy)
    // split seat + spectator instancing into azimuth sectors so off-screen stands are frustum-culled
    const seatMeshes: InstancedMesh[] = [];
    const crowdMeshes: InstancedMesh[] = [];
    root.traverse((o) => {
      const im = o as InstancedMesh;
      if (!im.isInstancedMesh) return;
      if (o.name.startsWith('Seats_T')) seatMeshes.push(im);
      else if (o.name.startsWith('Crowd_')) crowdMeshes.push(im);
    });
    for (const im of seatMeshes) chunkSets.push({ orig: im, chunks: chunkInstanced(im, wantSectors), crowd: false });
    if (crowdMeshes.length) {
      // the asset pack ships real spectators, but at 35-50% seat fill: keep them and top up empty seats with
      // the lightweight placeholder figures so the stands read as full
      const occ = new Set<string>();
      const cell = (x: number, z: number, y: number) => `${Math.round(x / 0.45)},${Math.round(z / 0.45)},${Math.round(y / 0.6)}`;
      const wp = new Vector3();
      for (const im of crowdMeshes) {
        im.updateWorldMatrix(true, false);
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, wm);
          wp.setFromMatrixPosition(wm.premultiply(im.matrixWorld));
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) occ.add(cell(wp.x + dx * 0.45, wp.z + dz * 0.45, wp.y));
        }
      }
      let rr = 4242;
      const rnd2 = () => ((rr = (rr * 1664525 + 1013904223) >>> 0) / 4294967296);
      crowd.setMatrices(
        seatMats.filter((m) => {
          wp.setFromMatrixPosition(m);
          return !occ.has(cell(wp.x, wp.z, wp.y)) && rnd2() < 0.75;
        }),
      );
      for (const im of crowdMeshes) {
        const mats = (Array.isArray(im.material) ? im.material : [im.material]) as MeshStandardMaterial[];
        for (const m of mats) env.register(m, crowd.patch);
        const cs = chunkInstanced(im, wantSectors);
        chunkSets.push({ orig: im, chunks: cs, crowd: true });
        for (const c of cs) crowd.extra.push({ mesh: c, total: c.count });
      }
      crowd.setDensity(crowd.density);
    }
    // crowd cutaway shots from the real bowl: lower-deck seats, camera 16 m out on the field side
    const cand = seatMats.filter((m) => {
      m.decompose(p, q, sc);
      return p.y > 1 && p.y < 7 && Math.hypot(p.x, p.z - 30) < 95 && p.z > -10;
    });
    if (cand.length > 50) {
      crowdShots.length = 0;
      for (const f of [0.06, 0.25, 0.45, 0.62, 0.8, 0.93]) {
        const m = cand[Math.floor(f * cand.length)];
        m.decompose(p, q, sc);
        const fwd = new Vector3(0, 0, 1).applyQuaternion(q);
        crowdShots.push({ pos: p.clone().addScaledVector(fwd, 18).setY(p.y + 1.6), target: p.clone().setY(p.y + 1.3) });
      }
    }
    // glare sprites on each lamp bank (bloom + lens glare when lit), and the lights' positions
    const gltfTowers: Vector3[] = [];
    root.traverse((o) => {
      if (!(o as Mesh).isMesh || !o.name.endsWith('_Lamps')) return;
      const box = new Box3().setFromObject(o);
      const c = box.getCenter(new Vector3());
      gltfTowers.push(c.clone());
      const sp = new Sprite(new SpriteMaterial({ map: glow, color: 0xfff0d8, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, fog: false }));
      sp.scale.setScalar(Math.max(24, box.getSize(new Vector3()).length() * 3));
      sp.position.copy(c);
      root.add(sp);
      gltfGlares.push(sp);
      gbufferHidden.push(sp);
    });
    if (gltfTowers.length) {
      towers.length = 0;
      towers.push(...gltfTowers);
    }
    gltfLamps = [...lampSet];
    gltfLampBase = gltfLamps.map((m) => m.emissiveIntensity || 1);
    applyLights();
  };

  return {
    group,
    structure,
    gbufferHidden,
    crowd: {
      setDensity: (d) => crowd.setDensity(d),
      setAnimate: (a) => (crowd.uniforms.uAnimate.value = a ? 1 : 0),
      setSectors: (n) => setSectors(n),
      excite: (v) => (crowd.uniforms.uExcite.value = v),
      update: (t, dt) => {
        crowd.uniforms.uTime.value = t;
        crowd.uniforms.uExcite.value = Math.max(crowd.baseExcite, crowd.uniforms.uExcite.value - dt * 0.18);
      },
    },
    crowdVisible: (v: boolean) => {
      crowd.setVisible(v);
      for (const set of chunkSets) for (const c of set.chunks) c.visible = v;
    },
    updateScoreboard,
    setLightsOn: (on: boolean) => {
      lightsState = on;
      applyLights();
    },
    adoptGltf,
    towers,
    crowdShots,
  };
}

/** Replace an InstancedMesh by per-azimuth-sector copies (own bounding spheres) so distant stands are culled. */
function chunkInstanced(im: InstancedMesh, sectors: number): InstancedMesh[] {
  const buckets: Matrix4[][] = Array.from({ length: sectors }, () => []);
  im.updateWorldMatrix(true, false);
  const mw = im.matrixWorld.clone();
  const pp = new Vector3();
  const cols: Color[][] = Array.from({ length: sectors }, () => []);
  const col = new Color();
  for (let i = 0; i < im.count; i++) {
    const m = new Matrix4();
    im.getMatrixAt(i, m);
    pp.setFromMatrixPosition(m.clone().premultiply(mw));
    const k = Math.min(sectors - 1, Math.floor(((Math.atan2(pp.x, pp.z - 30) + Math.PI) / (Math.PI * 2)) * sectors));
    buckets[k].push(m);
    if (im.instanceColor) {
      im.getColorAt(i, col);
      cols[k].push(col.clone());
    }
  }
  im.visible = false;
  const out: InstancedMesh[] = [];
  const parent = im.parent!;
  buckets.forEach((list, k) => {
    if (!list.length) return;
    const c = new InstancedMesh(im.geometry, im.material, list.length);
    list.forEach((m, n) => {
      c.setMatrixAt(n, m);
      if (cols[k].length) c.setColorAt(n, cols[k][n]);
    });
    c.position.copy(im.position);
    c.quaternion.copy(im.quaternion);
    c.scale.copy(im.scale);
    c.receiveShadow = true;
    c.instanceMatrix.needsUpdate = true;
    c.computeBoundingSphere();
    c.boundingSphere!.radius += 1.5;
    parent.add(c);
    out.push(c);
  });
  return out;
}

function crowdMatrices(path: PathPt[]): Matrix4[] {
  const mats: Matrix4[] = [];
  const rnd = (() => {
    let a = 12345;
    return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  })();
  const q = new Quaternion();
  const scale = new Vector3();
  const pos = new Vector3();
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const rows = rowsAt(p);
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      if (p.wall && (p.lowerScale < 0.35 || (r.upper && p.upperScale < 0.2))) continue;
      const depth = (r.upper ? 0.95 * p.upperScale : p.lowerScale) * ROW_D;
      if (depth < 0.25) continue;
      if (rnd() > (r.upper ? 0.68 : 0.86)) continue;
      const jitter = (rnd() - 0.5) * 0.08;
      pos.set(p.x + p.nx * (r.off + depth * 0.55) - p.nz * jitter, r.h + 0.28, p.z + p.nz * (r.off + depth * 0.55) + p.nx * jitter);
      q.setFromAxisAngle(up, Math.atan2(-p.nx, -p.nz) + (rnd() - 0.5) * 0.5);
      const s = 0.9 + rnd() * 0.22;
      scale.set(s, s * (0.92 + rnd() * 0.16), s);
      mats.push(new Matrix4().compose(pos.clone(), q.clone(), scale.clone()));
    }
  }
  return mats;
}

function buildCrowd(env: Environment, group: Group) {
  const rnd = (() => {
    let a = 987654;
    return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  })();
  const shirtPalette = ['#b3202f', '#e9e9e4', '#233f73', '#1a1a1c', '#c8a23a', '#3f6b45', '#7c7f86', '#a85a2c', '#5c3a6a', '#3d6f86', '#e9e9e4', '#233f73', '#b3202f', '#8a8d93'].map((c) => new Color(c));
  const skinPalette = ['#f1c9a5', '#e0ac82', '#c68642', '#8d5524', '#5c3a21', '#ffdbac'].map((c) => new Color(c));
  const uniforms = { uTime: { value: 0 }, uExcite: { value: 0.12 }, uAnimate: { value: 1 } };
  const patch = (s: unknown) => {
    const shader = s as { uniforms: Record<string, unknown>; vertexShader: string };
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime, uExcite, uAnimate;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float h1 = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453);
          float h2 = fract(sin(dot(ip.xz, vec2(39.346, 11.135))) * 24634.6345);
          float sway = sin(uTime * (1.2 + h1 * 1.6) + h1 * 40.0) * 0.012;
          float hop = pow(max(0.0, sin(uTime * (5.0 + h2 * 3.0) + h1 * 30.0)), 2.0) * step(1.0 - uExcite, h2) * 0.22;
          transformed.y += uAnimate * (hop * step(0.0, position.y) + sway * position.y);
          transformed.x += uAnimate * sway * position.y * 2.0;
        }`,
      );
  };
  const bodyGeo = new CapsuleGeometry(0.19, 0.3, 3, 8);
  bodyGeo.scale(1.15, 1, 0.75);
  bodyGeo.translate(0, 0.32, 0);
  const headGeo = new SphereGeometry(0.105, 8, 6);
  headGeo.translate(0, 0.72, 0.02);
  const bodyMat = env.register(new MeshStandardMaterial({ roughness: 0.9 }), patch);
  const headMat = env.register(new MeshStandardMaterial({ roughness: 0.7 }), patch);
  const extraRef: { mesh: InstancedMesh; total: number }[] = [];
  let chunks: { body: InstancedMesh; head: InstancedMesh; total: number }[] = [];
  let density = 1;
  const applyDensity = () => {
    for (const c of chunks) c.body.count = c.head.count = Math.floor(c.total * density);
    for (const e of extraRef) e.mesh.count = Math.max(1, Math.floor(e.total * density));
  };
  let SECTORS = 24;
  let lastMats: Matrix4[] = [];
  const extra = extraRef;
  return {
    uniforms,
    patch,
    extra,
    get density() {
      return density;
    },
    baseExcite: 0.12,
    /** (Re)build the spectators from seat transforms in world space, in azimuth sectors so off-screen stands are culled. */
    setMatrices(mats: Matrix4[]) {
      lastMats = mats;
      for (const c of chunks) {
        group.remove(c.body, c.head);
        c.body.dispose();
        c.head.dispose();
      }
      chunks = [];
      const buckets: Matrix4[][] = Array.from({ length: SECTORS }, () => []);
      const p = new Vector3();
      for (const m of mats) {
        p.setFromMatrixPosition(m);
        const az = Math.atan2(p.x, p.z - 30);
        buckets[Math.min(SECTORS - 1, Math.floor(((az + Math.PI) / (Math.PI * 2)) * SECTORS))].push(m);
      }
      for (const list of buckets) {
        if (!list.length) continue;
        for (let i = list.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [list[i], list[j]] = [list[j], list[i]];
        }
        const body = new InstancedMesh(bodyGeo, bodyMat, list.length);
        const head = new InstancedMesh(headGeo, headMat, list.length);
        list.forEach((m, n) => {
          body.setMatrixAt(n, m);
          head.setMatrixAt(n, m);
          body.setColorAt(n, shirtPalette[Math.floor(rnd() * shirtPalette.length)].clone().multiplyScalar(0.35 + rnd() * 0.35));
          head.setColorAt(n, skinPalette[Math.floor(rnd() * skinPalette.length)]);
        });
        for (const m of [body, head]) {
          m.castShadow = false;
          m.receiveShadow = true;
          m.instanceMatrix.needsUpdate = true;
          m.instanceColor!.needsUpdate = true;
          m.computeBoundingSphere();
          m.boundingSphere!.radius += 1.5; // sway / hop
          group.add(m);
        }
        chunks.push({ body, head, total: list.length });
      }
      applyDensity();
    },
    setDensity(d: number) {
      density = d;
      applyDensity();
    },
    /** how many azimuth sectors the placeholder spectators are split into (fewer = fewer draw calls, coarser culling) */
    setSectors(n: number) {
      if (n === SECTORS) return;
      SECTORS = n;
      if (lastMats.length) this.setMatrices(lastMats);
    },
    get sectors() {
      return SECTORS;
    },
    setVisible(v: boolean) {
      for (const c of chunks) c.body.visible = c.head.visible = v;
    },
  };
}

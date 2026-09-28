import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { DIM, quatToScene, toScene } from './dims';
import type { Environment } from './environment';
import { Puppet, setMaterialRegistrar, type Look, type PuppetEnv, type PuppetLike } from './characters';
import type { GameState, PlayerSnap, TeamInfo } from './types';

function ballTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4efe4';
  g.fillRect(0, 0, 512, 256);
  // leather grain
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = `rgba(120,110,90,${Math.random() * 0.06})`;
    g.fillRect(Math.random() * 512, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = '#b3222a';
  g.lineWidth = 3;
  for (const off of [0, 256]) {
    g.beginPath();
    for (let x = 0; x <= 256; x += 4) {
      const y = 128 + Math.sin((x / 256) * Math.PI * 2) * 70;
      x === 0 ? g.moveTo(x + off, y) : g.lineTo(x + off, y);
    }
    g.stroke();
    // stitches
    for (let x = 0; x <= 256; x += 8) {
      const y = 128 + Math.sin((x / 256) * Math.PI * 2) * 70;
      g.beginPath();
      g.moveTo(x + off - 3, y - 7);
      g.lineTo(x + off + 3, y + 7);
      g.stroke();
      g.beginPath();
      g.moveTo(x + off + 3, y - 7);
      g.lineTo(x + off - 3, y + 7);
      g.stroke();
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class BallView {
  readonly mesh: Mesh;
  readonly streak: Mesh;
  readonly trail: Mesh;
  private trailPts: Vector3[] = [];
  private trailGeo = new BufferGeometry();
  readonly group = new Group();
  readonly worldPos = new Vector3();
  /** hidden from the depth/normal prepass */
  readonly gbufferHidden: Object3D[];
  private trailOn = 0;

  constructor(env: Environment) {
    const m = env.register(new MeshStandardMaterial({ map: ballTexture(), roughness: 0.55, metalness: 0 }));
    this.mesh = new Mesh(new SphereGeometry(DIM.ballRadius, 20, 14), m);
    this.mesh.castShadow = true;
    this.mesh.name = 'ball';
    this.streak = new Mesh(
      new CylinderGeometry(DIM.ballRadius * 0.9, DIM.ballRadius * 0.9, 1, 8, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),
      new MeshBasicMaterial({ color: 0xfff3dc, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false }),
    );
    this.streak.visible = false;
    // broadcast ball tracer: ribbon of the last second of flight
    const N = 90;
    this.trailGeo.setAttribute('position', new BufferAttribute(new Float32Array(N * 2 * 3), 3));
    this.trailGeo.setAttribute('alpha', new BufferAttribute(new Float32Array(N * 2), 1));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    this.trailGeo.setIndex(idx);
    const tm = new MeshBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.85, side: 2, depthWrite: false, blending: AdditiveBlending, vertexColors: false });
    tm.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float alpha; varying float vA;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvA = alpha;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vA;').replace('#include <opaque_fragment>', 'gl_FragColor = vec4(outgoingLight * 2.2, diffuseColor.a * vA);');
    };
    this.trail = new Mesh(this.trailGeo, tm);
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.group.add(this.mesh, this.streak, this.trail);
    this.gbufferHidden = [this.streak, this.trail];
  }

  update(state: GameState, dt: number, camPos: Vector3, showTrail: boolean) {
    const b = state.ball;
    this.mesh.visible = b.visible;
    toScene(b.pos, this.worldPos);
    this.mesh.position.copy(this.worldPos);
    // spin (sim spin is in sim axes; mirror x)
    const w = new Vector3(-b.spin.x, b.spin.y, b.spin.z);
    const wl = w.length();
    if (wl > 1e-3) this.mesh.rotateOnWorldAxis(w.divideScalar(wl), wl * dt);
    const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    // motion streak along velocity (simulated shutter)
    if (b.visible && sp > 12) {
      this.streak.visible = true;
      const v = new Vector3(-b.vel.x, b.vel.y, b.vel.z);
      const len = Math.min(sp * (1 / 90), 1.6);
      this.streak.position.copy(this.worldPos);
      this.streak.scale.set(1, 1, len);
      this.streak.lookAt(this.worldPos.clone().sub(v));
      (this.streak.material as MeshBasicMaterial).opacity = Math.min(0.5, (sp - 12) / 60);
    } else this.streak.visible = false;
    // tracer
    if (showTrail && b.visible && sp > 10) {
      this.trailOn = Math.min(1, this.trailOn + dt * 6);
      this.trailPts.push(this.worldPos.clone());
      if (this.trailPts.length > 90) this.trailPts.shift();
    } else {
      this.trailOn = Math.max(0, this.trailOn - dt * 1.2);
      if (this.trailOn <= 0) this.trailPts.length = 0;
    }
    this.updateTrail(camPos);
  }

  private updateTrail(camPos: Vector3) {
    const pts = this.trailPts;
    this.trail.visible = pts.length > 2 && this.trailOn > 0;
    if (!this.trail.visible) return;
    const pos = this.trailGeo.getAttribute('position') as BufferAttribute;
    const al = this.trailGeo.getAttribute('alpha') as BufferAttribute;
    const n = pts.length;
    const side = new Vector3(), dir = new Vector3(), toCam = new Vector3();
    for (let i = 0; i < 90; i++) {
      const p = pts[Math.min(i, n - 1)];
      const nx = pts[Math.min(i + 1, n - 1)], pv = pts[Math.min(Math.max(i - 1, 0), n - 1)];
      dir.copy(nx).sub(pv).normalize();
      toCam.copy(camPos).sub(p);
      const dist = toCam.length();
      side.crossVectors(dir, toCam.normalize()).normalize();
      const width = 0.03 + dist * 0.0014;
      pos.setXYZ(i * 2, p.x + side.x * width, p.y + side.y * width, p.z + side.z * width);
      pos.setXYZ(i * 2 + 1, p.x - side.x * width, p.y - side.y * width, p.z - side.z * width);
      const a = i < n ? Math.pow(i / Math.max(1, n - 1), 1.5) : 0;
      al.setX(i * 2, a * this.trailOn);
      al.setX(i * 2 + 1, a * this.trailOn);
    }
    pos.needsUpdate = true;
    al.needsUpdate = true;
  }
}

export class BatView {
  readonly mesh: Mesh;
  readonly grip = { top: new Vector3(), bottom: new Vector3() };
  visible = false;
  private q = new Quaternion();

  constructor(env: Environment) {
    // knob at origin, barrel along +Y (0.86 m)
    const g = new CylinderGeometry(0.033, 0.0095, 0.86, 14, 1);
    g.translate(0, 0.43, 0);
    const pos = g.getAttribute('position');
    // taper the barrel: fat end at the top third, thin handle
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = y / 0.86;
      const r = 0.0095 + Math.pow(Math.min(1, Math.max(0, (t - 0.25) / 0.6)), 0.7) * 0.0245;
      const rr = Math.hypot(pos.getX(i), pos.getZ(i)) || 1;
      const sc = (t > 0.95 ? 0.033 * (1 - (t - 0.95) * 5) + 0.0 : r) / rr;
      pos.setX(i, pos.getX(i) * sc);
      pos.setZ(i, pos.getZ(i) * sc);
    }
    g.computeVertexNormals();
    this.mesh = new Mesh(g, env.register(new MeshStandardMaterial({ color: 0xc89a5c, roughness: 0.45 })));
    this.mesh.castShadow = true;
    this.mesh.visible = false;
  }

  update(state: GameState) {
    const b = state.bat;
    this.visible = b.visible;
    this.mesh.visible = b.visible;
    if (!b.visible) return;
    toScene(b.pos, this.mesh.position);
    quatToScene(b.quat, this.q);
    this.mesh.quaternion.copy(this.q);
    this.grip.bottom.set(0, 0.12, 0).applyQuaternion(this.q).add(this.mesh.position);
    this.grip.top.set(0, 0.26, 0).applyQuaternion(this.q).add(this.mesh.position);
  }
}

const PANTS = { home: '#f2f1ea', away: '#aeb3ba' };

function looksFor(team: TeamInfo, home: boolean): Look {
  return { jersey: team.color, pants: home ? PANTS.home : PANTS.away, cap: team.trim.toLowerCase() === '#f4f4f0' ? team.color : team.trim, sock: team.trim, skin: '' };
}

export class PlayerManager {
  readonly group = new Group();
  private puppets = new Map<string, PuppetLike>();
  private used = new Set<string>();
  private penv: PuppetEnv = { ball: null, batGrip: null, time: 0 };
  /** override factory to swap in glTF characters */
  makePuppet: (snap: PlayerSnap) => PuppetLike = (s) => new Puppet(s.id);
  readonly positions = new Map<string, Vector3>();

  constructor(env: Environment) {
    this.group.name = 'players';
    setMaterialRegistrar((m) => env.register(m as MeshStandardMaterial));
  }

  update(state: GameState, dt: number, ball: Vector3, bat: BatView) {
    this.penv.ball = state.ball.visible ? ball : null;
    this.penv.batGrip = bat.visible ? bat.grip : null;
    this.penv.time = state.time;
    this.used.clear();
    for (const snap of state.players) {
      this.used.add(snap.id);
      let p = this.puppets.get(snap.id);
      if (!p) {
        p = this.makePuppet(snap);
        this.puppets.set(snap.id, p);
        this.group.add(p.root);
      }
      const teamKey = snap.team;
      if (p.team !== teamKey) {
        const info = snap.team === 0 ? state.teams.away : snap.team === 1 ? state.teams.home : ({ color: '#1b1e24', trim: '#1b1e24' } as TeamInfo);
        p.setTeam(looksFor(info, snap.team === 1), teamKey);
        if (snap.team !== -1) {
          // skin tone from id hash, applied by the puppet's initial material; look.skin unused for procedural
        }
      }
      p.update(snap, dt, this.penv);
      let pos = this.positions.get(snap.id);
      if (!pos) this.positions.set(snap.id, (pos = new Vector3()));
      toScene(snap.pos, pos);
    }
    for (const [id, p] of this.puppets) {
      if (!this.used.has(id)) {
        p.dispose();
        this.puppets.delete(id);
        this.positions.delete(id);
      }
    }
  }
}

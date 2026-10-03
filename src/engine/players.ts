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
  TorusGeometry,
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
  /** parent of the visible ball (procedural sphere or the glTF ball); carries position and spin */
  readonly spin = new Group();
  readonly streak: Mesh;
  readonly trail: Mesh;
  private trailPts: Vector3[] = [];
  private trailGeo = new BufferGeometry();
  readonly group = new Group();
  readonly worldPos = new Vector3();
  /** hidden from the depth/normal prepass */
  readonly gbufferHidden: Object3D[];
  private trailOn = 0;
  private model: Object3D | null = null;
  private env: Environment;
  /** true while a player carries the ball in glove / hand: the world ball stays hidden */
  heldByPlayer = false;
  /** offset that fades out after a release, so the ball does not pop from the hand to the sim's release point */
  private pop = new Vector3();
  private popT = 0;

  constructor(env: Environment) {
    this.env = env;
    const m = env.register(new MeshStandardMaterial({ map: ballTexture(), roughness: 0.55, metalness: 0 }));
    this.mesh = new Mesh(new SphereGeometry(DIM.ballRadius, 20, 14), m);
    this.mesh.castShadow = true;
    this.mesh.name = 'ball';
    this.streak = new Mesh(
      new CylinderGeometry(DIM.ballRadius * 0.55, DIM.ballRadius * 0.3, 1, 8, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),
      new MeshBasicMaterial({ color: 0xfff3dc, transparent: true, opacity: 0.22, blending: AdditiveBlending, depthWrite: false }),
    );
    this.streak.visible = false;
    // broadcast ball tracer: ribbon of the last second of flight
    const N = 90;
    this.trailGeo.setAttribute('position', new BufferAttribute(new Float32Array(N * 2 * 3), 3));
    this.trailGeo.setAttribute('alpha', new BufferAttribute(new Float32Array(N * 2), 1));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    this.trailGeo.setIndex(idx);
    const tm = new MeshBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.55, side: 2, depthWrite: false, blending: AdditiveBlending, vertexColors: false });
    tm.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float alpha; varying float vA;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvA = alpha;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vA;').replace('#include <opaque_fragment>', 'gl_FragColor = vec4(outgoingLight * 1.7, diffuseColor.a * vA);');
    };
    this.trail = new Mesh(this.trailGeo, tm);
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.spin.add(this.mesh);
    this.group.add(this.spin, this.streak, this.trail);
    this.gbufferHidden = [this.streak, this.trail];
  }

  /** Use the Blender ball (`ball.glb`, origin at centre, real size). */
  useModel(model: Object3D, env: Environment) {
    this.model = model;
    this.mesh.visible = false;
    this.model = model;
    const m = model.clone(true);
    m.traverse((o) => {
      const mm = o as Mesh;
      if (mm.isMesh) {
        for (const mt of Array.isArray(mm.material) ? mm.material : [mm.material]) env.register(mt as MeshStandardMaterial);
        mm.castShadow = true;
      }
    });
    this.spin.add(m);
  }

  /** A ball for a hand or glove: a clone of the ball model (or the procedural ball), real size. */
  makeHandBall(): Object3D {
    if (this.model) {
      const m = this.model.clone(true);
      m.traverse((o) => {
        const mm = o as Mesh;
        if (mm.isMesh) mm.castShadow = true;
      });
      return m;
    }
    const m = new Mesh(this.mesh.geometry, this.mesh.material);
    m.castShadow = true;
    return m;
  }

  /** The ball has just left a hand at `handPos`: fade the difference to the sim's release point out over ~50 ms. */
  released(handPos: Vector3, simPos: Vector3) {
    this.pop.copy(handPos).sub(simPos);
    this.popT = 0.05;
  }

  update(state: GameState, dt: number, camPos: Vector3, showTrail: boolean) {
    const b = state.ball;
    this.spin.visible = b.visible && !this.heldByPlayer;
    toScene(b.pos, this.worldPos);
    if (this.popT > 0) {
      this.popT = Math.max(0, this.popT - dt);
      this.worldPos.addScaledVector(this.pop, this.popT / 0.05);
    }
    this.spin.position.copy(this.worldPos);
    // spin (sim spin is in sim axes; mirror x)
    const w = new Vector3(b.spin.x, b.spin.y, b.spin.z);
    const wl = w.length();
    if (wl > 1e-3) this.spin.rotateOnWorldAxis(w.divideScalar(wl), wl * dt);
    const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    // motion streak along velocity (simulated shutter)
    if (b.visible && !this.heldByPlayer && sp > 12) {
      this.streak.visible = true;
      const v = new Vector3(b.vel.x, b.vel.y, b.vel.z);
      const len = Math.min(sp * (1 / 90), 1.6);
      this.streak.position.copy(this.worldPos);
      this.streak.scale.set(1, 1, len);
      this.streak.lookAt(this.worldPos.clone().sub(v));
      (this.streak.material as MeshBasicMaterial).opacity = Math.min(0.3, (sp - 12) / 90);
    } else this.streak.visible = false;
    // tracer
    if (showTrail && b.visible && !this.heldByPlayer && sp > 10) {
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
      // about half the old width, tapering to a hairline at the tail; grows with distance so it stays readable on the far cameras
      const f = i / Math.max(1, n - 1);
      const width = (0.014 + dist * 0.0007) * (0.2 + 0.8 * Math.pow(f, 0.8));
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
  readonly obj = new Group();
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
    this.obj.add(this.mesh);
    this.obj.visible = false;
  }

  /** Use the Blender bat (`bat.glb`: knob at origin, barrel along +Y). */
  useModel(model: Object3D, env: Environment) {
    this.mesh.visible = false;
    const m = model.clone(true);
    m.traverse((o) => {
      const mm = o as Mesh;
      if (mm.isMesh) {
        for (const mt of Array.isArray(mm.material) ? mm.material : [mm.material]) env.register(mt as MeshStandardMaterial);
        mm.castShadow = true;
      }
    });
    this.obj.add(m);
  }

  private donut: Object3D | null = null;
  private model: Object3D | null = null;

  /** the weighted donut (`bat_donut.glb`): in the bat's frame, so it is added to a bat's group with an identity transform */
  useDonut(d: Object3D | null) {
    this.donut = d;
  }

  /** A practice bat with its donut for the on-deck batter's hand (knob at the origin, barrel along +Y): the bat model (or the procedural bat) and the donut. */
  makeHandBat(withDonut = true): Object3D {
    const g = new Group();
    g.name = 'OnDeck_Bat';
    const src = this.model ?? null;
    const m = src ? src.clone(true) : new Mesh(this.mesh.geometry, this.mesh.material);
    m.traverse((o) => {
      if ((o as Mesh).isMesh) (o as Mesh).castShadow = true;
    });
    g.add(m);
    if (!withDonut) return g;
    if (this.donut) g.add(this.donut.clone(true));
    else {
      const ring = new Mesh(new TorusGeometry(0.056, 0.02, 8, 18).rotateX(Math.PI / 2), new MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 }));
      ring.position.y = 0.5;
      g.add(ring);
    }
    return g;
  }

  /** Attach to a hand grip (bat held in stance) or release back to the scene. */
  hold(grip: Object3D | null, scene: Object3D) {
    const target = grip ?? scene;
    if (this.obj.parent !== target) {
      target.add(this.obj);
      if (grip) {
        this.obj.position.set(0, 0, 0);
        this.obj.quaternion.identity();
        this.obj.scale.set(1, 1, 1);
      }
    }
    this.held = !!grip;
  }
  held = false;

  /**
   * `from`/`t`: while a swing starts, the bat is blended from where the hands hold it (t = 0) to the sim's pose (t = 1) so it
   * does not pop out of the hands; the sim's early swing arc is far from the batter's stance and the ball is nowhere near yet.
   */
  update(state: GameState, from?: { pos: Vector3; quat: Quaternion }, t = 1) {
    const b = state.bat;
    if (this.held) {
      this.visible = false; // no sim pose: hands keep their clip pose
      this.obj.visible = true;
      return;
    }
    this.visible = b.visible;
    this.obj.visible = b.visible;
    if (!b.visible) return;
    toScene(b.pos, this.obj.position);
    quatToScene(b.quat, this.q);
    if (from && t < 1) {
      const k = t * t * (3 - 2 * t);
      this.obj.position.lerpVectors(from.pos, this.obj.position, k);
      this.q.copy(from.quat).slerp(this.q, k);
    }
    this.obj.quaternion.copy(this.q);
    this.grip.bottom.set(0, 0.12, 0).applyQuaternion(this.q).add(this.obj.position);
    this.grip.top.set(0, 0.26, 0).applyQuaternion(this.q).add(this.obj.position);
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
  private penv: PuppetEnv = { ball: null, batGrip: null, time: 0, ballSpeed: 0, mound: new Vector3(0, 1.5, DIM.moundDist) };
  /** makes the on-deck batter's bat with donut (set by the engine) */
  makeBat?: () => Object3D;
  /** override factory to swap in glTF characters */
  makePuppet: (snap: PlayerSnap) => PuppetLike = (s) => new Puppet(s.id);
  readonly positions = new Map<string, Vector3>();
  /** latest tag per fielder (from the sim's tag events), for a short while */
  private tags = new Map<string, { result: 'tag' | 'avoided' | 'attempt'; until: number; runner: string | null }>();
  readonly anims = new Map<string, string>();
  noteTag(fielderId: string, result: 'tag' | 'avoided' | 'attempt', simTime: number, runnerId?: string) {
    const prev = this.tags.get(fielderId);
    this.tags.set(fielderId, { result, until: simTime + 1.6, runner: runnerId ?? prev?.runner ?? null });
  }

  constructor(env: Environment) {
    this.group.name = 'players';
    // glTF puppets update their own matrices (see `GltfPuppet.update`); the group itself never moves
    this.group.matrixAutoUpdate = false;
    setMaterialRegistrar((m) => env.register(m as MeshStandardMaterial));
  }

  /** puppet level of detail (see `GltfPuppet.updateLod`): set by the engine from the camera's field of view and the quality preset */
  lodK = 1;
  lodCut: readonly [number, number] = [0.2, 0.08];
  /** false while the warm-up draws every variant at full detail */
  lodEnabled = true;
  /** the camera's frustum (set by the engine each frame) */
  frustum: { intersectsSphere(s: import('three').Sphere): boolean } | null = null;
  /** `?nolod` */
  lodOff = false;

  /** Bat grip empty of the current batter's glTF puppet, if any. */
  batterGrip(state: GameState): Object3D | null {
    const b = state.players.find((p) => p.role === 'batter');
    return (b && this.puppets.get(b.id)?.batGrip) || null;
  }

  /** every standing person's feet (scene position, ground height in y), for the contact shadows; runners sliding or players seated on a bench still get one */
  *feet(): Generator<{ x: number; y: number; z: number; r: number }> {
    for (const [id, pos] of this.positions) {
      const pu = this.puppets.get(id);
      if (!pu || !pu.root.visible) continue;
      yield { x: pos.x, y: pos.y, z: pos.z, r: 0.5 };
    }
  }

  /** Centre of a player's face in scene space (glTF puppets), else null. */
  faceOf(id: string, out: Vector3): Vector3 | null {
    return this.puppets.get(id)?.faceCenter?.(out) ?? null;
  }

  /** Midpoint of the current batter's shoulders (scene space), or null for puppets without a skeleton. */
  batterShoulder(state: GameState, out: Vector3): Vector3 | null {
    const b = state.players.find((p) => p.role === 'batter');
    return (b && this.puppets.get(b.id)?.shoulderCenter?.(out)) || null;
  }

  /** switch every puppet between its normal parts and the shadow / depth proxy (see `GltfPuppet.phase`) */
  phase(p: 'main' | 'shadow' | 'gbuf') {
    for (const pu of this.puppets.values()) pu.phase?.(p);
  }

  allPuppets(): IterableIterator<PuppetLike> {
    return this.puppets.values();
  }

  /** Drop all puppets (they are recreated with the current factory on the next update). */
  reset() {
    for (const p of this.puppets.values()) p.dispose();
    this.puppets.clear();
  }

  /** true while some puppet carries the ball (pitcher before release, a fielder mid-transfer) */
  ballHeld = false;
  readonly heldPos = new Vector3();
  private heldTmp = new Vector3();

  update(state: GameState, dt: number, ball: Vector3, bat: BatView, makeBall?: () => Object3D, cameraPos?: Vector3) {
    this.penv.makeBall = makeBall;
    this.penv.cameraPos = cameraPos;
    this.penv.makeBat = this.makeBat;
    this.penv.lodK = this.lodEnabled && !this.lodOff ? this.lodK : undefined;
    this.penv.lodCut = this.lodCut;
    this.penv.frustum = this.frustum ?? undefined;
    this.penv.positions = this.positions;
    this.penv.anims = this.anims;
    this.penv.tagRunner = (id) => this.tags.get(id)?.runner ?? null;
    this.penv.tagOutcome = (id) => {
      const t = this.tags.get(id);
      return t && t.until > state.time ? t.result : null;
    };
    this.ballHeld = false;
    this.penv.ball = state.ball.visible ? ball : null;
    this.penv.batGrip = bat.visible ? bat.grip : null;
    this.penv.time = state.time;
    (this.penv.ballVel ??= new Vector3()).set(state.ball.vel.x, state.ball.vel.y, state.ball.vel.z);
    this.penv.ballSpeed = state.ball.visible ? Math.hypot(state.ball.vel.x, state.ball.vel.y, state.ball.vel.z) : 0;
    // the catcher counts as the carrier from the moment his mitt closes on the pitch (the sim hands him the ball a frame or two later)
    const holder =
      state.players.find((q) => q.hasBall && q.role !== 'batter' && q.role !== 'runner' && q.role !== 'umpire') ?? state.players.find((q) => q.role === 'catcher' && q.anim === 'catch_pitch');
    if (holder) {
      const c = (this.penv.carrier ??= { id: '', role: '', anim: '', pos: new Vector3() });
      c.id = holder.id;
      c.role = holder.role;
      c.anim = holder.anim;
      c.pos.set(holder.pos.x, holder.pos.y, holder.pos.z);
    } else this.penv.carrier = null;
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
      this.anims.set(snap.id, snap.anim);
      p.update(snap, dt, this.penv);
      if (p.ballHeld && !this.ballHeld) {
        const w = p.heldBallWorld?.(this.heldTmp);
        if (w) {
          this.ballHeld = true;
          this.heldPos.copy(w);
        }
      }
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

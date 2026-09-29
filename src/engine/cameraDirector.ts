/**
 * Broadcast camera director. Decisions come only from sim events and state:
 *  pitch  – classic center-field camera, telephoto, shallow depth of field
 *  follow – high-home camera panning with the ball in flight, zooming out to keep it framed
 *  fielder– telephoto on whoever fields / catches the ball
 *  base   – low camera near the base a throw is heading to
 *  replay – last play from a second angle in slow motion (from recorded sim history)
 *  cutaway– crowd / dugout / wide stadium shots between half-innings
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BASES, toScene } from './dims';
import { interpolateState, type SimDriver, type TimedEvent } from './simAdapter';
import type { GameState } from './types';
import type { Stadium } from './stadium';

export type ShotName = 'pitch' | 'follow' | 'fielder' | 'base' | 'replay' | 'cutaway' | 'wide';

interface Desired {
  pos: Vector3;
  tgt: Vector3;
  fov: number;
  focus: number;
  aperture: number;
  lp: number; // position follow rate
  lt: number; // target follow rate
  lf: number; // fov follow rate
}

const HOME_HIGH = new Vector3(0, 17, -26);
const CF_CAM = new Vector3(-2.6, 10.5, 121);

export interface DirectorOutput {
  renderState: GameState;
  focus: number;
  aperture: number;
  label: string | null;
  shot: ShotName;
  /** true on the frame a hard cut happened */
  cut: boolean;
  replaying: boolean;
}

export class CameraDirector {
  auto = true;
  replaysEnabled = true;
  shot: ShotName = 'wide';
  private shotStart = 0;
  private clock = 0;
  private pos = new Vector3(0, 30, -50);
  private tgt = new Vector3(0, 2, 40);
  private fov = 35;
  private des: Desired;
  private ballSm = new Vector3();
  private focusTarget = new Vector3();
  private fielderId: string | null = null;
  private baseTarget = new Vector3();
  private orbit: OrbitControls;
  private inPlay = false;
  private playStart = 0;
  private playEnd = 0;
  private holdUntil = 0;
  private pendingReplay = false;
  private ballFar = 0;
  private cutawayIdx = 0;
  private cutawayUntil = 0;
  private cutaway: 'crowd' | 'wide' | 'dugout' = 'wide';
  private replay: { frames: GameState[]; t: number; end: number; variant: 'infield' | 'outfield'; until: number } | null = null;
  private lastEventText = '';
  private lastCutFrame = false;
  private events: TimedEvent[] = [];
  private shotSeq = 0;
  private lastWindup = -99;

  constructor(
    private camera: PerspectiveCamera,
    private sim: SimDriver,
    dom: HTMLElement,
    private stadium: Stadium,
  ) {
    this.des = { pos: this.pos.clone(), tgt: this.tgt.clone(), fov: 35, focus: 60, aperture: 0, lp: 3, lt: 3, lf: 3 };
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enabled = false;
    this.orbit.target.set(0, 2, 30);
    this.orbit.maxDistance = 400;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    sim.on((e) => this.events.push(e));
  }

  setAuto(auto: boolean) {
    this.auto = auto;
    this.orbit.enabled = !auto;
    if (!auto) {
      // free orbit starts from a clear vantage point above the first-base side of the infield
      this.orbit.target.set(0, 1, 32);
      this.camera.position.set(-38, 34, 4);
      this.camera.fov = 45;
      this.camera.near = 0.5;
      this.camera.far = 900;
      this.camera.updateProjectionMatrix();
      this.orbit.update();
    } else this.cut('pitch');
  }

  private cut(s: ShotName) {
    this.shot = s;
    this.shotStart = this.clock;
    this.lastCutFrame = true;
    this.shotSeq++;
  }

  private handleEvent(te: TimedEvent, live: GameState) {
    const e = te.event;
    if (this.sim.skipping) return;
    switch (e.type) {
      case 'pitch':
        this.replay = null;
        this.inPlay = false;
        this.pendingReplay = false;
        this.cut('pitch');
        break;
      case 'contact':
        this.inPlay = true;
        this.playStart = te.simTime;
        this.ballFar = 0;
        this.fielderId = null;
        this.cut('follow');
        this.holdUntil = 0;
        break;
      case 'catch':
        if (this.inPlay) {
          const p = live.players.find((q) => q.id === e.playerId);
          if (this.shot === 'base' || (this.shot === 'fielder' && this.clock - this.shotStart < 0.7)) break;
          // catch at a base after a throw => base shot; otherwise fielder shot
          this.fielderId = e.playerId;
          if (p && this.thrown) {
            this.cut('base');
            this.holdUntil = this.clock + 2.4;
          } else {
            this.cut('fielder');
            this.holdUntil = this.clock + 1.5;
          }
        }
        break;
      case 'throw': {
        this.thrown = true;
        const t = toScene(e.target);
        this.baseTarget.copy(t);
        this.cut('base');
        this.holdUntil = this.clock + 3.2;
        break;
      }
      case 'foul':
        this.holdUntil = this.clock + 1.6;
        break;
      case 'out':
      case 'run':
        this.holdUntil = Math.max(this.holdUntil, this.clock + 2.2);
        this.playEnd = te.simTime;
        if (this.inPlay) this.pendingReplay = true;
        break;
      case 'half_inning':
        this.cutawayIdx = (this.cutawayIdx + 1) % 2;
        this.cutaway = (['crowd', 'wide'] as const)[this.cutawayIdx];
        this.cutawayUntil = this.clock + 5.5;
        this.cut('cutaway');
        this.inPlay = false;
        break;
      case 'game_end':
        this.cut('wide');
        this.holdUntil = this.clock + 999;
        break;
    }
  }
  private thrown = false;

  update(dt: number, live: GameState, ball: Vector3, players: Map<string, Vector3>): DirectorOutput {
    this.clock += dt;
    this.lastCutFrame = false;
    for (const te of this.events.splice(0)) {
      if (te.event.type === 'contact') this.thrown = false;
      this.handleEvent(te, live);
    }
    // windup marks the start of the next pitch: leave hold / cutaway states
    const pit = live.players.find((p) => p.role === 'pitcher');
    if (pit?.anim === 'windup' && live.time - this.lastWindup > 2) {
      this.lastWindup = live.time;
      if (this.shot !== 'pitch' && this.shot !== 'replay' && this.shot !== 'wide') {
        this.inPlay = false;
        this.cut('pitch');
      }
    }
    if (pit?.anim !== 'windup' && pit?.anim !== 'pitch') this.lastWindup = Math.min(this.lastWindup, live.time - 3);

    let rs = live;
    let label: string | null = null;
    if (!this.auto) {
      this.orbit.update();
      this.tgt.copy(this.orbit.target);
      this.pos.copy(this.camera.position);
      return { renderState: live, focus: this.pos.distanceTo(this.tgt), aperture: 0, label: null, shot: this.shot, cut: false, replaying: false };
    }

    // ---- transitions driven by state -----------------------------------------------------
    if (this.inPlay) {
      const b = live.ball;
      this.ballFar = Math.max(this.ballFar, Math.hypot(b.pos.x, b.pos.z));
      const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
      if (this.shot === 'follow') {
        const settled = b.pos.y < 0.6 && speed < 6;
        const heldByPlayer = live.players.some((p) => Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z) < 0.7 && b.pos.y > 0.8 && speed < 1);
        if ((settled || heldByPlayer) && this.clock - this.shotStart > 1.0) {
          this.fielderId = this.nearestFielder(live);
          if (this.fielderId) this.cut('fielder');
          this.holdUntil = this.clock + 1.6;
        }
        // home run: stay on the ball; cut to crowd afterwards
      }
    }
    if (this.inPlay && this.holdUntil && this.clock > this.holdUntil && (this.shot === 'base' || this.shot === 'fielder')) {
      this.holdUntil = 0;
      const canReplay = this.replaysEnabled && this.pendingReplay && this.sim.speed <= 1.01 && !this.sim.skipping && this.startReplay(live);
      if (canReplay) this.cut('replay');
      else {
        this.inPlay = false;
        this.cut('pitch');
      }
    }
    if (this.inPlay && this.shot === 'follow' && this.clock - this.shotStart > 9) {
      this.inPlay = false;
      this.cut('pitch');
    }
    if (this.shot === 'cutaway' && this.clock > this.cutawayUntil) this.cut('pitch');
    if (this.shot === 'wide' && this.clock - this.shotStart > 8 && !live.over) this.cut('pitch');

    // ---- replay playback ---------------------------------------------------------------------
    if (this.shot === 'replay' && this.replay) {
      const r = this.replay;
      r.t += dt * 0.5 * 60; // frames at 60 Hz, half speed
      if (r.t >= r.end - 1) {
        this.replay = null;
        this.inPlay = false;
        this.pendingReplay = false;
        this.cut('pitch');
      } else {
        const i = Math.floor(r.t);
        rs = interpolateState(r.frames[i], r.frames[i + 1], r.t - i);
        label = 'REPLAY';
      }
    }

    this.computeDesired(rs, live, dt, players);
    this.applySmoothing(dt);
    const focus = this.focusTarget.distanceTo(this.pos);
    void ball;
    return { renderState: rs, focus, aperture: this.des.aperture, label, shot: this.shot, cut: this.lastCutFrame, replaying: label === 'REPLAY' };
  }

  private nearestFielder(s: GameState): string | null {
    let best: string | null = null;
    let bd = 1e9;
    for (const p of s.players) {
      if (p.team < 0 || p.role === 'batter' || p.role === 'runner' || p.role === 'coach') continue;
      const d = Math.hypot(p.pos.x - s.ball.pos.x, p.pos.z - s.ball.pos.z);
      if (d < bd) {
        bd = d;
        best = p.id;
      }
    }
    return best;
  }

  private startReplay(live: GameState): boolean {
    const hist = this.sim.history;
    if (hist.length < 30) return false;
    const t0 = this.playStart - 0.8;
    const t1 = Math.min(Math.max(this.playEnd, this.playStart + 2) + 0.6, this.playStart + 6.5);
    let i0 = hist.findIndex((s) => s.time >= t0);
    if (i0 < 0) return false;
    let i1 = hist.length - 1;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].time <= t1) { i1 = i; break; }
    if (i1 - i0 < 30) return false;
    const frames = hist.slice(i0, i1 + 1);
    this.replay = { frames, t: 0, end: frames.length, variant: this.ballFar > 55 ? 'outfield' : 'infield', until: 0 };
    void live;
    return true;
  }

  private tele(width: number, dist: number) {
    return MathUtils.radToDeg(2 * Math.atan((width / this.camera.aspect / 2) / Math.max(dist, 1)));
  }

  private computeDesired(rs: GameState, live: GameState, dt: number, players: Map<string, Vector3>) {
    const d = this.des;
    const ball = toScene(rs.ball.pos, new Vector3());
    switch (this.shot) {
      case 'pitch': {
        d.pos.copy(CF_CAM);
        const batter = rs.players.find((p) => p.role === 'batter');
        const bx = batter ? batter.pos.x * 0.3 : 0;
        d.tgt.set(bx, 1.05, 8.2);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = this.tele(8.6, dist);
        d.focus = dist;
        d.aperture = 1.0;
        d.lp = d.lt = d.lf = 6;
        this.focusTarget.copy(d.tgt);
        // pitch in flight: subtle tilt/pan to hold the ball inside the frame
        if (rs.ball.visible && rs.ball.vel.z < -10) {
          d.tgt.x = MathUtils.lerp(d.tgt.x, ball.x * 0.35, 0.5);
        }
        break;
      }
      case 'follow': {
        d.pos.copy(HOME_HIGH);
        // lead the ball slightly; anticipate where it is going
        const lead = new Vector3(rs.ball.vel.x, rs.ball.vel.y * 0.2, rs.ball.vel.z).multiplyScalar(0.12);
        const want = ball.clone().add(lead);
        if (this.clock - this.shotStart < 0.05) this.ballSm.copy(want);
        this.ballSm.lerp(want, 1 - Math.exp(-dt * 6));
        // high balls: aim between the ball and the ground beneath it so the field stays in frame, then
        // widen the lens so the ball itself is still inside the picture
        const hi = MathUtils.clamp((this.ballSm.y - 6) / 55, 0, 0.62);
        d.tgt.set(this.ballSm.x, this.ballSm.y * (1 - hi), this.ballSm.z);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = MathUtils.clamp(this.tele(44 + dist * 0.25, dist), 7, 34);
        const vTo = (p: Vector3) => Math.atan2(p.y - d.pos.y, Math.hypot(p.x - d.pos.x, p.z - d.pos.z));
        const dv = Math.abs(vTo(this.ballSm) - vTo(d.tgt));
        d.fov = Math.max(d.fov, MathUtils.radToDeg(dv) * 2.6 + 6);
        d.focus = dist;
        d.aperture = 0.12;
        d.lp = 2; d.lt = 9; d.lf = 1.6;
        this.focusTarget.copy(this.ballSm);
        break;
      }
      case 'fielder': {
        const fp = (this.fielderId && players.get(this.fielderId)) || this.ballSm;
        const target = fp.clone().setY(1.1);
        const far = Math.hypot(target.x, target.z) > 42;
        if (far) d.pos.set(target.x * 0.25 - 4, 16, -26);
        else d.pos.set(target.x + Math.sign(target.x || 1) * -18, 3.2, target.z - 10);
        if (!far) {
          // stay on the foul-territory side of the field so the play faces camera
          d.pos.set(target.x >= 0 ? target.x + 22 : target.x - 22, 3.4, Math.max(target.z - 6, 4));
        }
        d.tgt.copy(target);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = this.tele(far ? 13 : 9.5, dist);
        d.focus = dist;
        d.aperture = 0.8;
        d.lp = 1.6; d.lt = 5; d.lf = 3;
        this.focusTarget.copy(target);
        break;
      }
      case 'base': {
        const t = this.baseTarget;
        const c = new Vector3(0, 0, 19.4);
        const out = t.clone().sub(c).setY(0);
        if (out.lengthSq() < 1) out.set(0, 0, 1);
        out.normalize();
        d.pos.set(t.x + out.x * 11 + out.z * 6, 2.4, t.z + out.z * 11 - out.x * 6);
        const follow = ball.clone().lerp(t, 0.55);
        d.tgt.copy(follow).setY(1.2);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = this.tele(20, dist);
        d.focus = dist;
        d.aperture = 0.6;
        d.lp = 3; d.lt = 4; d.lf = 3;
        this.focusTarget.copy(d.tgt);
        break;
      }
      case 'replay': {
        const inf = this.replay?.variant === 'infield';
        if (inf) d.pos.set(-40, 4.2, 30);
        else d.pos.set(40, 6.5, 44);
        const want = ball.clone();
        this.ballSm.lerp(want, 1 - Math.exp(-dt * 5));
        d.tgt.copy(this.ballSm);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = MathUtils.clamp(this.tele(26 + dist * 0.2, dist), 9, 40);
        d.focus = dist;
        d.aperture = 0.4;
        d.lp = 4; d.lt = 8; d.lf = 2;
        this.focusTarget.copy(this.ballSm);
        break;
      }
      case 'cutaway': {
        const cs = this.stadium.crowdShots;
        if (this.cutaway === 'crowd') {
          const s = cs[this.shotSeq % cs.length];
          const t = this.clock - this.shotStart;
          d.pos.copy(s.pos).x += Math.sin(t * 0.2) * 1.0;
          d.tgt.copy(s.target);
          d.fov = 15;
        } else if (this.cutaway === 'dugout') {
          const sgn = live.half === 'top' ? 1 : -1;
          d.pos.set(sgn * 3, 1.7, 15);
          d.tgt.set(sgn * 19, 1.2, 2.5);
          d.fov = 15;
        } else {
          const t = this.clock - this.shotStart;
          d.pos.set(-30 + t * 3, 45 - t, -80);
          d.tgt.set(0, 6, 60);
          d.fov = 38;
        }
        d.focus = d.pos.distanceTo(d.tgt);
        d.aperture = this.cutaway === 'wide' ? 0 : 0.6;
        d.lp = d.lt = d.lf = 20;
        this.focusTarget.copy(d.tgt);
        break;
      }
      case 'wide': {
        const t = this.clock - this.shotStart;
        d.pos.set(-58 + t * 4.5, 34 - t * 0.6, -42);
        d.tgt.set(0, 4, 48);
        d.fov = 44;
        d.focus = d.pos.distanceTo(d.tgt);
        d.aperture = 0;
        d.lp = d.lt = d.lf = 20;
        this.focusTarget.copy(d.tgt);
        break;
      }
    }
    void BASES;
  }

  private applySmoothing(dt: number) {
    const d = this.des;
    if (this.lastCutFrame) {
      this.pos.copy(d.pos);
      this.tgt.copy(d.tgt);
      this.fov = d.fov;
    } else {
      this.pos.lerp(d.pos, 1 - Math.exp(-dt * d.lp));
      this.tgt.lerp(d.tgt, 1 - Math.exp(-dt * d.lt));
      this.fov += (d.fov - this.fov) * (1 - Math.exp(-dt * d.lf));
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.tgt);
    if (Math.abs(this.camera.fov - this.fov) > 0.005) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    // keep depth precision tight for telephoto shots
    const dist = this.pos.distanceTo(this.tgt);
    const near = MathUtils.clamp(dist * 0.05, 0.3, 4);
    const far = MathUtils.clamp(dist * 2.2 + 120, 200, 800);
    if (Math.abs(this.camera.near - near) > 0.05 || Math.abs(this.camera.far - far) > 1) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  lastText() {
    return this.lastEventText;
  }
}

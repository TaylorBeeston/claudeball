/**
 * Development stand-in for the real simulation (`src/sim`). It plays a loose
 * game with real ball flight (gravity, drag, Magnus) and fielders that chase
 * the ball, so the renderer can be built and verified without waiting for the
 * sim thread. It is NOT the game: nothing here is used when `src/sim` exists.
 */
import type {
  AnimHint,
  GameEvent,
  GameLike,
  GameState,
  PersonInfo,
  PlayerRole,
  PlayerSnap,
  TeamInfo,
  Vec3,
} from './types';
import { BASES, DIM, wallDistance } from './dims';

const G = 9.81;
const DRAG = 0.0061; // 1/m, 0.5*rho*Cd*A/m for a baseball
const MAGNUS = 4.2e-4;

const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const dist2 = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ball {
  p: Vec3;
  v: Vec3;
  w: Vec3;
  visible: boolean;
  held: string | null;
}

function accel(v: Vec3, w: Vec3): Vec3 {
  const sp = Math.hypot(v.x, v.y, v.z);
  // magnus ∝ ω × v
  const mx = w.y * v.z - w.z * v.y;
  const my = w.z * v.x - w.x * v.z;
  const mz = w.x * v.y - w.y * v.x;
  return {
    x: -DRAG * sp * v.x + MAGNUS * mx,
    y: -G - DRAG * sp * v.y + MAGNUS * my,
    z: -DRAG * sp * v.z + MAGNUS * mz,
  };
}

/** Advance ball by dt with ground bounces. Returns true if it bounced. */
function integrate(b: { p: Vec3; v: Vec3; w: Vec3 }, dt: number): boolean {
  let bounced = false;
  const n = Math.ceil(dt / (1 / 240));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const a = accel(b.v, b.w);
    b.v.x += a.x * h;
    b.v.y += a.y * h;
    b.v.z += a.z * h;
    b.p.x += b.v.x * h;
    b.p.y += b.v.y * h;
    b.p.z += b.v.z * h;
    if (b.p.y < DIM.ballRadius) {
      b.p.y = DIM.ballRadius;
      if (b.v.y < -0.8) {
        b.v.y = -b.v.y * 0.5;
        b.v.x *= 0.82;
        b.v.z *= 0.82;
        b.w.x *= 0.6;
        b.w.y *= 0.6;
        b.w.z *= 0.6;
        bounced = true;
      } else {
        b.v.y = 0;
        const s = Math.hypot(b.v.x, b.v.z);
        const dec = Math.min(s, 2.2 * h);
        if (s > 1e-4) {
          b.v.x -= (b.v.x / s) * dec;
          b.v.z -= (b.v.z / s) * dec;
        }
        // rolling spin follows velocity
        b.w.x = b.v.z / DIM.ballRadius;
        b.w.z = -b.v.x / DIM.ballRadius;
      }
    }
  }
  return bounced;
}

interface Actor extends PlayerSnap {
  target: Vec3 | null;
  speed: number;
  animUntil: number;
  animStart: number;
  home: Vec3;
  gone: boolean;
}

const AWAY: TeamInfo = { name: 'Harbor Kings', abbr: 'HBK', color: '#b3202f', trim: '#161616' };
const HOME: TeamInfo = { name: 'Prairie Foxes', abbr: 'PRF', color: '#f4f4f0', trim: '#12305f' };

const FIRST_NAMES = ['Marcus', 'Diego', 'Kenji', 'Tyler', 'Andre', 'Luis', 'Ryan', 'Carlos', 'Jamal', 'Sam', 'Eli', 'Nico', 'Owen', 'Hector', 'Mateo', 'Jonah', 'Dre', 'Cole'];
const LAST_NAMES = ['Ortega', 'Whitfield', 'Nakamura', 'Brennan', 'Castillo', 'Okafor', 'Lindqvist', 'Reyes', 'Hatcher', 'Sato', 'Delgado', 'Pruitt', 'Vance', 'Moreau', 'Kowalski', 'Adeyemi', 'Barros', 'Tanaka'];

const FIELDERS: { role: PlayerRole; x: number; z: number; speed: number }[] = [
  { role: 'pitcher', x: 0, z: DIM.moundDist, speed: 6.2 },
  { role: 'catcher', x: 0, z: -1.15, speed: 6 },
  { role: 'first', x: -20.5, z: 21.5, speed: 6.6 },
  { role: 'second', x: -8.5, z: 33.5, speed: 7.2 },
  { role: 'short', x: 9.5, z: 33, speed: 7.6 },
  { role: 'third', x: 22, z: 21, speed: 6.9 },
  { role: 'left', x: 36, z: 78, speed: 8 },
  { role: 'center', x: 1, z: 90, speed: 8.6 },
  { role: 'right', x: -38, z: 78, speed: 8 },
];

type Phase = 'ready' | 'windup' | 'flight' | 'inplay' | 'aftermath' | 'inning_break';

export class MockGame implements GameLike {
  private rnd: () => number;
  private listeners = new Set<(e: GameEvent) => void>();
  private t = 0;
  private actors: Actor[] = [];
  private ball: Ball = { p: v3(0, 1.4, 18), v: v3(), w: v3(), visible: true, held: null };
  private bat = { visible: true, pos: v3(), quat: { x: 0, y: 0, z: 0, w: 1 } };
  private phase: Phase = 'ready';
  private phaseT = 0;
  private balls = 0;
  private strikes = 0;
  private outs = 0;
  private inning = 1;
  private half: 'top' | 'bottom' = 'top';
  private score = { away: 0, home: 0 };
  private runners: [boolean, boolean, boolean] = [false, false, false];
  private umpire = { seq: 0, kind: 'none' as GameState['umpireCall']['kind'] };
  private over = false;
  private batterInfo!: PersonInfo;
  private pitcherInfo!: PersonInfo;
  private batter!: Actor;
  private hand: 'L' | 'R' = 'R';

  // pitch / swing bookkeeping
  private swing: { start: number; contactAt: number; contact: boolean } | null = null;
  private flightT = 0;
  private plateT = 0;
  private pitchCross = false;
  private play: {
    fielder: Actor | null;
    catchAt: Vec3;
    phase: 'chase' | 'held' | 'thrown' | 'done';
    throwTo?: Actor;
    runnerOut: boolean | null;
    fair: boolean;
    homer: boolean;
    fly: boolean;
    resolved: boolean;
  } | null = null;
  private runnerActor: Actor | null = null;
  private runnerStart = 0;
  private baseRunners: (Actor | null)[] = [null, null, null];

  constructor(seed = 1) {
    this.rnd = mulberry32(seed);
    this.buildDefense();
    this.newBatter();
    this.resetPitchers();
  }

  on(cb: (e: GameEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(e: GameEvent) {
    for (const l of this.listeners) l(e);
  }

  private person(id: string): PersonInfo {
    const n = Math.floor(this.rnd() * 900);
    const r = () => FIRST_NAMES[Math.floor(this.rnd() * FIRST_NAMES.length)];
    const l = () => LAST_NAMES[Math.floor(this.rnd() * LAST_NAMES.length)];
    return {
      id,
      name: `${r()} ${l()}`,
      number: 1 + Math.floor(this.rnd() * 60),
      hand: this.rnd() < 0.3 ? 'L' : 'R',
      stats: `.${String(200 + Math.floor(this.rnd() * 120)).padStart(3, '0')} AVG  ${Math.floor(this.rnd() * 40)} HR  ${(n % 110) + 20} RBI`,
    };
  }

  private fieldingTeam() {
    return this.half === 'top' ? 1 : 0;
  }
  private battingTeam() {
    return this.half === 'top' ? 0 : 1;
  }

  private mk(id: string, team: number, role: PlayerRole, pos: Vec3, facing: number, speed = 6.5): Actor {
    return {
      id, team, role, pos: { ...pos }, facing, vel: v3(), anim: 'idle', target: null, speed,
      animUntil: 0, animStart: 0, home: { ...pos }, gone: false, hand: 'R',
    };
  }

  private buildDefense() {
    this.actors = this.actors.filter((a) => a.team === -1 || a.id.startsWith('C') || a.id === 'B');
    const ft = this.fieldingTeam();
    for (const f of FIELDERS) {
      const a = this.mk(`F-${f.role}`, ft, f.role, v3(f.x, 0, f.z), f.role === 'catcher' ? 0 : Math.atan2(-f.x, -f.z + 0.01), f.speed);
      this.actors.push(a);
    }
    if (!this.actors.find((a) => a.id === 'U-plate')) {
      const u = this.mk('U-plate', -1, 'umpire', v3(0.15, 0, -2.3), 0);
      u.name = 'Home Plate Umpire';
      this.actors.push(u);
    }
    this.actors = this.actors.filter((a) => !a.id.startsWith('C'));
    const bt = this.battingTeam();
    this.actors.push(this.mk('C1', bt, 'coach', v3(-26, 0, 12.5), Math.atan2(1, 0.5)));
    this.actors.push(this.mk('C3', bt, 'coach', v3(26, 0, 12.5), Math.atan2(-1, 0.5)));
  }

  private fielder(role: PlayerRole) {
    return this.actors.find((a) => a.id === `F-${role}`)!;
  }

  private resetPitchers() {
    this.pitcherInfo = this.person(`P${this.inning}${this.half}`);
    const p = this.fielder('pitcher');
    p.hand = this.pitcherInfo.hand;
    p.name = this.pitcherInfo.name;
    p.number = this.pitcherInfo.number;
  }

  private newBatter() {
    this.actors = this.actors.filter((a) => a.id !== 'B');
    this.batterInfo = this.person(`B${this.t.toFixed(1)}`);
    this.hand = this.batterInfo.hand;
    const side = this.hand === 'R' ? 1 : -1;
    const b = this.mk('B', this.battingTeam(), 'batter', v3(side * 0.95, 0, 0.05), side > 0 ? Math.PI / 2 * -1 : Math.PI / 2, 8);
    b.facing = side < 0 ? Math.PI / 2 : -Math.PI / 2; // face the plate
    b.hand = this.hand;
    b.name = this.batterInfo.name;
    b.number = this.batterInfo.number;
    this.batter = b;
    this.actors.push(b);
    this.updateBatPose(0);
    this.bat.visible = true;
  }

  private setAnim(a: Actor, hint: AnimHint, dur = 0) {
    a.anim = hint;
    a.animStart = this.t;
    a.animUntil = dur > 0 ? this.t + dur : 0;
  }

  // ------------------------------------------------------------------ bat
  private batHands() {
    const side = this.hand === 'R' ? 1 : -1;
    return v3(side * 0.6, 1.12, 0.05 - 0.12);
  }

  private updateBatPose(swingT: number) {
    // swingT: 0 = stance, in (0,1] = swing progress (1 = through)
    const side = this.hand === 'R' ? 1 : -1;
    const hands = this.batHands();
    let dir: Vec3;
    if (swingT <= 0) {
      dir = norm(v3(side * 0.05 - side * 0.1, 0.9, -0.32));
    } else {
      // sweep in a plane from back-up to across the plate to follow-through
      const th = -0.3 + swingT * 3.5; // 0 = pointing back (−z)
      const lift = 0.5 * (1 - swingT);
      dir = norm(v3(-side * Math.sin(th) * 0.0 + -side * Math.sin(th), lift, -Math.cos(th)));
    }
    this.bat.pos = hands;
    this.bat.quat = quatFromTo(v3(0, 1, 0), dir);
  }

  // ---------------------------------------------------------------- state
  getState(): GameState {
    const players: PlayerSnap[] = [];
    for (const a of this.actors) {
      if (a.gone) continue;
      players.push({
        id: a.id, team: a.team, role: a.role, name: a.name, number: a.number, hand: a.hand,
        pos: { ...a.pos }, facing: a.facing, vel: { ...a.vel }, anim: a.anim, animTime: this.t - a.animStart,
      });
    }
    return {
      time: this.t,
      ball: { pos: { ...this.ball.p }, vel: { ...this.ball.v }, spin: { ...this.ball.w }, visible: this.ball.visible },
      bat: { visible: this.bat.visible, pos: { ...this.bat.pos }, quat: { ...this.bat.quat } },
      players,
      umpireCall: { ...this.umpire },
      count: { balls: this.balls, strikes: this.strikes },
      outs: this.outs,
      inning: this.inning,
      half: this.half,
      score: { ...this.score },
      runners: [...this.runners] as [boolean, boolean, boolean],
      batter: this.batterInfo,
      pitcher: this.pitcherInfo,
      teams: { away: AWAY, home: HOME },
      over: this.over,
    };
  }

  // ----------------------------------------------------------------- step
  step(dt: number) {
    if (this.over) return;
    this.t += dt;
    this.phaseT += dt;
    this.moveActors(dt);
    switch (this.phase) {
      case 'ready': this.stepReady(); break;
      case 'windup': this.stepWindup(); break;
      case 'flight': this.stepFlight(dt); break;
      case 'inplay': this.stepInPlay(dt); break;
      case 'aftermath': this.stepAfter(); break;
      case 'inning_break': this.stepBreak(); break;
    }
    // held ball follows carrier
    if (this.ball.held) {
      const c = this.actors.find((a) => a.id === this.ball.held);
      if (c) {
        this.ball.p = v3(c.pos.x + Math.sin(c.facing) * 0.35, 1.25, c.pos.z + Math.cos(c.facing) * 0.35);
        this.ball.v = v3();
      }
    }
  }

  private moveActors(dt: number) {
    for (const a of this.actors) {
      if (a.animUntil && this.t >= a.animUntil) {
        a.anim = 'idle';
        a.animUntil = 0;
        a.animStart = this.t;
      }
      if (a.target) {
        const dx = a.target.x - a.pos.x, dz = a.target.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.08) {
          a.target = null;
          a.vel = v3();
          if (a.anim === 'run') this.setAnim(a, 'idle');
        } else {
          const sp = Math.min(a.speed, d / dt);
          const cur = Math.hypot(a.vel.x, a.vel.z);
          const s = Math.min(a.speed, sp, cur + 7 * dt); // accel
          a.vel = v3((dx / d) * s, 0, (dz / d) * s);
          a.pos.x += a.vel.x * dt;
          a.pos.z += a.vel.z * dt;
          let dyaw = Math.atan2(dx, dz) - a.facing;
          dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
          a.facing += dyaw * Math.min(1, dt * 10);
          if (a.anim === 'idle') this.setAnim(a, 'run');
        }
      }
    }
  }

  private face(a: Actor, p: Vec3) {
    a.facing = Math.atan2(p.x - a.pos.x, p.z - a.pos.z);
  }

  private stepReady() {
    const p = this.fielder('pitcher');
    this.face(p, v3());
    this.ball.visible = true;
    this.ball.p = v3(p.pos.x + 0.25, 1.35, p.pos.z - 0.2);
    this.ball.v = v3();
    this.ball.w = v3();
    if (this.phaseT > 2.4) {
      this.setAnim(p, 'windup', 1.15);
      this.phase = 'windup';
      this.phaseT = 0;
    }
  }

  private stepWindup() {
    const p = this.fielder('pitcher');
    this.ball.p = v3(p.pos.x + 0.25, 1.35, p.pos.z - 0.2);
    if (this.phaseT >= 1.15) this.throwPitch(p);
  }

  private pickPitch() {
    const r = this.rnd();
    if (r < 0.5) return { type: 'FF', speed: 40 + this.rnd() * 3, w: v3(230, 0, 0) };
    if (r < 0.7) return { type: 'SL', speed: 36 + this.rnd() * 2, w: v3(40, this.hand === 'R' ? 210 : -210, 0) };
    if (r < 0.85) return { type: 'CU', speed: 32 + this.rnd() * 2, w: v3(-220, 60, 0) };
    return { type: 'CH', speed: 34 + this.rnd() * 2, w: v3(110, 0, 0) };
  }

  private throwPitch(p: Actor) {
    const pitch = this.pickPitch();
    const rel = v3(p.pos.x - 0.35, 1.85, p.pos.z - 1.4);
    // aim
    const wide = this.rnd() < 0.42;
    const tx = (this.rnd() - 0.5) * (wide ? 0.95 : 0.4);
    const ty = DIM.zoneBottom + 0.05 + this.rnd() * (DIM.zoneTop - DIM.zoneBottom) + (wide ? (this.rnd() - 0.5) * 0.5 : 0);
    const target = v3(tx, ty, 0);
    const T0 = Math.hypot(rel.x - tx, rel.y - ty, rel.z) / (pitch.speed * 0.93);
    let v0 = v3((target.x - rel.x) / T0, (target.y - rel.y + 0.5 * G * T0 * T0) / T0, -rel.z / T0);
    for (let i = 0; i < 6; i++) {
      const sim = { p: { ...rel }, v: { ...v0 }, w: { ...pitch.w } };
      let tt = 0;
      while (sim.p.z > 0 && tt < 2) {
        integrate(sim, 1 / 240);
        tt += 1 / 240;
      }
      v0 = v3(v0.x + (target.x - sim.p.x) / tt, v0.y + (target.y - sim.p.y) / tt, v0.z);
      if (Math.abs(target.y - sim.p.y) < 0.004 && Math.abs(target.x - sim.p.x) < 0.004) {
        this.plateT = tt;
        break;
      }
      this.plateT = tt;
    }
    this.ball.p = rel;
    this.ball.v = v0;
    this.ball.w = { ...pitch.w };
    this.ball.visible = true;
    this.setAnim(p, 'pitch', 0.55);
    this.emit({ type: 'pitch', pitchType: pitch.type, speed: Math.hypot(v0.x, v0.y, v0.z), pitcherId: p.id });
    this.phase = 'flight';
    this.phaseT = 0;
    this.flightT = 0;
    this.pitchCross = false;
    const inZone = Math.abs(tx) < DIM.plateWidth / 2 + 0.036 && ty > DIM.zoneBottom - 0.04 && ty < DIM.zoneTop + 0.04;
    (this as unknown as { lastInZone: boolean }).lastInZone = inZone;
    const swings = this.rnd() < (inZone ? 0.62 : 0.26) || this.strikes === 2 && inZone;
    if (swings) {
      const dur = 0.27;
      this.swing = { start: this.plateT - dur * 0.78, contactAt: this.plateT, contact: this.rnd() < (inZone ? 0.66 : 0.4) };
    } else this.swing = null;
  }

  private stepFlight(dt: number) {
    this.flightT += dt;
    if (this.swing) {
      const s = (this.flightT - this.swing.start) / 0.27;
      if (s > 0) {
        if (this.batter.anim !== 'swing' && s < 1.4) this.setAnim(this.batter, 'swing', 0.6);
        this.updateBatPose(Math.min(1, s));
      }
    }
    const wasZ = this.ball.p.z;
    integrate(this.ball, dt);
    if (!this.pitchCross && this.ball.p.z <= 0.2 && wasZ > 0.2) {
      this.pitchCross = true;
      if (this.swing?.contact) {
        this.contact();
        return;
      }
    }
    if (this.ball.p.z < -0.9 && !this.play) {
      // caught by the catcher
      const c = this.fielder('catcher');
      this.setAnim(c, 'catch', 0.5);
      this.ball.held = c.id;
      this.ball.v = v3();
      const inZone = (this as unknown as { lastInZone: boolean }).lastInZone;
      const swung = !!this.swing;
      if (swung) this.call('strike', true);
      else this.call(inZone ? 'strike' : 'ball', false);
      this.phase = 'aftermath';
      this.phaseT = 0;
      this.updateBatPose(0);
    }
  }

  private call(kind: 'ball' | 'strike', swung: boolean) {
    this.umpire = { seq: this.umpire.seq + 1, kind };
    this.emit({ type: kind });
    if (kind === 'ball') {
      this.balls++;
      if (this.balls >= 4) {
        this.emit({ type: 'play', text: `${this.batterInfo.name} draws a walk.` });
        this.batterToFirst(true);
      }
    } else {
      this.strikes++;
      if (this.strikes >= 3) {
        this.emit({ type: 'out', playerId: this.batter.id, text: `${this.batterInfo.name} ${swung ? 'swings through' : 'called out looking'} for strike three.` });
        this.addOut();
        this.setAnim(this.batter, 'idle');
        this.batter.target = v3(this.batter.pos.x * 3, 0, -6);
        this.batter.speed = 3;
      }
    }
  }

  private contact() {
    const r = this.rnd;
    const gauss = () => (r() + r() + r() - 1.5) * 2;
    const exit = Math.max(18, 38 + gauss() * 8 - (this.swing && !(this as unknown as { lastInZone: boolean }).lastInZone ? 6 : 0));
    const la = 10 + gauss() * 17;
    const spray = gauss() * 26 * (Math.PI / 180) * (this.hand === 'R' ? 1 : -1) * 1.0;
    const cl = Math.cos((la * Math.PI) / 180);
    // spray>0 -> third base side (+x)
    const v = v3(Math.sin(spray) * cl * exit, Math.sin((la * Math.PI) / 180) * exit, Math.cos(spray) * cl * exit);
    this.ball.p = v3(0.02, 0.92, 0.3);
    this.ball.v = v;
    const back = 260 + gauss() * 60;
    // ω = v̂ × ŷ · rate gives backspin (lift) via the Magnus term
    this.ball.w = cross(norm(v), v3(0, 1, 0), back);
    this.phase = 'inplay';
    this.phaseT = 0;
    this.pitchCross = true;
    this.setAnim(this.batter, 'swing', 0.5);
    this.updateBatPose(0.85);
    this.emit({ type: 'contact', exitVelo: exit, launchAngle: la, sprayAngle: (spray * 180) / Math.PI, batterId: this.batter.id });
    this.planPlay();
  }

  private planPlay() {
    // predict trajectory to find landing, foul, homer, and the fielder that gets there first
    const sim = { p: { ...this.ball.p }, v: { ...this.ball.v }, w: { ...this.ball.w } };
    let firstGround: Vec3 | null = null;
    let homer = false;
    const samples: { t: number; p: Vec3 }[] = [];
    for (let t = 0; t < 9; t += 0.05) {
      const bounced = integrate(sim, 0.05);
      samples.push({ t: t + 0.05, p: { ...sim.p } });
      if (bounced && !firstGround) firstGround = { ...sim.p };
      const r = Math.hypot(sim.p.x, sim.p.z);
      const phi = Math.atan2(sim.p.x, sim.p.z);
      if (!firstGround && r > wallDistance(phi) && Math.abs(phi) < Math.PI / 4 && sim.p.y > DIM.wallHeight) {
        homer = true;
        break;
      }
    }
    const g = firstGround ?? samples[samples.length - 1].p;
    const foul = !homer && (g.z < 0 || Math.abs(g.x) > g.z);
    const play = { fielder: null as Actor | null, catchAt: g, phase: 'chase' as const, runnerOut: null as boolean | null, fair: !foul, homer, fly: false, resolved: false };
    this.play = play;
    if (homer) {
      this.runnerActor = null;
      return;
    }
    if (foul) {
      // fielder still tries for it if it's catchable
    }
    let best = { t: Infinity, f: null as Actor | null, p: g, fly: false };
    for (const s of samples) {
      if (s.p.y > 2.6) continue;
      for (const f of this.actors) {
        if (!f.id.startsWith('F-') || f.role === 'catcher' && !foul) continue;
        const need = 0.3 + Math.max(0, dist2(f.pos, s.p) - 0.5) / f.speed;
        if (need <= s.t && s.t < best.t) best = { t: s.t, f, p: s.p, fly: s.p.y > 0.3 && !(firstGround && s.t > samples.findIndex(() => true)) };
      }
    }
    if (!best.f) {
      let bd = Infinity;
      const stop = samples[samples.length - 1].p;
      for (const f of this.actors) {
        if (!f.id.startsWith('F-')) continue;
        const d = dist2(f.pos, stop);
        if (d < bd) {
          bd = d;
          best = { t: 9, f, p: stop, fly: false };
        }
      }
    }
    play.fielder = best.f;
    play.catchAt = { ...best.p };
    play.fly = best.fly && (!firstGround || best.t <= samples.findIndex((s) => s.p.y <= DIM.ballRadius * 1.5 && s.t > 0.2) * 0.05 + 0.05);
    if (best.f) {
      best.f.target = { x: best.p.x, y: 0, z: best.p.z };
      this.setAnim(best.f, 'run');
    }
    // others cover bases
    if (!foul) {
      const fb = this.fielder('first');
      if (best.f !== fb) {
        fb.target = v3(BASES[0].x + 0.6, 0, BASES[0].z + 0.3);
      }
      const pit = this.fielder('pitcher');
      if (best.f === fb && best.f !== pit) pit.target = v3(BASES[0].x + 1.2, 0, BASES[0].z - 6);
      // run
      const b = this.batter;
      b.speed = 8.3;
      this.runnerActor = b;
      this.runnerStart = this.t + 0.22;
      this.updateBatPose(0);
      this.bat.visible = true;
    }
  }

  private stepInPlay(dt: number) {
    const play = this.play!;
    const b = this.batter;
    if (play.homer) {
      integrate(this.ball, dt);
      const r = Math.hypot(this.ball.p.x, this.ball.p.z);
      if (this.phaseT > 0.4 && this.bat.visible) this.bat.visible = false;
      if (!play.resolved && r > wallDistance(Math.atan2(this.ball.p.x, this.ball.p.z)) + 6) {
        play.resolved = true;
        this.ball.visible = false;
        const n = this.runners.filter(Boolean).length + 1;
        this.runners = [false, false, false];
        this.emit({ type: 'run', text: `HOME RUN! ${this.batterInfo.name} goes deep. ${n} run${n > 1 ? 's' : ''} score.` });
        this.umpire = { seq: this.umpire.seq + 1, kind: 'homerun' };
        this.addRuns(n);
        this.setAnim(b, 'idle');
        b.target = v3(3, 0, 24);
        b.speed = 4.5;
        this.phase = 'aftermath';
        this.phaseT = -3;
        this.clearBaseRunners();
      }
      return;
    }
    if (this.t >= this.runnerStart && this.runnerActor && !b.target && play.runnerOut === null && b.anim !== 'run') {
      b.target = v3(BASES[0].x, 0, BASES[0].z);
      this.setAnim(b, 'run');
      if (this.bat.visible) this.bat.visible = false;
    }
    if (play.phase === 'chase' || play.phase === 'held') {
      const before = { ...this.ball.p };
      if (!this.ball.held) integrate(this.ball, dt);
      const f = play.fielder;
      if (this.phaseT > 0.4 && this.bat.visible && !this.runnerActor) this.bat.visible = false;
      if (!play.fair && !this.ball.held) {
        // foul ball: let it fly then dead
        if (this.ball.p.y <= DIM.ballRadius * 1.1 && Math.hypot(this.ball.v.x, this.ball.v.z) < 1 || this.phaseT > 6) this.endFoul();
        if (f && dist2(f.pos, this.ball.p) < 0.9 && this.ball.p.y < 2.4 && this.ball.p.y > 0.2 && this.phase === 'inplay') {
          this.setAnim(f, 'catch', 0.6);
          this.emit({ type: 'catch', playerId: f.id, inAir: true });
          this.ball.held = f.id;
          this.endFoul(true);
        }
        return;
      }
      void before;
      if (f && !this.ball.held) {
        const d = Math.hypot(f.pos.x - this.ball.p.x, f.pos.z - this.ball.p.z);
        const reach = d < 0.85 && this.ball.p.y < 2.5;
        if (reach) {
          const air = this.ball.p.y > 0.45 && play.fly;
          this.ball.held = f.id;
          f.target = null;
          f.vel = v3();
          this.setAnim(f, air ? 'catch' : 'field', 0.55);
          this.emit({ type: 'catch', playerId: f.id, inAir: air });
          play.phase = 'held';
          this.phaseT = 0;
          if (air) {
            this.emit({ type: 'out', playerId: b.id, text: `${this.batterInfo.name} flies out to ${roleName(f.role)}.` });
            this.addOut();
            this.stopRunner();
            play.resolved = true;
            this.phase = 'aftermath';
            this.phaseT = 0;
            return;
          }
        }
      }
      if (play.phase === 'held' && this.phaseT > 0.75 && !play.resolved) {
        // throw to first
        const fb = this.fielder('first');
        const target = f === fb ? null : fb;
        const first = this.runnerActor;
        if (!first) return;
        if (!target) {
          // first baseman fields unassisted: race runner to bag
          f!.target = v3(BASES[0].x + 0.4, 0, BASES[0].z);
          f!.speed = 7;
          play.phase = 'thrown';
          play.throwTo = f!;
          return;
        }
        const from = { ...this.ball.p };
        const to = v3(BASES[0].x + 0.5, 1.2, BASES[0].z + 0.2);
        const d = Math.hypot(to.x - from.x, to.z - from.z);
        const T = d / 31 + 0.05;
        this.ball.held = null;
        this.ball.v = v3((to.x - from.x) / T, (to.y - from.y + 0.5 * G * T * T) / T, (to.z - from.z) / T);
        this.ball.w = v3();
        this.setAnim(f!, 'throw', 0.6);
        this.face(f!, to);
        this.emit({ type: 'throw', playerId: f!.id, target: to, targetId: fb.id });
        play.phase = 'thrown';
        play.throwTo = fb;
        this.phaseT = 0;
      }
    } else if (play.phase === 'thrown') {
      const rcv = play.throwTo!;
      if (!this.ball.held) {
        // pure ballistic (no drag) throw
        this.ball.v.y -= G * dt;
        this.ball.p.x += this.ball.v.x * dt;
        this.ball.p.y += this.ball.v.y * dt;
        this.ball.p.z += this.ball.v.z * dt;
        if (dist2(this.ball.p, rcv.pos) < 0.9 || this.ball.p.y < 0.1) {
          this.ball.held = rcv.id;
          this.setAnim(rcv, 'catch', 0.5);
          this.emit({ type: 'catch', playerId: rcv.id, inAir: true });
          this.resolveFirst();
        }
      } else if (rcv === play.fielder && dist2(rcv.pos, BASES[0]) < 0.9) {
        this.resolveFirst();
      }
    }
    if (this.runnerActor && play.runnerOut === null && dist2(b.pos, BASES[0]) < 0.3) {
      // runner beat everything so far; wait for the throw
    }
  }

  private resolveFirst() {
    const play = this.play!;
    if (play.resolved) return;
    play.resolved = true;
    const b = this.batter;
    const arrived = dist2(b.pos, BASES[0]) < 0.35;
    if (!arrived) {
      play.runnerOut = true;
      this.umpire = { seq: this.umpire.seq + 1, kind: 'out' };
      this.emit({ type: 'out', playerId: b.id, text: `${this.batterInfo.name} is out at first.` });
      this.addOut();
      this.stopRunner();
    } else {
      play.runnerOut = false;
      this.umpire = { seq: this.umpire.seq + 1, kind: 'safe' };
      this.emit({ type: 'play', text: `${this.batterInfo.name} beats the throw. Safe at first.` });
      this.batterToFirst(false);
    }
    this.phase = 'aftermath';
    this.phaseT = 0;
  }

  private stopRunner() {
    const b = this.batter;
    b.target = v3(b.pos.x < 5 ? -8 : b.pos.x + 4, 0, Math.max(0, b.pos.z - 3));
    b.speed = 3;
  }

  private endFoul(caught = false) {
    const play = this.play!;
    if (play.resolved) return;
    play.resolved = true;
    if (caught) {
      this.emit({ type: 'out', playerId: this.batter.id, text: `${this.batterInfo.name} pops out in foul territory.` });
      this.addOut();
    } else {
      this.emit({ type: 'foul' });
      this.umpire = { seq: this.umpire.seq + 1, kind: 'foul' };
      if (this.strikes < 2) this.strikes++;
    }
    this.phase = 'aftermath';
    this.phaseT = 0;
  }

  private batterToFirst(walk: boolean) {
    const b = this.batter;
    // force advance
    const [r1, r2, r3] = this.runners;
    let runs = 0;
    if (r1) {
      if (r2) {
        if (r3) runs++;
        this.runners[2] = true;
      }
      this.runners[1] = true;
    }
    void r3;
    this.runners[0] = true;
    if (runs) {
      this.emit({ type: 'run', text: 'A run scores.' });
      this.addRuns(runs);
    }
    if (walk) {
      b.target = v3(BASES[0].x, 0, BASES[0].z);
      b.speed = 4;
      this.setAnim(b, 'run');
    }
    this.bat.visible = false;
    this.assignBaseRunners(b);
    this.newBatterPending = true;
  }
  private newBatterPending = false;

  private assignBaseRunners(b: Actor) {
    b.role = 'runner';
    this.baseRunners = [b, ...this.baseRunners.slice(0, 2)] as (Actor | null)[];
    void this.baseRunners;
  }
  private clearBaseRunners() {
    for (const a of this.actors) if (a.role === 'runner') a.gone = true;
    this.baseRunners = [null, null, null];
  }

  private addRuns(n: number) {
    if (this.half === 'top') this.score.away += n;
    else this.score.home += n;
  }

  private addOut() {
    this.outs++;
    if (this.outs >= 3) {
      this.phase = 'aftermath';
    }
  }

  private stepAfter() {
    if (this.phaseT < 2.2) return;
    this.ball.held = null;
    if (this.outs >= 3) {
      this.half === 'top' ? (this.half = 'bottom') : ((this.half = 'top'), this.inning++);
      this.emit({ type: 'half_inning', inning: this.inning, half: this.half });
      this.phase = 'inning_break';
      this.phaseT = 0;
      this.balls = this.strikes = this.outs = 0;
      this.runners = [false, false, false];
      this.actors = this.actors.filter((a) => a.role !== 'runner' && a.id !== 'B');
      this.batter.gone = true;
      this.bat.visible = false;
      this.ball.visible = false;
      this.play = null;
      this.runnerActor = null;
      if (this.inning > 9 || (this.inning === 9 && this.half === 'bottom' && this.score.home > this.score.away)) {
        this.over = true;
        this.emit({ type: 'game_end', winner: this.score.home > this.score.away ? 'home' : this.score.home < this.score.away ? 'away' : 'tie' });
      }
      return;
    }
    // next pitch or next batter
    const ended = this.strikes >= 3 || this.balls >= 4 || (this.play && (this.play.resolved && this.play.fair)) || this.newBatterPending;
    if (ended || this.play?.resolved) {
      this.strikes = this.balls = 0;
      this.actors = this.actors.filter((a) => a.id !== 'B' || a.role === 'runner');
      // keep base runners parked on their bases
      this.parkRunners();
      this.newBatterPending = false;
      this.newBatter();
    } else if (this.play && this.play.resolved) {
      // foul: same batter
    }
    this.play = null;
    this.swing = null;
    this.runnerActor = null;
    this.updateBatPose(0);
    this.bat.visible = true;
    this.resetFielders();
    this.phase = 'ready';
    this.phaseT = 0;
  }

  private parkRunners() {
    // remove departed batters, stand runners at their bases
    this.actors = this.actors.filter((a) => a.role !== 'runner' || a.id === 'B' || !a.gone);
    const parked: Actor[] = [];
    for (const a of this.actors) if (a.role === 'runner') parked.push(a);
    // rebuild from flags
    for (const a of parked) a.gone = true;
    this.actors = this.actors.filter((a) => a.role !== 'runner');
    for (let i = 0; i < 3; i++) {
      if (!this.runners[i]) continue;
      const bp = BASES[i];
      const r = this.mk(`R${i}-${this.t.toFixed(1)}`, this.battingTeam(), 'runner', v3(bp.x * 0.93 - Math.sign(bp.x) * 0.5, 0, bp.z * 0.93), 0);
      r.facing = Math.atan2(-bp.x, 20 - bp.z);
      this.actors.push(r);
    }
  }

  private resetFielders() {
    for (const f of this.actors) {
      if (!f.id.startsWith('F-')) continue;
      f.target = { ...f.home };
      f.speed = 6;
    }
  }

  private stepBreak() {
    if (this.phaseT > 5) {
      this.buildDefense();
      this.resetPitchers();
      this.newBatter();
      this.updateBatPose(0);
      this.ball.visible = true;
      this.phase = 'ready';
      this.phaseT = 0;
    }
  }
}

function roleName(r: PlayerRole) {
  return { left: 'left field', center: 'center field', right: 'right field', short: 'shortstop', first: 'first base', second: 'second base', third: 'third base', pitcher: 'the pitcher', catcher: 'the catcher' }[r as 'left'] ?? r;
}
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return v3(v.x / l, v.y / l, v.z / l);
}
function cross(a: Vec3, b: Vec3, s: number): Vec3 {
  return v3((a.y * b.z - a.z * b.y) * s, (a.z * b.x - a.x * b.z) * s, (a.x * b.y - a.y * b.x) * s);
}
function quatFromTo(a: Vec3, b: Vec3) {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  if (d < -0.9999) return { x: 1, y: 0, z: 0, w: 0 };
  const c = cross(a, b, 1);
  const q = { x: c.x, y: c.y, z: c.z, w: 1 + d };
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

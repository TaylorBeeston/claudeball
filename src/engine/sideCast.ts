/**
 * The side cast: everybody at a ball game who is not in the sim's play. Bench players in the dugouts, the on-deck batter at his circle (he
 * walks to the plate when the batter before him is done), the first- and third-base coaches (they read the runners and signal), and the ball
 * kids down the lines (they fetch foul balls and sometimes toss one to a fan).
 *
 * The sim can send any of these itself (roles `bench`, `ondeck`, `coach1b`, `coach3b`, `ballkid` in `players[]`, hints `bench_sit`, `coach_*`, …);
 * a category it sends is left alone. For the rest this module makes the characters up from sim facts (who is batting, where the runners and the
 * ball are) and emits them as ordinary `PlayerSnap`s, plus `coach_signal` / `ball_kid_retrieve` / `ball_tossed_to_fan` events. Pure logic, no
 * rendering, deterministic (no Math.random): it is unit-tested.
 */
import { BASES } from './dims';
import type { AnimHint, GameEvent, GameState, PlayerRole, PlayerSnap, SidePerson, Vec3 } from './types';

const SQ = Math.SQRT1_2;

export interface Seat {
  pos: Vec3;
  facing: number;
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface Layout {
  /** bench seats per team ([away (1B side, −X), home (3B side, +X)]) */
  bench: [Seat[], Seat[]];
  /** the on-deck circle per team */
  onDeck: [Vec3, Vec3];
  /** where the batter steps in from (the sim starts him at ±3.2, −4): the on-deck batter walks to here */
  stepIn: [Vec3, Vec3];
  coach: { first: Vec3; third: Vec3 };
  kids: Vec3[];
  /** floor of the dugouts */
  floorY: number;
}

export const DEFAULT_FLOOR = -1.05;
export const DEFAULT_BENCH_TOP = -0.62;

const yawTo = (from: Vec3, to: Vec3) => Math.atan2(to.x - from.x, to.z - from.z);
const dist2 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Where everything stands, from the sim's coordinates (+X third base, +Z center field, home plate at the origin). `benches` are the real
 * dugout bench boxes ([away, home]) when the field has them: players sit along the bench's long side with the root on the dugout floor
 * (`bench_sit` puts the hips at seat height itself).
 */
export function makeLayout(benches?: [Box | null, Box | null], floorY = DEFAULT_FLOOR): Layout {
  const bench: [Seat[], Seat[]] = [[], []];
  for (const team of [0, 1] as const) {
    const sign = team === 1 ? 1 : -1;
    const box = benches?.[team];
    const cx = box ? (box.min.x + box.max.x) / 2 : sign * 25.8;
    const cz = box ? (box.min.z + box.max.z) / 2 : 7;
    const len = box ? box.max.z - box.min.z : 12;
    const half = Math.max(1.2, len / 2 - 0.9);
    for (let i = 0; i < 4; i++) {
      const z = cz - half + ((i + 0.5) * (2 * half)) / 4;
      bench[team].push({ pos: { x: cx, y: floorY, z }, facing: Math.atan2(-sign, 0.3) });
    }
  }
  const f = BASES[0], t = BASES[2];
  // foul-side coach boxes beside the bags, a little toward home
  const coach = {
    first: { x: f.x + -SQ * 2.7 + SQ * 1.0, y: 0, z: f.z + -SQ * 2.7 - SQ * 1.0 },
    third: { x: t.x + SQ * 2.7 - SQ * 1.0, y: 0, z: t.z + -SQ * 2.7 - SQ * 1.0 },
  };
  // against the side wall, like the sim's chairs (48 m down the line, 15.9 m off it: out on the open foul grass a seated kid read as sitting in the outfield)
  const kidAt = (sign: number) => ({ x: sign * (SQ * 48 + SQ * 15.9), y: 0, z: SQ * 48 - SQ * 15.9 });
  return {
    bench,
    onDeck: [{ x: -8.6, y: 0, z: -5.2 }, { x: 8.6, y: 0, z: -5.2 }],
    stepIn: [{ x: -3.2, y: 0, z: -4 }, { x: 3.2, y: 0, z: -4 }],
    coach,
    kids: [kidAt(-1), kidAt(1)],
    floorY,
  };
}

/** a deterministic [0, 1) from a string and a counter */
export function hash01(s: string, n = 0): number {
  let h = 2166136261 ^ n;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** nominal lengths (s) of the one-shot hints, so the clip can be laid on their progress */
export const SIDE_DUR: Partial<Record<AnimHint, number>> = {
  ondeck_swing: 1.333,
  coach_stop: 1.0,
  coach_go: 1.5,
  coach_advance: 1.333,
  coach_slide: 1.0,
  coach_signs: 3.0,
  ballkid_pickup: 1.5,
  ballkid_toss: 1.0,
  bench_stand_up: 1.167,
  bench_cheer: 1.5,
};
/** where in those clips the ball changes hands (s): the kid's hand closes on the ball / the ball leaves his hand */
export const KID_PICKUP_AT = 0.5417;
export const KID_RELEASE_AT = 0.4167;

/** A signal a coach gives a runner, decided from where the runner, the ball and the throw are. Pure, so it can be tested. */
export function coachDecision(opts: {
  base: 1 | 3;
  runnerDistance: number;
  ballDistanceToHome: number;
  ballSpeed: number;
  ballTowardHome: boolean;
}): 'stop' | 'go' | 'advance' | 'slide' {
  if (opts.base === 3) {
    if (opts.ballSpeed > 20 && opts.ballTowardHome && opts.ballDistanceToHome < 40 && opts.runnerDistance < 7) return 'slide';
    return opts.ballDistanceToHome > 42 ? 'go' : 'stop';
  }
  return opts.ballDistanceToHome > 52 ? 'advance' : 'stop';
}

/** where a ball kid tosses a ball: a fan in the first rows behind the foul fence, on the side of the kid */
export function fanSeat(kid: Vec3): Vec3 {
  const s = Math.sign(kid.x) || 1;
  // outward from the foul line (away from the field) about 9 m, a couple of rows up
  return { x: kid.x + s * SQ * 9, y: 2.4, z: kid.z - SQ * 9 };
}

export interface TossBall {
  visible: boolean;
  pos: Vec3;
}

interface Agent {
  id: string;
  role: PlayerRole;
  team: number;
  person: SidePerson;
  pos: Vec3;
  vel: Vec3;
  facing: number;
  anim: AnimHint;
  hintAt: number;
  goal: Vec3 | null;
  goalFacing: number | null;
  speed: number;
  hasBall: boolean;
  /** free-form state of the behaviour (per role) */
  st: string;
  stAt: number;
  count: number;
  /** a ball kid's fetch target */
  spot?: Vec3;
  /** a coach's runner (where he was last seen) */
  target?: Vec3;
  /** play the one-shot clip backwards (sitting back down) */
  reverse?: boolean;
}

const WALK = 1.7, JOG = 3.6;

function personFor(role: string, team: number, i: number): SidePerson {
  const id = `x:${role}:${team}:${i}`;
  const h = hash01(id);
  const build = (['lean', 'athletic', 'athletic', 'stocky', 'heavy'] as const)[Math.floor(hash01(id, 1) * 5)];
  return {
    id,
    name: `${role} ${i + 1}`,
    number: 2 + Math.floor(hash01(id, 2) * 90),
    hand: h < 0.25 ? 'L' : 'R',
    physique: { heightM: 1.7 + hash01(id, 3) * 0.22, weightKg: 72 + hash01(id, 4) * 30, build },
    appearance: { skin: Math.floor(hash01(id, 5) * 6), hairColor: Math.floor(hash01(id, 6) * 6), hairStyle: Math.floor(hash01(id, 7) * 4), facialHair: hash01(id, 8) < 0.3 ? 1 : 0, seed: Math.floor(hash01(id, 9) * 1e6) },
  };
}

export interface SideOptions {
  /** the clips the characters' files carry (to know whether a seated pose exists) */
  hasClip?: (name: string) => boolean;
  layout?: Layout;
}

export class SideCast {
  layout: Layout;
  /** the ball tossed to a fan (drawn by the engine) */
  readonly toss: TossBall = { visible: false, pos: { x: 0, y: 0, z: 0 } };
  private hasClip: (n: string) => boolean;
  private agents = new Map<string, Agent>();
  private time = 0;
  private lastBatterId: string | null = null;
  private lastBallPos: Vec3 | null = null;
  private foulPending = false;
  private ballWasLive = false;
  private tossFlight: { from: Vec3; to: Vec3; t: number; T: number } | null = null;
  private events: GameEvent[] = [];
  private lastSigns = 0;
  private nobodyUpSince = 0;
  private onDeckSpawned = false;
  private battingSide: 0 | 1 = 0;
  private cheer: { team: 0 | 1; at: number } | null = null;
  private signaled = new Map<string, number>();
  /** categories the sim supplies itself, seen in `players[]` */
  private simRoles = new Set<PlayerRole>();
  enabled = true;

  constructor(opts: SideOptions = {}) {
    this.hasClip = opts.hasClip ?? (() => false);
    this.layout = opts.layout ?? makeLayout();
  }

  setLayout(l: Layout) {
    this.layout = l;
    this.agents.clear();
    this.simRoles.clear();
  }

  setClips(has: (name: string) => boolean) {
    this.hasClip = has;
  }

  /** the engine saw an event from the sim */
  note(e: GameEvent) {
    if (e.type === 'foul') this.foulPending = true;
    else if (e.type === 'pitch') {
      this.foulPending = false;
      this.ballWasLive = false;
    } else if (e.type === 'run' || e.type === 'homerun') this.cheer = { team: this.battingSide, at: this.time + 0.4 };
  }

  agent(id: string) {
    return this.agents.get(id);
  }

  /** advance by `dt` seconds; returns the made-up players (for the renderer) and any events they produced (also pushed through `emit`) */
  update(state: GameState, dt: number, emit?: (e: GameEvent) => void): PlayerSnap[] {
    if (!this.enabled) return [];
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;
    this.battingSide = (state.side?.battingSide ?? (state.half === 'top' ? 0 : 1)) as 0 | 1;
    const simIds = new Set<string>();
    for (const p of state.players) {
      simIds.add(p.id);
      this.simRoles.add(p.role); // sticky: once the sim sends a category it is never made up here again (no double crews between innings)
    }
    // a category the sim supplies is never made up here: drop anything this module made of it before the sim's people showed up
    for (const [id, a] of this.agents) {
      const r = a.role === 'coach1b' || a.role === 'coach3b' ? (this.simRoles.has('coach1b') || this.simRoles.has('coach3b') || this.simRoles.has('coach') ? a.role : null) : this.simRoles.has(a.role) ? a.role : null;
      if (r) this.agents.delete(id);
    }
    this.events = [];
    if (!this.simRoles.has('bench')) this.updateBench(state, dt);
    if (!this.simRoles.has('ondeck')) this.updateOnDeck(state, dt, simIds);
    if (!this.simRoles.has('coach1b') && !this.simRoles.has('coach3b') && !this.simRoles.has('coach')) this.updateCoaches(state, dt);
    if (!this.simRoles.has('ballkid')) this.updateKids(state, dt);
    this.updateToss(dt);
    const out: PlayerSnap[] = [];
    for (const a of this.agents.values()) if (!simIds.has(a.id) && a.pos.y > -50) out.push(this.snap(a));
    if (emit) for (const e of this.events) emit(e);
    return out;
  }

  /** events produced in the last update (for tests) */
  get lastEvents(): GameEvent[] {
    return this.events;
  }

  // ---- agents -----------------------------------------------------------------------------------

  private ensure(person: SidePerson, role: PlayerRole, team: number, pos: Vec3, facing: number, anim: AnimHint): Agent {
    let a = this.agents.get(person.id);
    if (!a) {
      a = { id: person.id, role, team, person, pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, facing, anim, hintAt: this.time, goal: null, goalFacing: null, speed: WALK, hasBall: false, st: 'idle', stAt: this.time, count: 0 };
      this.agents.set(person.id, a);
    }
    return a;
  }

  private hint(a: Agent, h: AnimHint) {
    if (a.anim !== h) {
      a.anim = h;
      a.hintAt = this.time;
    }
  }

  /** walk / jog toward the goal at the agent's speed, then stop; sets the hint and the facing */
  private move(a: Agent, dt: number, idle: AnimHint): boolean {
    a.vel.x = a.vel.z = 0;
    if (!a.goal) {
      if (a.goalFacing !== null) a.facing = turn(a.facing, a.goalFacing, 9 * dt);
      return true;
    }
    const dx = a.goal.x - a.pos.x, dz = a.goal.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.08) {
      a.pos.x = a.goal.x;
      a.pos.z = a.goal.z;
      a.goal = null;
      return true;
    }
    const sp = Math.min(a.speed, Math.max(0.6, d / 0.2));
    const step = Math.min(d, sp * dt);
    a.pos.x += (dx / d) * step;
    a.pos.z += (dz / d) * step;
    a.vel.x = (dx / d) * sp;
    a.vel.z = (dz / d) * sp;
    a.facing = turn(a.facing, Math.atan2(dx, dz), 8 * dt);
    this.hint(a, sp > 2.6 ? (a.role === 'ballkid' ? 'ballkid_run' : 'run') : 'walk');
    void idle;
    return false;
  }

  private snap(a: Agent): PlayerSnap {
    const dur = SIDE_DUR[a.anim];
    const el = this.time - a.hintAt;
    return {
      id: a.id,
      team: a.team,
      role: a.role,
      name: a.person.name,
      number: a.person.number,
      hand: a.person.hand,
      pos: { ...a.pos },
      facing: a.facing,
      vel: { ...a.vel },
      anim: a.anim,
      animTime: dur ? el : undefined,
      animProgress: dur ? (a.reverse ? Math.max(0, 1 - el / dur) : Math.min(1, el / dur)) : undefined,
      animDur: dur,
      hasBall: a.hasBall,
      physique: a.person.physique,
      appearance: a.person.appearance,
    };
  }

  // ---- bench ------------------------------------------------------------------------------------

  private updateBench(state: GameState, dt: number) {
    const bench = state.side?.bench;
    for (const team of [0, 1] as const) {
      const seats = this.layout.bench[team];
      const people = bench?.[team] ?? [];
      for (let i = 0; i < seats.length; i++) {
        const person = people[i] ?? personFor('bench', team, i);
        const seat = seats[i];
        const a = this.ensure(person, 'bench', team, seat.pos, seat.facing, 'bench_sit');
        a.pos.x = seat.pos.x;
        a.pos.y = seat.pos.y;
        a.pos.z = seat.pos.z;
        a.facing = seat.facing;
        a.vel.x = a.vel.z = 0;
        const el = this.time - a.stAt;
        switch (a.st) {
          case 'rise':
            if (el > (SIDE_DUR.bench_stand_up ?? 1.167)) {
              a.st = 'cheer';
              a.stAt = this.time;
              a.reverse = false;
              this.hint(a, 'bench_cheer');
            }
            break;
          case 'cheer':
            if (el > (SIDE_DUR.bench_cheer ?? 1.5)) {
              // sit back down: the stand-up clip played backwards
              a.st = 'down';
              a.stAt = this.time;
              a.reverse = true;
              a.anim = 'bench_stand_up';
              a.hintAt = this.time;
            }
            break;
          case 'down':
            if (el > (SIDE_DUR.bench_stand_up ?? 1.167)) {
              a.st = 'sit';
              a.reverse = false;
              this.hint(a, 'bench_sit');
            }
            break;
          default: {
            a.st = 'sit';
            this.hint(a, 'bench_sit');
            const c = this.cheer;
            // the batting team's reserves get to their feet for a run (a few of them, a moment apart)
            if (c && c.team === team && this.time >= c.at + hash01(a.id, 3) * 0.5 && this.time < c.at + 2 && hash01(a.id, 4) < 0.65 && this.hasClip('bench_stand_up')) {
              a.st = 'rise';
              a.stAt = this.time;
              a.reverse = false;
              this.hint(a, 'bench_stand_up');
            }
          }
        }
      }
    }
    void dt;
  }

  // ---- on deck ----------------------------------------------------------------------------------

  private updateOnDeck(state: GameState, dt: number, simIds: Set<string>) {
    const side = state.side;
    const batting = (side?.battingSide ?? (state.half === 'top' ? 0 : 1)) as 0 | 1;
    const person = side?.onDeck ?? personFor('ondeck', batting, 0);
    // the previous on-deck batter of the other team leaves (the sim has the fielders run on)
    for (const [id, a] of this.agents) if (a.role === 'ondeck' && id !== person.id) this.agents.delete(id);
    const circle = this.layout.onDeck[batting];
    const isNew = !this.agents.has(person.id);
    const a = this.ensure(person, 'ondeck', batting, circle, yawTo(circle, { x: 0, y: 0, z: 0 }), 'ondeck_ready');
    a.team = batting;
    if (isNew && this.onDeckSpawned) {
      // the next one up comes out of the dugout to the circle (the very first one is simply there)
      const sign = batting === 1 ? 1 : -1;
      a.pos = { x: sign * 17, y: 0, z: 2.5 };
      a.goal = { ...circle };
      a.goalFacing = yawTo(circle, { x: 0, y: 0, z: 0 });
      a.speed = WALK * 1.2;
      a.st = 'returning';
    }
    this.onDeckSpawned = true;
    const batter = state.players.find((p) => p.role === 'batter');
    const simSelf = state.players.find((p) => p.id === a.id);
    if (simSelf) {
      // he is the batter now: the sim moves him
      a.pos = { ...simSelf.pos };
      a.st = 'batter';
      return;
    }
    if (a.st === 'batter') {
      a.st = 'idle';
      a.pos = { ...circle };
    }
    const toPlate = this.layout.stepIn[batting];
    // once the play is dead and nobody is up yet he starts for the plate (the sim starts the batter exactly where he is heading);
    // while somebody is at bat, or the ball is still in play, he is at the circle taking swings
    if (batter) this.nobodyUpSince = this.time;
    const ballLive = state.ball.visible && Math.hypot(state.ball.vel.x, state.ball.vel.y, state.ball.vel.z) > 6;
    const wantPlate = !batter && !ballLive && this.time - this.nobodyUpSince > 1.0;
    if (wantPlate) {
      a.goal = { ...toPlate };
      a.speed = WALK * 1.3;
      a.st = 'walking';
    } else if (a.st === 'walking') {
      a.goal = { ...circle };
      a.goalFacing = yawTo(circle, { x: 0, y: 0, z: 0 });
      a.speed = WALK;
      a.st = 'returning';
    }
    const arrived = this.move(a, dt, 'ondeck_ready');
    if (arrived) {
      if (a.st === 'returning') a.st = 'idle';
      if (a.st === 'idle') {
        // practice swings every few seconds, with a different gap each time
        const gap = 5 + hash01(a.id, a.count) * 6;
        if (a.anim === 'ondeck_swing') {
          if (this.time - a.hintAt > (SIDE_DUR.ondeck_swing ?? 1)) this.hint(a, 'ondeck_ready');
        } else if (this.time - Math.max(a.hintAt, a.stAt) > gap) {
          a.count++;
          a.stAt = this.time;
          this.hint(a, 'ondeck_swing');
        } else this.hint(a, 'ondeck_ready');
        a.facing = turn(a.facing, yawTo(a.pos, { x: 0, y: 0, z: 18.4 }), 6 * dt);
      } else this.hint(a, 'ondeck_ready');
    }
  }

  // ---- coaches ----------------------------------------------------------------------------------

  private updateCoaches(state: GameState, dt: number) {
    const lay = this.layout;
    const batting = (state.side?.battingSide ?? (state.half === 'top' ? 0 : 1)) as 0 | 1;
    const defs = [
      { role: 'coach1b' as const, base: 1 as const, pos: lay.coach.first, bag: BASES[0] },
      { role: 'coach3b' as const, base: 3 as const, pos: lay.coach.third, bag: BASES[2] },
    ];
    const ball = state.ball;
    const ballSpeed = ball.visible ? Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z) : 0;
    const ballHome = ball.visible ? Math.hypot(ball.pos.x, ball.pos.z) : 0;
    const towardHome = ball.visible && ball.vel.z * ball.pos.z + ball.vel.x * ball.pos.x < 0;
    const runners = state.players.filter((p) => p.role === 'runner');
    for (const d of defs) {
      const person = personFor(d.role, batting, 0);
      person.id = `x:${d.role}`;
      const a = this.ensure(person, d.role, batting, d.pos, yawTo(d.pos, { x: 0, y: 0, z: 0 }), 'coach_ready');
      a.team = batting;
      a.role = d.role;
      a.pos.y = 0;
      // the one-shot gestures run their length, then he is ready again
      const dur = SIDE_DUR[a.anim];
      if (dur && this.time - a.hintAt > dur) {
        // a windmill goes on until the runner is past; the other gestures end in the ready stance
        const goOn = (a.anim === 'coach_go' || a.anim === 'coach_go_loop') && a.target && dist2(a.target, { x: d.bag.x, y: 0, z: d.bag.z }) > 2.5 && this.time - a.hintAt < 6;
        this.hint(a, goOn ? 'coach_go_loop' : 'coach_ready');
      }
      const bagV = { x: d.bag.x, y: 0, z: d.bag.z };
      // a runner coming to this base
      let target: PlayerSnap | null = null;
      let td = 1e9;
      for (const r of runners) {
        const dd = dist2(r.pos, bagV);
        const sp = Math.hypot(r.vel.x, r.vel.z);
        const toward = (bagV.x - r.pos.x) * r.vel.x + (bagV.z - r.pos.z) * r.vel.z > 0;
        if (dd < 16 && sp > 1.5 && toward && dd < td) {
          td = dd;
          target = r;
        }
      }
      a.target = target ? { ...target.pos } : undefined;
      if (target && td < 11) {
        const key = `${d.role}:${target.id}`;
        const stamp = this.signaled.get(key) ?? -99;
        if (this.time - stamp > 6) {
          this.signaled.set(key, this.time);
          const sig = coachDecision({ base: d.base, runnerDistance: td, ballDistanceToHome: ballHome, ballSpeed, ballTowardHome: towardHome });
          const h: AnimHint = sig === 'stop' ? 'coach_stop' : sig === 'go' ? 'coach_go' : sig === 'advance' ? 'coach_advance' : 'coach_slide';
          this.hint(a, h);
          this.events.push({ type: 'coach_signal', coachId: a.id, signal: sig, runnerId: target.id, base: d.base === 1 ? 1 : 3, pos: { ...a.pos } });
        }
      }
      // face the runner coming in, otherwise the plate
      const face = target && td < 16 ? target.pos : { x: 0, y: 0, z: 0 };
      a.facing = turn(a.facing, yawTo(a.pos, face), 7 * dt);
      // signs to the batter between pitches, now and then
      if (a.anim === 'coach_ready' && d.base === 3 && !target && this.time - this.lastSigns > 13 && ballSpeed < 1 && state.players.some((p) => p.role === 'batter')) {
        this.lastSigns = this.time;
        this.hint(a, 'coach_signs');
        this.events.push({ type: 'coach_signal', coachId: a.id, signal: 'signs', pos: { ...a.pos } });
      }
      a.vel.x = a.vel.z = 0;
    }
  }

  // ---- ball kids --------------------------------------------------------------------------------

  private updateKids(state: GameState, dt: number) {
    const lay = this.layout;
    const ball = state.ball;
    if (ball.visible && ball.pos.y > 0.05) {
      this.lastBallPos = { ...ball.pos };
      this.ballWasLive = true;
    }
    const settled = !ball.visible || (ball.pos.y < 0.3 && Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z) < 1.2);
    const kids: Agent[] = [];
    for (let i = 0; i < lay.kids.length; i++) {
      const seat = lay.kids[i];
      const person = personFor('ballkid', 1, i);
      const a = this.ensure(person, 'ballkid', 1, seat, yawTo(seat, { x: 0, y: 0, z: 20 }), 'ballkid_sit');
      kids.push(a);
    }
    // a foul ball has come down in reach of a kid: the nearest one fetches it
    if (this.foulPending && this.ballWasLive && settled && this.lastBallPos) {
      const spot = this.lastBallPos;
      this.foulPending = false;
      this.ballWasLive = false;
      // down in foul ground (not up in the seats) and not behind the plate, where the catcher and the umpire deal with it
      const foul = Math.abs(spot.x) > spot.z - 1 && spot.z > 2 && spot.y < 2 && Math.abs(spot.x) < 70 && spot.z < 85;
      if (foul) {
        let best: Agent | null = null, bd = 1e9;
        for (const k of kids) {
          if (k.st !== 'sit' && k.st !== 'idle') continue;
          const dd = dist2(k.pos, spot);
          if (dd < bd) { bd = dd; best = k; }
        }
        if (best && bd < 70) {
          best.st = 'fetch';
          best.stAt = this.time;
          best.goal = { x: spot.x, y: 0, z: spot.z };
          best.speed = JOG;
          best.count++;
          best.hasBall = false;
          this.hint(best, 'ballkid_run');
          best.spot = { ...spot };
        }
      } else this.ballWasLive = false;
    }
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const seat = lay.kids[i];
      const spot = k.spot;
      switch (k.st) {
        case 'idle':
        case 'sit': {
          k.st = 'sit';
          k.goal = null;
          k.pos.y = 0;
          this.hint(k, 'ballkid_sit');
          k.facing = turn(k.facing, yawTo(k.pos, { x: 0, y: 0, z: 20 }), 5 * dt);
          k.vel.x = k.vel.z = 0;
          break;
        }
        case 'fetch': {
          if (this.move(k, dt, 'ballkid_sit')) {
            k.st = 'pickup';
            k.stAt = this.time;
            this.hint(k, 'ballkid_pickup');
            if (spot) k.facing = yawTo(k.pos, spot);
          }
          break;
        }
        case 'pickup': {
          k.vel.x = k.vel.z = 0;
          if (this.time - k.stAt > KID_PICKUP_AT && !k.hasBall) {
            k.hasBall = true;
            this.events.push({ type: 'ball_kid_retrieve', kidId: k.id, pos: spot ? { ...spot } : { ...k.pos } });
          }
          if (this.time - k.stAt > (SIDE_DUR.ballkid_pickup ?? 1.5)) {
            k.st = 'return';
            k.goal = { ...seat };
            k.goalFacing = yawTo(seat, { x: 0, y: 0, z: 20 });
            k.speed = WALK * 1.4;
          }
          break;
        }
        case 'return': {
          if (this.move(k, dt, 'ballkid_sit')) {
            // at his spot: most of the time he gives the ball to a fan
            const toss = hash01(k.id, k.count) < 0.6;
            k.st = toss ? 'toss' : 'hold';
            k.stAt = this.time;
            if (toss) {
              k.facing = yawTo(k.pos, fanSeat(k.pos));
              this.hint(k, 'ballkid_toss');
            }
          }
          break;
        }
        case 'toss': {
          k.vel.x = k.vel.z = 0;
          const dur = SIDE_DUR.ballkid_toss ?? 1.0;
          // the ball leaves the hand about 60 % into the throwing motion
          if (k.hasBall && this.time - k.stAt > KID_RELEASE_AT) {
            k.hasBall = false;
            const from = { x: k.pos.x, y: 1.5, z: k.pos.z };
            const to = fanSeat(k.pos);
            this.tossFlight = { from, to, t: 0, T: 1.25 };
            this.events.push({ type: 'ball_tossed_to_fan', kidId: k.id, pos: { ...to }, from });
          }
          if (this.time - k.stAt > dur + 0.2) {
            k.st = 'sit';
            k.hasBall = false;
          }
          break;
        }
        case 'hold': {
          k.vel.x = k.vel.z = 0;
          if (this.time - k.stAt > 2.2) {
            k.hasBall = false;
            k.st = 'sit';
          } else this.hint(k, 'ballkid_sit');
          break;
        }
      }
    }
  }

  private updateToss(dt: number) {
    const f = this.tossFlight;
    if (!f) {
      this.toss.visible = false;
      return;
    }
    f.t += dt;
    const u = Math.min(1, f.t / f.T);
    const g = 9.81;
    // ballistic arc from `from` to `to` in T seconds
    this.toss.pos.x = f.from.x + (f.to.x - f.from.x) * u;
    this.toss.pos.z = f.from.z + (f.to.z - f.from.z) * u;
    this.toss.pos.y = f.from.y + ((f.to.y - f.from.y) / f.T + 0.5 * g * f.T) * f.t - 0.5 * g * f.t * f.t;
    this.toss.visible = f.t < f.T + 0.4;
    if (f.t >= f.T + 0.4) this.tossFlight = null;
  }
}

function turn(cur: number, want: number, maxStep: number): number {
  let d = want - cur;
  d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
  return Math.abs(d) <= maxStep ? want : cur + Math.sign(d) * maxStep;
}

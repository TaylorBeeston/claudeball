/**
 * People around the field who are not players: the base coaches (who call the runners), two ball kids (who fetch foul balls that stop in foul ground and
 * sometimes toss one to a fan) and the bat boy (who brings back the bat a hitter drops running to first). They are physical: they walk, they stay out of
 * the live play, and what they signal comes from the real state of the play.
 */
import { PENDING } from './decisions';
import type { CoachDecision, CoachRequest } from './decisions';
import { ask, situationOf } from './dispatch';
import { emit } from './events';
import { newFlags, stepBall } from './ball';
import { BASE_POS, isFairXZ } from './field';
import { clamp } from './math';
import type { AnimHint, CoachSignalKind, TeamSide } from './types';
import { ballKidSpot, batBoySpot, coachBox, dugDoor } from './venue';
import type { RunnerRT, StaffRT, World } from './world';
import { TICK, secToTicks } from './world';

const COACH_HINT: Record<'go' | 'stop' | 'advance' | 'slide', AnimHint> = { go: 'coach_go', stop: 'coach_stop', advance: 'coach_advance', slide: 'coach_slide' };
const COACH_KIND: Record<'go' | 'stop' | 'advance' | 'slide', CoachSignalKind> = { go: 'go', stop: 'stop', advance: 'advance', slide: 'slide' };

function mk(id: string, name: string, role: StaffRT['role'], team: TeamSide, x: number, z: number, anim: AnimHint, active: boolean): StaffRT {
  return { id, name, role, team, jersey: 0, x, z, vx: 0, vz: 0, facing: Math.atan2(-x, 20 - z), goal: null, speed: 4.5, anim, animStart: 0, animUntil: 0, active, task: 'idle', taskUntil: 0, call: null, homeX: x, homeZ: z };
}

/** Both teams' coaches (the batting side's stand in their boxes), two ball kids, a bat boy for each team. */
export function initStaff(w: World): void {
  const staff: StaffRT[] = [];
  for (const side of ['home', 'away'] as const) {
    const bat = w.battingTeam.side === side;
    for (const base of [1, 3] as const) {
      const box = coachBox(base);
      const door = dugDoor(side);
      staff.push(mk(`coach-${side}-${base}b`, `${side === 'home' ? 'Home' : 'Visiting'} ${base}B coach`, base === 3 ? 'coach3b' : 'coach1b', side, bat ? box.x : door.x, bat ? box.z : door.z, 'coach_ready', bat));
    }
    const bb = batBoySpot(side);
    staff.push(mk(`batboy-${side}`, `${side === 'home' ? 'Home' : 'Visiting'} bat boy`, 'batboy', side, bb.x, bb.z, 'ballkid_idle', bat));
  }
  for (const base of [1, 3] as const) {
    const s = ballKidSpot(base);
    staff.push(mk(`ballkid-${base}b`, `Ball kid (${base}B line)`, 'ballkid', base === 3 ? 'home' : 'away', s.x, s.z, 'ballkid_sit', true));
  }
  w.staff = staff;
}

const coachBoxOf = (s: StaffRT) => coachBox(s.role === 'coach3b' ? 3 : 1);

function setAnimS(w: World, s: StaffRT, anim: AnimHint, sec: number): void {
  s.anim = anim;
  s.animStart = w.tick;
  s.animUntil = w.tick + secToTicks(sec);
}

function moveStaff(s: StaffRT): void {
  const g = s.goal;
  let tx = 0;
  let tz = 0;
  if (g) {
    const dx = g.x - s.x;
    const dz = g.z - s.z;
    const d = Math.hypot(dx, dz);
    const sp = Math.min(s.speed, Math.sqrt(2 * 5 * Math.max(0, d - 0.03)));
    if (d > 0.03) {
      tx = (dx / d) * sp;
      tz = (dz / d) * sp;
    }
  }
  let dvx = tx - s.vx;
  let dvz = tz - s.vz;
  const dv = Math.hypot(dvx, dvz);
  const maxDv = 6 * TICK;
  if (dv > maxDv) {
    dvx *= maxDv / dv;
    dvz *= maxDv / dv;
  }
  s.vx += dvx;
  s.vz += dvz;
  s.x += s.vx * TICK;
  s.z += s.vz * TICK;
  const sp = Math.hypot(s.vx, s.vz);
  if (sp > 0.8) s.facing = Math.atan2(s.vx, s.vz);
}

const near = (s: StaffRT, x: number, z: number, r = 0.35) => Math.hypot(s.x - x, s.z - z) < r;

// ---------------------------------------------------------------------------------------------
// base coaches
// ---------------------------------------------------------------------------------------------

/** Which coach calls a runner (null: nobody does). */
function coachFor(w: World, r: RunnerRT): '1b' | '3b' | null {
  if (!w.play || w.play.dead || r.state !== 'live' || r.dead) return null;
  if (r.base === 3 || r.target === 3 || (r.base === 2 && r.target >= 3)) return '3b';
  // the batter-runner who is about to reach / has touched first
  if (r.origin === 0 && ((r.base === 1 && r.target <= 2) || (r.base === 0 && r.target === 1 && Math.hypot(r.p.x - BASE_POS[1].x, r.p.z - BASE_POS[1].z) < 12))) return '1b';
  return null;
}

/** The runner request as the coach sees it. */
function buildCoachRequest(w: World, r: RunnerRT, which: '1b' | '3b', est: number[], eta: number[], ball: CoachRequest['ball']): Omit<CoachRequest, 'id' | 'kind' | 'side' | 'time' | 'state'> {
  const ballB = w.ball;
  return {
    situation: situationOf(w),
    coach: which,
    coachId: `coach-${w.battingTeam.side}-${which}`,
    runner: r.p.info,
    base: r.base,
    heading: r.target,
    want: r.want,
    pos: { x: r.p.x, y: 0, z: r.p.z },
    speed: Math.hypot(r.p.vx, r.p.vz),
    forced: false,
    ball,
    ballToBase: est,
    runnerToBase: eta,
    throwComing: ballB.mode === 'thrown' && ballB.throwBase === r.target && r.target >= 1,
  };
}

/**
 * The coach's own read of the play, from the same state the runner reads but with his own judgement error (drawn once per runner and play) and from where
 * he stands: `go` / `stop` for the runner at or heading for third, `advance` / `stop` for a batter-runner at first, `slide` when a throw is coming to his base.
 * `suggest(bias)` is the built-in runner logic evaluated with a given judgement error.
 */
export function aiCoach(w: World, r: RunnerRT, which: '1b' | '3b', suggest: (bias: number) => number): CoachDecision {
  const want = suggest(r.coachBias);
  const ball = w.ball;
  const throwComing = ball.mode === 'thrown' && ball.throwBase === r.target && r.target >= 1;
  const bp = r.target >= 1 ? BASE_POS[r.target] : null;
  const dBase = bp ? Math.hypot(r.p.x - bp.x, r.p.z - bp.z) : 99;
  if (which === '3b') {
    if (want >= 4) return { call: throwComing && r.target === 4 && dBase < 9 ? 'slide' : 'go' };
    return { call: throwComing && r.target === 3 && dBase < 9 ? 'slide' : 'stop' };
  }
  // first-base coach: the batter-runner rounding first
  if (want >= 2) return { call: throwComing && r.target === 2 && dBase < 9 ? 'slide' : 'advance' };
  if (r.base === 0) return { call: throwComing && r.target === 1 && dBase < 9 ? 'slide' : 'none' };
  return { call: 'stop' };
}

/**
 * Consult the coach for a runner before his own decision is applied. Returns PENDING while a provider is deliberating, the call otherwise (`null` when no
 * coach is involved). The call is also what the coach signals: the signal is emitted when it changes.
 */
export function consultCoach(w: World, r: RunnerRT, build: () => { est: number[]; eta: number[]; ball: CoachRequest['ball']; suggest: (bias: number) => number }): CoachDecision | typeof PENDING | null {
  const which = coachFor(w, r);
  if (!which) return null;
  // a side whose runners are played by a provider (not the built-in AI) is not overruled by the built-in coach
  const prov = w.dec.providers[w.battingTeam.side];
  if (prov?.runner && !prov.coach) return null;
  const staff = w.staff.find((s) => s.team === w.battingTeam.side && s.role === (which === '3b' ? 'coach3b' : 'coach1b'));
  if (!staff || !staff.active) return null;
  const b = build();
  const d = ask(w, `coach:${r.p.info.id}`, 'coach', w.battingTeam.side, () => buildCoachRequest(w, r, which, b.est, b.eta, b.ball), { r, which, suggest: b.suggest });
  if (d === PENDING) return PENDING;
  // the runner decides once per runner and play whether he takes the coach's word (a smart runner trusts his own read a little more)
  if (r.coachObey === null) r.coachObey = w.aiRng.next() < clamp(0.92 - 0.003 * (r.p.info.ratings.iq - 50), 0.75, 0.97);
  if (d.call !== r.coachCall) {
    r.coachCall = d.call;
    if (d.call !== 'none') signal(w, staff, d.call, r);
  }
  return d;
}

function signal(w: World, c: StaffRT, call: 'go' | 'stop' | 'advance' | 'slide', r: RunnerRT): void {
  setAnimS(w, c, COACH_HINT[call], 1.4);
  c.call = { runnerId: r.p.info.id, kind: COACH_KIND[call] };
  emit(w, { type: 'coachSignal', coachId: c.id, kind: COACH_KIND[call], runnerId: r.p.info.id, base: r.target });
}

/** The runner's own `want`, changed by the coach's call if he takes it. */
export function applyCoachCall(r: RunnerRT, want: number, cd: CoachDecision | null): number {
  if (!cd || cd.call === 'none' || !r.coachObey) return want;
  switch (cd.call) {
    case 'go':
      return Math.max(want, 4);
    case 'stop':
      return r.base >= 3 ? r.base : r.base === 0 ? Math.min(want, 1) : Math.min(want, Math.max(r.target, r.base));
    case 'advance':
      return Math.max(want, 2);
    default:
      return want;
  }
}

// ---------------------------------------------------------------------------------------------
// per tick
// ---------------------------------------------------------------------------------------------

export function tickStaff(w: World): void {
  if (!w.staff.length) return;
  const batSide = w.battingTeam.side;
  const live = w.phase === 'inPlay' && !!w.play && !w.play.dead && (w.ball.mode === 'batted' || w.ball.mode === 'loose' || w.ball.mode === 'thrown');
  for (const s of w.staff) {
    switch (s.role) {
      case 'coach1b':
      case 'coach3b':
        tickCoach(w, s, batSide);
        break;
      case 'ballkid':
        tickKid(w, s, live);
        break;
      case 'batboy':
        tickBatBoy(w, s, batSide);
        break;
    }
    if (s.active || s.vx || s.vz) moveStaff(s);
  }
  tickDeadBall(w);
}

function tickCoach(w: World, s: StaffRT, batSide: TeamSide): void {
  const box = coachBoxOf(s);
  if (s.team === batSide) {
    if (!s.active) {
      // he comes out of the dugout to his box
      s.active = true;
    }
    s.goal = { x: box.x, z: box.z };
    s.speed = 3.2;
    if (near(s, box.x, box.z, 0.6)) {
      // watching the batter; between pitches the third-base coach gives signs
      s.facing = Math.atan2(-s.x, 14 - s.z);
      if (w.tick >= s.animUntil && s.anim !== 'coach_ready') {
        s.anim = 'coach_ready';
        s.call = null;
      }
      signsFlavour(w, s);
    }
  } else if (s.active) {
    // the half is over: he goes in
    const door = dugDoor(s.team);
    s.goal = { x: door.x, z: door.z };
    s.speed = 3.2;
    if (near(s, door.x, door.z, 1.2)) {
      s.active = false;
      s.goal = null;
      s.vx = s.vz = 0;
    }
  }
}

/** Between pitches the third-base coach touches cap and belt: on a steal, a bunt or a hit-and-run in the sim's own calls (and as flavour with runners on). */
function signsFlavour(w: World, s: StaffRT): void {
  if (s.role !== 'coach3b' || w.phase !== 'prePitch' || w.tick < s.animUntil) return;
  const key = `${w.batter?.info.id}:${w.paPitches}`;
  if ((s as StaffRT & { signKey?: string }).signKey === key) return;
  (s as StaffRT & { signKey?: string }).signKey = key;
  const steal = w.prep.steal && w.prep.steal.go ? w.prep.steal.r : null;
  const runnersOn = w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead);
  if (steal || w.buntPlan || (runnersOn && w.propRng.next() < 0.5)) {
    setAnimS(w, s, 'coach_signs', 1.6);
    emit(w, { type: 'coachSignal', coachId: s.id, kind: 'signs', ...(steal ? { runnerId: steal.p.info.id } : w.batter ? { runnerId: w.batter.info.id } : {}) });
  }
}

// ---------------------------------------------------------------------------------------------
// ball kids and the foul ball
// ---------------------------------------------------------------------------------------------

/** A ball nobody holds is out of play: if it is in foul ground near a ball kid, it is fetched. */
export function spawnDeadBall(w: World): void {
  const b = w.ball.body;
  if (w.deadBall || w.ball.mode === 'thrown' || isFairXZ(b.x, b.z)) return;
  // (the ball keeps flying from where it was when the foul was called; it only matters if it comes down in foul ground near a ball kid)
  w.deadBall = { body: { ...b }, flags: newFlags(), state: 'rolling', kid: null, since: w.tick };
}

function tickDeadBall(w: World): void {
  const d = w.deadBall;
  if (!d) return;
  const b = d.body;
  if (d.state === 'rolling') {
    stepBall(b, TICK, w.env, w.propRng, d.flags, true);
    // over the fence or into the stands / behind the backstop: a fan has it
    if (d.flags.overFence || b.z < -14 || Math.hypot(b.x, b.z) > 95 || (b.z < 2 && b.y < 0.5 && b.rolling)) {
      w.deadBall = null;
      return;
    }
    if (b.rolling && Math.hypot(b.vx, b.vz) < 0.15) {
      b.vx = b.vz = 0;
      d.state = 'resting';
      const near = w.staff.filter((s) => s.role === 'ballkid').some((s) => Math.hypot(s.x - b.x, s.z - b.z) < 55);
      if (!near) w.deadBall = null;
    }
  } else if (d.state === 'tossed' && d.tossTo) {
    const T = 1.1;
    const u = clamp((w.tick - d.since) / secToTicks(T), 0, 1);
    const kid = w.staff.find((s) => s.id === d.kid);
    const x0 = kid ? kid.x : b.x;
    const z0 = kid ? kid.z : b.z;
    b.x = x0 + (d.tossTo.x - x0) * u;
    b.z = z0 + (d.tossTo.z - z0) * u;
    b.y = 1.4 + 3.2 * 4 * u * (1 - u) + 1.0 * u;
    if (u >= 1) w.deadBall = null;
  }
}

function tickKid(w: World, s: StaffRT, live: boolean): void {
  const d = w.deadBall;
  const hand = () => ({ x: s.x + Math.sin(s.facing) * 0.35, y: 1.0, z: s.z + Math.cos(s.facing) * 0.35 });
  // out of the way of a ball in play
  const b = w.ball.body;
  const threatened = live && Math.hypot(b.x - s.x, b.z - s.z) < 24;
  if (threatened && s.task !== 'retreat' && (s.task === 'idle' || s.task === 'sit' || s.task === 'run')) {
    s.task = 'retreat';
    const away = Math.hypot(s.x, s.z) || 1;
    s.goal = { x: s.homeX + (s.x / away) * 3, z: s.homeZ + (s.z / away) * 3 };
    s.speed = 5.5;
    setAnimS(w, s, 'ballkid_run', 1.2);
  }
  switch (s.task) {
    case 'retreat':
      if (!live && w.tick - s.taskUntil > 0) {
        s.task = 'idle';
      }
      s.taskUntil = live ? w.tick : s.taskUntil;
      break;
    case 'idle':
    case 'sit': {
      if (!near(s, s.homeX, s.homeZ, 0.3)) {
        s.goal = { x: s.homeX, z: s.homeZ };
        s.speed = 3.5;
      } else {
        s.goal = null;
        if (s.anim !== 'ballkid_sit' && w.tick >= s.animUntil) setAnimS(w, s, 'ballkid_sit', 60);
      }
      if (d && !d.kid && !live && d.state === 'resting') {
        const other = w.staff.filter((q) => q.role === 'ballkid' && q !== s)[0];
        const mine = Math.hypot(s.x - d.body.x, s.z - d.body.z);
        if (mine <= 55 && (!other || mine <= Math.hypot(other.x - d.body.x, other.z - d.body.z))) {
          d.kid = s.id;
          s.task = 'run';
        }
      }
      break;
    }
    case 'run': {
      if (!d || d.kid !== s.id) {
        s.task = 'idle';
        break;
      }
      s.goal = { x: d.body.x, z: d.body.z };
      s.speed = 5.2;
      if (s.anim !== 'ballkid_run' || w.tick >= s.animUntil) setAnimS(w, s, 'ballkid_run', 2);
      if (Math.hypot(s.x - d.body.x, s.z - d.body.z) < 0.7 && d.state === 'resting') {
        s.goal = null;
        s.task = 'pickup';
        s.taskUntil = w.tick + secToTicks(1.0);
        setAnimS(w, s, 'ballkid_pickup', 1.0);
        s.facing = Math.atan2(d.body.x - s.x, d.body.z - s.z);
      }
      break;
    }
    case 'pickup':
      if (w.tick >= s.taskUntil && d) {
        d.state = 'carried';
        emit(w, { type: 'ballKidRetrieve', ballKidId: s.id, pos: { x: d.body.x, y: 0.1, z: d.body.z } });
        // sometimes he tosses it to a fan in the stands behind him, otherwise he takes it back to the umpire's bag
        s.task = w.propRng.next() < 0.4 ? 'toFan' : 'return';
        s.goal = { x: s.homeX, z: s.homeZ };
        s.speed = 4.0;
        s.taskUntil = w.tick + secToTicks(0.6);
      }
      break;
    case 'toFan':
    case 'return':
      if (d && d.state === 'carried') {
        const h = hand();
        d.body.x = h.x;
        d.body.y = h.y;
        d.body.z = h.z;
      }
      if (near(s, s.homeX, s.homeZ, 0.5) && w.tick >= s.taskUntil) {
        s.goal = null;
        if (s.task === 'toFan' && d) {
          const away = Math.hypot(s.homeX, s.homeZ) || 1;
          const to = { x: s.homeX + (s.homeX / away) * 6.5, z: s.homeZ + (s.homeZ / away) * 2.5 };
          s.facing = Math.atan2(to.x - s.x, to.z - s.z);
          d.state = 'tossed';
          d.tossTo = to;
          d.kid = s.id;
          d.since = w.tick;
          setAnimS(w, s, 'ballkid_toss', 1.0);
          emit(w, { type: 'ballTossedToFan', ballKidId: s.id, pos: { x: to.x, y: 4.0, z: to.z } });
          s.task = 'tossing';
          s.taskUntil = w.tick + secToTicks(1.1);
        } else {
          w.deadBall = null; // into the ball bag
          s.task = 'idle';
        }
      }
      break;
    case 'tossing':
      if (w.tick >= s.taskUntil) s.task = 'idle';
      break;
    default:
      s.task = 'idle';
  }
}

// ---------------------------------------------------------------------------------------------
// bat boy
// ---------------------------------------------------------------------------------------------

function tickBatBoy(w: World, s: StaffRT, batSide: TeamSide): void {
  const spot = batBoySpot(s.team);
  if (s.team !== batSide) {
    if (s.active) {
      const door = dugDoor(s.team);
      s.goal = { x: door.x, z: door.z };
      s.speed = 3.5;
      if (near(s, door.x, door.z, 1.2)) {
        s.active = false;
        s.vx = s.vz = 0;
        s.goal = null;
      }
    }
    return;
  }
  if (!s.active) s.active = true;
  const bat = w.batDown;
  switch (s.task) {
    case 'idle':
      if (bat && (w.phase === 'playOver' || w.phase === 'prePitch')) {
        s.task = 'fetch';
      } else {
        s.goal = { x: spot.x, z: spot.z };
        s.speed = 3.5;
        if (near(s, spot.x, spot.z, 0.4) && w.tick >= s.animUntil) setAnimS(w, s, 'ballkid_idle', 30);
      }
      break;
    case 'fetch':
      if (!w.batDown) {
        s.task = 'idle';
        break;
      }
      s.goal = { x: w.batDown.x, z: w.batDown.z };
      s.speed = 5;
      if (s.anim !== 'ballkid_run' || w.tick >= s.animUntil) setAnimS(w, s, 'ballkid_run', 2);
      if (Math.hypot(s.x - w.batDown.x, s.z - w.batDown.z) < 0.7) {
        s.goal = null;
        s.task = 'pick';
        s.taskUntil = w.tick + secToTicks(0.9);
        setAnimS(w, s, 'ballkid_pickup', 0.9);
      }
      break;
    case 'pick':
      if (w.tick >= s.taskUntil) {
        if (w.batDown) emit(w, { type: 'batBoyRetrieve', batBoyId: s.id, pos: { x: w.batDown.x, y: 0.05, z: w.batDown.z } });
        w.batDown = null;
        s.task = 'return';
      }
      break;
    case 'return':
      s.goal = { x: spot.x, z: spot.z };
      s.speed = 4.5;
      if (near(s, spot.x, spot.z, 0.4)) s.task = 'idle';
      break;
    default:
      s.task = 'idle';
  }
}

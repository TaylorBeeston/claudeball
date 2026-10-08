import { groundHeight } from './field';
import { BENCH_SIT_LIFT, dugoutFloorY } from './venue';
import { umpStance } from './umpires';
import { teamStats } from './stats';
import { routineDetail, ticOf } from './tempo';
import type { World, PlayerRT } from './world';
import { TICK } from './world';
import type {
  BallSnapshot,
  BatSnapshot,
  GameStateSnapshot,
  PlayerInfo,
  PlayerSnapshot,
} from './types';

// ---------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------

function animOf(w: World, p: PlayerRT): { anim: PlayerSnapshot['anim']; t: number } {
  if (w.tick < p.animUntil) return { anim: p.anim, t: Math.min(1, (w.tick - p.animStart) / Math.max(1, p.animDur)) };
  if (p.anim === 'celebrate' && w.gameOver) return { anim: 'celebrate', t: 0 };
  const sp = Math.hypot(p.vx, p.vz);
  if (p.dug === 'bench' && !p.route.length) return { anim: 'bench_sit', t: 0 };
  if (p.dug === 'deck' && sp < 0.3) return { anim: 'ondeck_ready', t: 0 };
  if (p.gait === 'walk' && sp > 0.25) return { anim: 'walk', t: 0 };
  if (sp > 1.2) return { anim: p.gait === 'trot' ? 'trot' : p.gait === 'turn' ? 'run_turn' : 'run', t: 0 };
  return { anim: 'idle', t: 0 };
}

/** Height of the feet above the field's datum: the ground at his spot (the mound is 10 in up) plus the height of a wall leap. */
function feetY(w: World, p: PlayerRT): number {
  const L = p.leap;
  const pit = dugoutFloorY(p.x, p.z);
  const ground = pit < 0 ? pit : groundHeight(p.x, p.z); // on the mound the pitcher stands 10 inches up; in the dugout he is below the field
  if (!L) return ground;
  const u = (w.tick - L.t0) / L.dur;
  return ground + (u > 0 && u < 1 ? 4 * L.h * u * (1 - u) : 0);
}

/** Seconds until the ball leaves his hand while a throwing motion is under way (a play's throw, a casual return, a warm-up toss); undefined otherwise. */
function releaseIn(w: World, p: PlayerRT): number | undefined {
  if (p.plan.releaseAt > w.tick) return (p.plan.releaseAt - w.tick) * TICK;
  const r = w.ret;
  if (r && r.from === p && r.motion && r.stage !== 'flight') return Math.max(0, (r.until - w.tick) * TICK);
  const t = p.tossAt;
  if (t !== undefined && t >= w.tick) return (t - w.tick) * TICK;
  return undefined;
}

function snapPlayer(w: World, p: PlayerRT, role: PlayerSnapshot['role']): PlayerSnapshot {
  const a = animOf(w, p);
  return {
    id: p.info.id,
    name: p.info.name,
    team: p.team.side,
    role,
    position: (p.fieldPos ?? p.info.primaryPosition) as PlayerSnapshot['position'],
    jersey: p.info.jersey,
    // seated, the root is the floor below the seat centre for a seat of the clip's height: on the taller dugout bench it is lifted by the difference
    pos: { x: p.x, y: feetY(w, p) + (a.anim === 'bench_sit' ? BENCH_SIT_LIFT : 0), z: p.z },
    vel: { x: p.vx, y: 0, z: p.vz },
    facing: p.facing,
    anim: a.anim,
    animT: a.t,
    hasBall: p.hasBall,
    bats: p.info.bats,
    throws: p.info.throws,
    height: p.info.height,
    ratings: p.info.ratings,
    physique: p.info.physique,
    appearance: p.info.appearance,
    gloveTarget: p.gloveTarget ? { ...p.gloveTarget } : null,
    gloveEta: p.gloveTarget ? Math.max(0, (p.gloveAt - w.tick) * TICK) : 0,
    catchIn: p.gloveTarget ? Math.max(0, (p.gloveAt - w.tick) * TICK) : 0,
    releaseIn: releaseIn(w, p),
    pitchType: p === w.pitcher ? (w.prep.pitch?.pitchType ?? null) : undefined,
    gloveHand: p.info.throws === 'R' ? 'L' : 'R',
    tic: role === 'batter' || role === 'ondeck' ? ticOf(p) : undefined,
    delivery: p.info.delivery ? { ...p.info.delivery, fromStretch: p === w.pitcher && w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead) } : undefined,
  };
}

/** What the game is doing when it is not a pitch or a play (the camera director's and the announcers' cue). */
function phaseDetail(w: World): string | null {
  if (w.change) return 'pitchingChange';
  if (w.visit) return 'moundVisit';
  if (w.review) return 'review';
  if (w.phase === 'halfBreak' && w.breakShow) return 'break';
  return routineDetail(w);
}

export function snapshot(w: World): GameStateSnapshot {
  const players: PlayerSnapshot[] = [];
  const seen = new Set<PlayerRT>();
  for (const [pos, p] of w.fieldingTeam.defense) {
    if (!p.onField) continue;
    seen.add(p);
    players.push(snapPlayer(w, p, pos === 'P' ? 'pitcher' : pos === 'C' ? 'catcher' : 'fielder'));
  }
  for (const r of w.runners) {
    if (seen.has(r.p) || !r.p.onField) continue;
    seen.add(r.p);
    players.push(snapPlayer(w, r.p, 'runner'));
  }
  for (const l of w.leavers) {
    if (seen.has(l.p) || !l.p.onField) continue;
    seen.add(l.p);
    players.push(snapPlayer(w, l.p, l.p.role === 'batter' ? 'runner' : l.p.role));
  }
  for (const r of w.exiting) {
    if (seen.has(r.p) || !r.p.onField) continue;
    seen.add(r.p);
    players.push(snapPlayer(w, r.p, 'runner'));
  }
  if (w.batter && w.batter.onField && !seen.has(w.batter)) {
    seen.add(w.batter);
    players.push(snapPlayer(w, w.batter, 'batter'));
  }
  // the dugouts: seated on the bench / walking to or from it / on deck / in the bullpen
  for (const t of [w.teams.home, w.teams.away]) {
    for (const p of t.players.values()) {
      if (p.onField || !p.dug || seen.has(p)) continue;
      seen.add(p);
      players.push(snapPlayer(w, p, p.dug === 'deck' || p.dug === 'toDeck' ? 'ondeck' : p.dug === 'toMound' ? 'pitcher' : 'bench'));
    }
  }
  // base coaches, ball kids, the bat boy
  for (const s of w.staff) {
    if (!s.active) continue;
    const sp = Math.hypot(s.vx, s.vz);
    // a ball kid sits only on his chair (standing still at his home spot): anywhere else he would be sitting on air
    const onChair = s.role === 'ballkid' && sp < 0.05 && Math.hypot(s.x - s.homeX, s.z - s.homeZ) < 0.3;
    const doing = w.tick < s.animUntil && (s.anim !== 'ballkid_sit' || onChair);
    players.push({
      id: s.id,
      name: s.name,
      team: s.team,
      role: s.role,
      position: s.role === 'coach1b' ? 'C1B' : s.role === 'coach3b' ? 'C3B' : s.role === 'ballkid' ? 'BK' : s.role === 'manager' ? 'MGR' : s.role === 'pitchcoach' ? 'PCH' : 'BB',
      jersey: s.jersey,
      pos: { x: s.x, y: dugoutFloorY(s.x, s.z) < 0 ? dugoutFloorY(s.x, s.z) : 0, z: s.z },
      vel: { x: s.vx, y: 0, z: s.vz },
      facing: s.facing,
      anim: doing ? s.anim : (s.role === 'manager' || s.role === 'pitchcoach') ? (sp > 0.4 ? 'walk' : 'idle') : sp > 0.4 ? (s.role === 'coach1b' || s.role === 'coach3b' ? 'walk' : sp > 2.5 ? 'ballkid_run' : 'walk') : s.role === 'ballkid' && s.task === 'idle' && onChair ? 'ballkid_sit' : s.role === 'coach1b' || s.role === 'coach3b' ? 'coach_ready' : 'ballkid_idle',
      animT: doing ? Math.min(1, (w.tick - s.animStart) / Math.max(1, s.animUntil - s.animStart)) : 0,
      hasBall: false,
      bats: 'R',
      throws: 'R',
      height: s.role === 'ballkid' ? 1.55 : 1.78,
    });
  }
  for (const u of w.umpires) {
    const gesturing = w.tick < u.animUntil;
    players.push({
      id: u.id,
      name: u.name,
      team: 'home',
      role: 'umpire',
      position: u.position,
      jersey: 0,
      pos: { x: u.x, y: 0, z: u.z },
      vel: { x: u.vx, y: 0, z: u.vz },
      facing: u.facing,
      anim: gesturing ? u.anim : umpStance(w),
      animT: gesturing ? Math.min(1, (w.tick - u.animStart) / Math.max(1, u.animUntil - u.animStart)) : 0,
      hasBall: false,
      bats: 'R',
      throws: 'R',
      height: 1.8,
    });
  }
  const b = w.ball.body;
  const ball: BallSnapshot = {
    pos: { x: b.x, y: b.y, z: b.z },
    vel: { x: b.vx, y: b.vy, z: b.vz },
    spin: { x: b.wx, y: b.wy, z: b.wz },
    mode: w.ball.mode,
    holderId: w.ball.holder ? w.ball.holder.info.id : null,
    inPlay: w.phase === 'inPlay' || w.phase === 'pitch',
  };
  const side = w.batStance === 'R' ? 1 : -1;
  let bat: BatSnapshot;
  // the swing bat until the follow-through ends; then, if he dropped it, only the bat on the ground (the swing bat used to stay in the air at the end of
  // the follow-through for the rest of the play, beside the dropped one)
  if (w.swing && w.swingStarted && w.batter && (!w.batDown || !w.swing.done) && (w.phase === 'pitch' || w.phase === 'inPlay' || w.phase === 'playOver')) {
    const pose = w.swing.pose();
    bat = { active: true, batterId: w.batter.info.id, knob: pose.knob, tip: pose.tip, swingT: w.swing.progress, dropped: null };
  } else if (w.batter && (w.phase === 'prePitch' || w.phase === 'windup' || w.phase === 'pitch')) {
    // ready stance: the batting_stance clip's bat (knob 0.20 m toward the plate and 0.17 m behind the body centre, bat up and back)
    const bx = w.batter.x;
    const kn = { x: bx - side * 0.2, y: 1.36, z: w.batter.z - 0.17 };
    bat = {
      active: false,
      batterId: w.batter.info.id,
      knob: kn,
      tip: { x: kn.x + side * 0.121 * 0.84, y: kn.y + 0.946 * 0.84, z: kn.z - 0.302 * 0.84 },
      swingT: -1,
      dropped: w.batDown ? { x: w.batDown.x, y: 0.04, z: w.batDown.z } : null,
    };
  } else {
    bat = { active: false, batterId: null, knob: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 0 }, swingT: -1, dropped: w.batDown ? { x: w.batDown.x, y: 0.04, z: w.batDown.z } : null };
  }
  const runnerAt = (base: number) => {
    const r = w.runners.find((q) => q.state === 'live' && q.base === base && !(q.isBatter && q.base === 0));
    return r ? { playerId: r.p.info.id, name: r.p.info.name } : null;
  };
  const z = w.zone;
  const info = (p: PlayerRT): PlayerInfo => p.info;
  return {
    time: w.tick * TICK,
    phase: w.phase,
    inning: w.inning,
    half: w.half,
    outs: w.outs,
    balls: w.count.balls,
    strikes: w.count.strikes,
    score: { home: w.teams.home.runs, away: w.teams.away.runs },
    linescore: { home: [...w.teams.home.linescore], away: [...w.teams.away.linescore] },
    runners: { first: runnerAt(1), second: runnerAt(2), third: runnerAt(3) },
    batter: w.batter ? { info: info(w.batter), line: { ...w.batter.bat } } : null,
    pitcher: w.pitcher ? { info: info(w.pitcher), line: { ...w.pitcher.pit }, pitchCount: w.pitcher.pitchCount, fatigue: w.pitcher.fatigue } : null,
    ball,
    bat,
    players,
    umpire: { lastCall: w.lastCall, zone: { left: z.left, right: z.right, bottom: z.bottom, top: z.top, depthZ: 0.4318 } },
    lastPlay: w.lastPlay,
    phaseDetail: phaseDetail(w),
    lull: !!w.lull,
    lullKind: w.lull?.kind ?? null,
    lullSec: w.lull?.sec ?? 0,
    lullRemaining: w.lull ? Math.max(0, w.lull.sec - (w.tick - w.lull.start) * TICK) : 0,
    extraBalls: w.extraBalls.map((b) => ({ x: b.x, y: b.y, z: b.z })),
    deadBall: w.deadBall ? { pos: { x: w.deadBall.body.x, y: w.deadBall.body.y, z: w.deadBall.body.z }, state: w.deadBall.state } : null,
    stats: { home: teamStats(w, w.teams.home), away: teamStats(w, w.teams.away) },
    pendingDecision: w.dec.waiting > 0 ? (() => { for (const sl of w.dec.slots.values()) if (sl.state === 'wait') return { id: sl.id, decision: sl.kind, side: sl.side }; return null; })() : null,
    gameOver: w.gameOver,
    winner: w.winner,
    teams: {
      home: { name: w.teams.home.team.name, abbrev: w.teams.home.team.abbrev },
      away: { name: w.teams.away.team.name, abbrev: w.teams.away.team.abbrev },
    },
  };
}


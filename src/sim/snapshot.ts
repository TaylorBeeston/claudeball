import { groundHeight } from './field';
import { teamStats } from './stats';
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
  if (sp > 1.2) return { anim: p.gait === 'trot' ? 'trot' : p.gait === 'turn' ? 'run_turn' : 'run', t: 0 };
  return { anim: 'idle', t: 0 };
}

/** Height of the feet above the field's datum: the ground at his spot (the mound is 10 in up) plus the height of a wall leap. */
function feetY(w: World, p: PlayerRT): number {
  const L = p.leap;
  const ground = groundHeight(p.x, p.z); // on the mound the pitcher stands 10 inches up
  if (!L) return ground;
  const u = (w.tick - L.t0) / L.dur;
  return ground + (u > 0 && u < 1 ? 4 * L.h * u * (1 - u) : 0);
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
    pos: { x: p.x, y: feetY(w, p), z: p.z },
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
    delivery: p.info.delivery ? { ...p.info.delivery, fromStretch: p === w.pitcher && w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead) } : undefined,
  };
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
  for (const u of w.umpires) {
    players.push({
      id: u.id,
      name: u.name,
      team: 'home',
      role: 'umpire',
      position: u.position,
      jersey: 0,
      pos: { x: u.x, y: 0, z: u.z },
      vel: { x: 0, y: 0, z: 0 },
      facing: Math.atan2(-u.x, u.position === 'HP' ? 20 : 30 - u.z),
      anim: 'idle',
      animT: 0,
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
  if (w.swing && w.swingStarted && w.batter && (w.phase === 'pitch' || w.phase === 'inPlay' || w.phase === 'playOver')) {
    const pose = w.swing.pose();
    bat = { active: true, batterId: w.batter.info.id, knob: pose.knob, tip: pose.tip, swingT: w.swing.progress };
  } else if (w.batter && (w.phase === 'prePitch' || w.phase === 'windup' || w.phase === 'pitch')) {
    // ready stance: bat cocked over the back shoulder
    const bx = w.batter.x;
    bat = {
      active: false,
      batterId: w.batter.info.id,
      knob: { x: bx + side * 0.05, y: 1.3, z: w.batter.z - 0.1 },
      tip: { x: bx + side * 0.1, y: 1.95, z: w.batter.z - 0.45 },
      swingT: -1,
    };
  } else {
    bat = { active: false, batterId: null, knob: { x: 0, y: 0, z: 0 }, tip: { x: 0, y: 0, z: 0 }, swingT: -1 };
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


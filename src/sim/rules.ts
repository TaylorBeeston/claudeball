import { emit } from './events';
import { BASE_POS } from './field';
import { clamp } from './math';
import { setGoal } from './movement';
import { giveBall, setAnim } from './util';
import type { FieldPosition, OutType, TeamSide } from './types';
import type { PlayerRT, RunnerRT, TeamRT, World } from './world';
import { secToTicks } from './world';
import * as flow from './flow';
import * as inplay from './inplay';
import * as running from './running';

const paced = (w: World, s: number) => secToTicks(s * w.cfg.pace);

export const POS_NUM: Record<string, number> = { P: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9, DH: 0 };
const POS_NAME: Record<string, string> = { P: 'pitcher', C: 'catcher', '1B': 'first baseman', '2B': 'second baseman', '3B': 'third baseman', SS: 'shortstop', LF: 'left fielder', CF: 'center fielder', RF: 'right fielder' };

export const posOf = (p: PlayerRT): FieldPosition => (p.fieldPos ?? 'P') as FieldPosition;

// ---------------------------------------------------------------------------------------------
// Pitch outcomes
// ---------------------------------------------------------------------------------------------

export function applyPitchOutcome(w: World, kind: 'ball' | 'strikeLooking' | 'strikeSwinging', opts: { ballLive: boolean; droppedThird: boolean }): void {
  if (kind === 'ball') {
    w.count.balls++;
    if (w.count.balls >= 4) {
      walk(w);
      return;
    }
  } else {
    w.count.strikes++;
    if (w.count.strikes >= 3) {
      if (opts.droppedThird) {
        inplay.beginDroppedThirdStrike(w, kind === 'strikeSwinging');
        return;
      }
      strikeout(w, kind === 'strikeSwinging');
      return;
    }
  }
  afterPitch(w, opts.ballLive);
}

/** After a pitch that did not end the PA. */
export function afterPitch(w: World, ballLive: boolean): void {
  if (ballLive) inplay.beginLooseBall(w);
  else if (w.stealing.size > 0) inplay.beginStealPlay(w);
  else flow.readyNextPitch(w);
}

function creditOut(w: World, p: PlayerRT | null): void {
  // pitcher of record gets the out
  w.pitcher.pit.outs++;
  void p;
}

export function strikeout(w: World, swinging: boolean): void {
  const b = w.batter!;
  w.outs++;
  creditOut(w, b);
  b.bat.so++;
  w.pitcher.pit.so++;
  emit(w, { type: 'out', playerId: b.info.id, outType: 'strikeout', fielders: [w.catcher.info.id], base: null });
  endPlateAppearance(w, swinging ? 'strikeout swinging' : 'strikeout looking', { ab: true, so: true });
  const desc = `${b.info.name} strikes out ${swinging ? 'swinging' : 'looking'}.`;
  w.lastPlay = desc;
  emit(w, { type: 'playEnd', description: desc });
  if (w.stealing.size > 0 && w.outs < 3) {
    inplay.beginStealPlay(w);
    return;
  }
  toPlayOver(w);
}

/** Walk: batter awarded first, forced runners advance (dead ball). */
export function walk(w: World): void {
  const b = w.batter!;
  b.bat.bb++;
  w.pitcher.pit.bb++;
  emit(w, { type: 'walk', batterId: b.info.id, intentional: false });
  awardBases(w, b, 1);
  endPlateAppearance(w, 'walk', { ab: false, bb: true });
  w.lastPlay = `${b.info.name} walks.`;
  emit(w, { type: 'playEnd', description: w.lastPlay });
}

export function hitByPitch(w: World): void {
  const b = w.batter!;
  b.bat.hbp++;
  w.pitcher.pit.hbp++;
  emit(w, { type: 'hitByPitch', batterId: b.info.id });
  awardBases(w, b, 1);
  endPlateAppearance(w, 'hit by pitch', { ab: false, hbp: true });
  w.lastPlay = `${b.info.name} is hit by the pitch.`;
  emit(w, { type: 'playEnd', description: w.lastPlay });
}

/** Award `bases` to the batter (walk/HBP=1, ground-rule double=2) pushing forced runners. */
export function awardBases(w: World, batter: PlayerRT, bases: number): void {
  const br = running.makeRunner(w, batter, true);
  br.awarded = true;
  br.dead = true;
  br.target = Math.min(4, bases);
  // push runners: process from the front
  const live = w.runners.filter((r) => r.state === 'live' && !r.isBatter);
  const occupied = (b: number) => live.find((r) => r.base === b);
  let need = bases; // batter takes base `need`; runners at or before it are pushed
  if (bases === 1) {
    let pushBase = 1;
    while (true) {
      const r = occupied(pushBase);
      if (!r) break;
      r.target = pushBase + 1;
      r.awarded = true;
      r.dead = true;
      pushBase++;
    }
  } else {
    // multi-base award (e.g. ground-rule double): every runner advances the same number of bases
    for (const r of live) {
      r.target = Math.min(4, r.base + need);
      r.awarded = true;
      r.dead = true;
    }
  }
  w.play = inplay.newPlay(w, 'deadBall');
  w.play.runners = w.runners.filter((r) => r.state === 'live');
  w.play.dead = true;
  w.ball.mode = 'dead';
  giveBall(w, w.pitcher);
  w.phase = 'inPlay';
  inplay.startDeadBallMovement(w);
}

// ---------------------------------------------------------------------------------------------
// Outs and runs
// ---------------------------------------------------------------------------------------------

export function recordOut(w: World, r: RunnerRT, outType: OutType, fielders: PlayerRT[], base: number | null, force: boolean): void {
  if (r.state !== 'live' || w.outs >= 3) return;
  r.state = 'out';
  w.outs++;
  creditOut(w, r.p);
  const play = w.play;
  const brBeforeFirst = r.isBatter && r.base === 0;
  if (play) play.outsThisPlay.push({ runner: r, force: force || brBeforeFirst, brBeforeFirst, tick: w.tick });
  if (r.isBatter && play) play.batterOut = true;
  emit(w, { type: 'out', playerId: r.p.info.id, outType, fielders: fielders.map((f) => f.info.id), base });
  r.goal_clear = true;
  if (w.outs >= 3) {
    thirdOut(w, force || brBeforeFirst);
  }
}

function thirdOut(w: World, nullifying: boolean): void {
  const play = w.play;
  if (play) {
    play.dead = true;
    if (nullifying && play.runsThisPlay.length) {
      const n = play.runsThisPlay.length;
      for (const rs of play.runsThisPlay) {
        const team = rs.runner.p.team;
        team.runs -= 1;
        if (team.linescore.length) team.linescore[team.linescore.length - 1] -= 1;
        w.inningRuns -= 1;
        rs.runner.responsible.pit.r -= 1;
        if (rs.runner.earned) rs.runner.responsible.pit.er -= 1;
        rs.runner.p.bat.r -= 1;
      }
      play.runsThisPlay = [];
      emit(w, { type: 'runsNullified', count: n, runsHome: w.teams.home.runs, runsAway: w.teams.away.runs });
      w.walkOffPending = false;
    }
  }
}

export function scoreRun(w: World, r: RunnerRT): void {
  if (r.state !== 'live') return;
  r.state = 'scored';
  r.scoredTick = w.tick;
  const team = r.p.team;
  team.runs++;
  while (team.linescore.length < w.inning) team.linescore.push(0);
  team.linescore[team.linescore.length - 1] += 1;
  w.inningRuns++;
  r.p.bat.r++;
  const resp = r.responsible;
  resp.pit.r++;
  const play = w.play;
  const earned = !r.reachedOnError && !r.ghost && !(play && play.hadError && false);
  r.earned = earned;
  if (earned) resp.pit.er++;
  if (play) play.runsThisPlay.push({ runner: r, tick: w.tick });
  emit(w, { type: 'runScored', playerId: r.p.info.id, team: team.side, runsHome: w.teams.home.runs, runsAway: w.teams.away.runs });
  checkWalkOff(w);
}

function checkWalkOff(w: World): void {
  if (w.half !== 'bottom' || w.inning < w.cfg.innings) return;
  if (w.teams.home.runs <= w.teams.away.runs) return;
  // With two outs a force / batter out could still cancel the run; wait for the play to finish.
  if (w.outs >= 2 && w.play && !w.play.dead) {
    w.walkOffPending = true;
    return;
  }
  w.walkOffPending = true;
  if (w.play) w.play.dead = true;
  // game is over as soon as the winning run touches home (with fewer than two outs)
  if (w.outs < 2) endGame(w, 'home');
}

// ---------------------------------------------------------------------------------------------
// Plate appearance & inning flow
// ---------------------------------------------------------------------------------------------

export interface PAResult {
  ab: boolean;
  h?: number; // total bases if a hit (1..4)
  bb?: boolean;
  hbp?: boolean;
  so?: boolean;
  sf?: boolean;
  sh?: boolean;
  hr?: boolean;
  rbi?: number;
}

export function endPlateAppearance(w: World, result: string, r: PAResult): void {
  const b = w.batter!;
  b.bat.pa++;
  if (r.ab) b.bat.ab++;
  if (r.h) {
    b.bat.h++;
    if (r.h === 2) b.bat.doubles++;
    if (r.h === 3) b.bat.triples++;
    if (r.h === 4) {
      b.bat.hr++;
      w.pitcher.pit.hr++;
    }
    w.pitcher.pit.h++;
    w.battingTeam.hits++;
  }
  if (r.sf) b.bat.sf++;
  if (r.sh) b.bat.sh++;
  if (r.rbi) b.bat.rbi += r.rbi;
  emit(w, { type: 'plateAppearanceEnd', batterId: b.info.id, result });
  w.battingTeam.batIdx = (w.battingTeam.batIdx + 1) % 9;
  w.paDone = true;
}

export function toPlayOver(w: World, seconds = 2.6): void {
  w.phase = 'playOver';
  w.phaseUntil = w.tick + paced(w, seconds);
  w.ball.mode = w.ball.mode === 'held' ? 'held' : w.ball.mode;
}

/** Called when the playOver timer elapses. */
export function afterPlayOver(w: World): void {
  if (w.gameOver) return;
  if (w.outs >= 3) {
    endHalfInning(w);
    return;
  }
  if (w.paDone) {
    w.paDone = false;
    // pinch runner / pitching change etc. happen inside startPlateAppearance
    flow.startPlateAppearance(w);
    return;
  }
  flow.readyNextPitch(w, 2.4);
}

export function endHalfInning(w: World): void {
  emit(w, { type: 'halfInningEnd', inning: w.inning, half: w.half });
  // clear bases, ball to pitcher
  for (const r of w.runners) r.p.onField = false;
  w.runners = [];
  w.paDone = false;
  const bat = w.batter;
  if (bat) bat.onField = false;
  if (w.half === 'top') {
    if (w.inning >= w.cfg.innings && w.teams.home.runs > w.teams.away.runs) {
      endGame(w, 'home');
      return;
    }
    w.half = 'bottom';
  } else {
    if (w.inning >= w.cfg.innings && w.teams.home.runs !== w.teams.away.runs) {
      endGame(w, w.teams.home.runs > w.teams.away.runs ? 'home' : 'away');
      return;
    }
    w.half = 'top';
    w.inning++;
  }
  flow.startHalfInning(w);
}

export function endGame(w: World, winner: TeamSide): void {
  if (w.gameOver) return;
  w.gameOver = true;
  w.winner = winner;
  w.phase = 'final';
  w.ball.mode = 'dead';
  emit(w, { type: 'gameEnd', winner, home: w.teams.home.runs, away: w.teams.away.runs });
  for (const t of [w.teams.home, w.teams.away]) {
    for (const p of t.players.values()) {
      p.goal = null;
      if (p.onField && t.side === winner) setAnim(w, p, 'celebrate', 1e6 / 240);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Play descriptions
// ---------------------------------------------------------------------------------------------

export function fielderChain(w: World, fs: PlayerRT[]): string {
  return fs.map((f) => POS_NUM[posOf(f)]).join('-');
}

export function posName(p: PlayerRT): string {
  return POS_NAME[posOf(p)] ?? 'fielder';
}

export function teamOf(w: World, side: TeamSide): TeamRT {
  return w.teams[side];
}

export { BASE_POS, clamp, setGoal };

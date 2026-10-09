import { emit } from './events';
import { toBench } from './dugout';
import * as visits from './visits';
import { BASE_POS } from './field';
import { clamp } from './math';
import { setGoal } from './movement';
import { giveBall, setAnim } from './util';
import type { FieldPosition, OutType, TeamSide } from './types';
import type { PlayerRT, RunnerRT, TeamRT, World } from './world';
import { secToTicks } from './world';
import * as flow from './flow';
import * as handling from './handling';
import * as umpires from './umpires';
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
  if (!w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead)) w.hornKind = 'k';
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
  w.pitcher.rattle = Math.min(1, w.pitcher.rattle + 0.12);
  emit(w, { type: 'walk', batterId: b.info.id, intentional: false });
  awardBases(w, b, 1);
  endPlateAppearance(w, 'walk', { ab: false, bb: true });
  w.lastPlay = `${b.info.name} walks.`;
  emit(w, { type: 'playEnd', description: w.lastPlay });
}

/** Intentional walk: no pitches are thrown. */
export function intentionalWalk(w: World): void {
  const b = w.batter!;
  b.bat.bb++;
  w.pitcher.pit.bb++;
  emit(w, { type: 'walk', batterId: b.info.id, intentional: true });
  awardBases(w, b, 1);
  endPlateAppearance(w, 'intentional walk', { ab: false, bb: true });
  w.lastPlay = `${b.info.name} is intentionally walked.`;
  emit(w, { type: 'playEnd', description: w.lastPlay });
}

/** Balk: dead ball, every runner advances one base, the pitch does not count (`why`: an illegal motion, or a third disengagement that got no out). */
export function balk(w: World, why: 'motion' | 'disengagement' = 'motion'): void {
  emit(w, { type: 'call', call: { kind: 'balk', time: w.tick / 240, balls: w.count.balls, strikes: w.count.strikes } });
  for (const r of w.runners) {
    if (r.state !== 'live') continue;
    r.target = Math.min(4, r.base + 1);
    r.want = r.target;
    r.awarded = true;
    r.dead = true;
    r.stealing = false;
  }
  w.play = inplay.newPlay(w, 'deadBall');
  w.play.dead = true;
  w.ball.mode = 'dead';
  giveBall(w, w.pitcher);
  w.phase = 'inPlay';
  w.stealing.clear();
  inplay.startDeadBallMovement(w);
  w.lastPlay = why === 'disengagement' ? `Balk called on ${w.pitcher.info.name}: a third disengagement.` : `Balk called on ${w.pitcher.info.name}.`;
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
  br.want = br.target;
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
      r.want = r.target;
      r.awarded = true;
      r.dead = true;
      pushBase++;
    }
  } else {
    // multi-base award (e.g. ground-rule double): every runner advances the same number of bases
    for (const r of live) {
      r.target = Math.min(4, r.base + need);
      r.want = r.target;
      r.awarded = true;
      r.dead = true;
    }
  }
  w.play = inplay.newPlay(w, 'deadBall');
  w.play.dead = true;
  w.ball.mode = 'dead';
  giveBall(w, w.pitcher);
  w.phase = 'inPlay';
  inplay.startDeadBallMovement(w);
}

// ---------------------------------------------------------------------------------------------
// Outs and runs
// ---------------------------------------------------------------------------------------------

export function recordOut(w: World, r: RunnerRT, outType: OutType, fielders: PlayerRT[], base: number | null, force: boolean, info: { margin?: number } = {}): void {
  if (r.state !== 'live' || w.outs >= 3) return;
  r.state = 'out';
  w.outs++;
  creditOut(w, r.p);
  const play = w.play;
  const brBeforeFirst = r.isBatter && r.base === 0;
  r.outTick = w.tick;
  // a batter put out at first (force / tag) still runs through the bag
  if (brBeforeFirst && (outType === 'force' || outType === 'tag')) r.exitVia = 1;
  if (play) play.outsThisPlay.push({ runner: r, force: force || brBeforeFirst, brBeforeFirst, tick: w.tick });
  if (r.isBatter && play) play.batterOut = true;
  const margin = info.margin;
  emit(w, { type: 'out', playerId: r.p.info.id, outType, fielders: fielders.map((f) => f.info.id), base, ...(margin !== undefined ? { margin, closePlay: Math.abs(margin) < 0.1 } : {}) });
  if (margin !== undefined && base !== null && (outType === 'force' || outType === 'tag' || outType === 'caughtStealing' || outType === 'pickoff')) visits.noteClose(w, 'out', r.p.info.id, base, margin);
  // the umpire at that bag (or the nearest one, for a tag in the open) signals it after the play
  if (outType === 'force' || outType === 'tag' || outType === 'pickoff' || outType === 'caughtStealing' || outType === 'tagUp') {
    const b = base ?? (r.target > r.base ? r.target : r.base);
    const key = b >= 1 && b <= 4 ? (b === 4 ? 'plate' : b === 1 ? 'first' : b === 2 ? 'second' : 'third') : umpires.nearestUmp(w, r.p.x, r.p.z);
    umpires.scheduleCall(w, key, 'out', umpires.baseCallDelay(margin !== undefined && Math.abs(margin) < 0.1), { atBase: b >= 1 ? b : undefined, playerId: r.p.info.id });
  }
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
  r.outTick = w.tick;
  const team = r.p.team;
  team.runs++;
  while (team.linescore.length < w.inning) team.linescore.push(0);
  team.linescore[team.linescore.length - 1] += 1;
  w.inningRuns++;
  r.p.bat.r++;
  const resp = r.responsible;
  resp.pit.r++;
  resp.rattle = Math.min(1, resp.rattle + 0.3);
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
    w.pitcher.rattle = Math.min(1, w.pitcher.rattle + 0.08);
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
  // the ball is dead: everyone heads back to his spot and whoever holds the ball starts the casual return
  flow.resetDefense(w);
  handling.ensureBallReturn(w, false);
  w.phase = 'playOver';
  w.phaseUntil = w.tick + paced(w, seconds);
  w.ball.mode = w.ball.mode === 'held' ? 'held' : w.ball.mode;
}

/** Called when the playOver timer elapses. */
export function afterPlayOver(w: World): void {
  if (w.gameOver) return;
  if (!visits.reviewStage(w)) return; // a managerial challenge of a close call (tempo)
  if (w.outs >= 3) {
    endHalfInning(w);
    return;
  }
  if (w.paDone) {
    // pinch runner / pitching change etc. are asked inside startPlateAppearance (which clears paDone when it completes)
    flow.startPlateAppearance(w);
    return;
  }
  flow.readyNextPitch(w, 2.4);
}

export function endHalfInning(w: World): void {
  w.battingTeam.lob += w.runners.filter((r) => r.state === 'live' && r.base >= 1 && !r.dead).length;
  emit(w, { type: 'halfInningEnd', inning: w.inning, half: w.half });
  // clear bases, ball to pitcher
  for (const r of w.runners) toBench(w, r.p);
  for (const r of w.exiting) toBench(w, r.p);
  w.runners = [];
  w.exiting = [];
  w.paDone = false;
  const bat = w.batter;
  if (bat) toBench(w, bat);
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

// ---------------------------------------------------------------------------------------------
// resolving plays
// ---------------------------------------------------------------------------------------------

const DIR_LABEL = (spray: number) => (spray > 14 ? 'left field' : spray < -14 ? 'right field' : 'center field');

function sprayWord(spray: number): string {
  if (spray > 30) return 'down the left-field line';
  if (spray < -30) return 'down the right-field line';
  return `to ${DIR_LABEL(spray)}`;
}

export function resolveBattedBall(w: World): void {
  const play = w.play!;
  const bip = play.bip!;
  const b = w.batter!;
  const name = b.info.name;
  const br = w.runners.find((r) => r.isBatter && r.p === b)!;
  const runs = play.runsThisPlay.length;
  const dp = play.outsThisPlay.length >= 2;
  const chain = fielderChain(w, play.touches.length ? dedupe(play.touches) : bip.fielders);
  let result: string;
  let opts: PAResult;
  let desc: string;
  if (br.state === 'out') {
    const ff = bip.firstFielder ?? play.touches[0];
    const where = ff ? posName(ff) : 'the field';
    if (bip.infieldFly) {
      result = 'infield fly';
      desc = `${name} pops out on an infield fly to ${where}.`;
      opts = { ab: true };
    } else if (bip.caught) {
      const sacFly = runs > 0 && play.outsThisPlay[0]?.tick !== undefined && w.outs <= 3 && bip.launchDeg > 15 && playOutsBefore(w, play) < 2;
      const kind = bip.launchDeg > 45 ? 'pops out' : bip.line ? 'lines out' : 'flies out';
      result = kind.replace(' out', 'out').replace('pops', 'pop').replace('lines', 'line').replace('flies', 'fly');
      result = bip.launchDeg > 45 ? 'popout' : bip.line ? 'lineout' : 'flyout';
      if (bip.robbed) {
        result = 'flyout';
        desc = `${name} is robbed of a home run by ${where}!`;
        opts = { ab: true };
      } else if (sacFly) {
        result = 'sac fly';
        desc = `${name} hits a sacrifice fly to ${where}; ${runs} run${runs > 1 ? 's' : ''} score${runs > 1 ? '' : 's'}.`;
        opts = { ab: false, sf: true, rbi: runs };
      } else {
        desc = `${name} ${kind} to ${where}.`;
        opts = { ab: true };
      }
    } else if (bip.bunt && playOutsBefore(w, play) < 2 && w.runners.some((q) => q.state !== 'out' && q.p !== b && q.base > q.origin)) {
      result = 'sac bunt';
      desc = `${name} lays down a sacrifice bunt, ${chain}.`;
      opts = { ab: false, sh: true, rbi: runs };
    } else {
      result = dp ? 'double play' : 'groundout';
      desc = dp ? `${name} grounds into a double play, ${chain}.` : `${name} grounds out, ${chain}.`;
      opts = { ab: true, rbi: dp ? 0 : runs };
    }
  } else {
    const base = br.state === 'scored' ? 4 : br.base;
    const forceOut = play.outsThisPlay.some((o) => o.runner !== br);
    if (bip.homeRun) {
      result = 'home run';
      desc = `${name} homers ${sprayWord(bip.sprayDeg)}${runs > 1 ? `, ${runs} runs score` : ''}.`;
      opts = { ab: true, h: 4, rbi: runs };
    } else if (play.errors.length && br.reachedOnError && base <= 1) {
      result = 'reached on error';
      desc = `${name} reaches on an error by ${posName(play.errors[0])}.`;
      opts = { ab: true, rbi: 0 };
    } else if ((forceOut && base <= 1) || base < 1) {
      result = "fielder's choice";
      desc = `${name} reaches on a fielder's choice, ${chain}.`;
      opts = { ab: true, rbi: runs };
    } else {
      const h = clamp(base, 1, 4);
      const verb = h === 1 ? 'singles' : h === 2 ? 'doubles' : h === 3 ? 'triples' : 'homers';
      result = h === 1 ? 'single' : h === 2 ? 'double' : h === 3 ? 'triple' : 'home run';
      desc = `${name} ${verb} ${sprayWord(bip.sprayDeg)}${runs ? `; ${runs} run${runs > 1 ? 's' : ''} score` : ''}.`;
      opts = { ab: true, h, rbi: play.errors.length ? 0 : runs };
    }
  }
  if (bip.groundRuleDouble) {
    result = 'double';
    desc = `${name} hits a ground-rule double.`;
    opts = { ab: true, h: 2, rbi: runs };
  }
  if (br.state === 'out' && !w.hornKind && !w.runners.some((r) => r.state === 'live' && r.base >= 1 && !r.dead)) w.hornKind = 'out';
  endPlateAppearance(w, result, opts);
  w.lastPlay = desc;
  emit(w, { type: 'playEnd', description: desc });
}

const dedupe = <T,>(a: T[]) => a.filter((x, i) => a.indexOf(x) === i);

function playOutsBefore(w: World, play: { outsThisPlay: unknown[] }): number {
  return w.outs - play.outsThisPlay.length;
}

export function resolveDroppedThird(w: World): void {
  const b = w.batter!;
  b.bat.so++;
  w.pitcher.pit.so++;
  const play = w.play!;
  const br = w.runners.find((r) => r.isBatter && r.p === b)!;
  const out = br.state === 'out';
  const desc = out ? `${b.info.name} strikes out and is thrown out at first.` : `${b.info.name} strikes out but reaches on the dropped third strike.`;
  if (!out) br.reachedOnError = true;
  endPlateAppearance(w, out ? 'strikeout' : 'strikeout (dropped third strike)', { ab: true, so: true });
  w.lastPlay = desc;
  emit(w, { type: 'playEnd', description: desc });
  void play;
}

export function resolveOtherPlay(w: World): void {
  const play = w.play!;
  const parts: string[] = [];
  for (const o of play.outsThisPlay) {
    const r = o.runner;
    if (r.p.info.id) parts.push(`${r.p.info.name} is out${r.stealing ? ' trying to steal' : ''}.`);
  }
  for (const r of w.runners) {
    if (r.state === 'live' && r.stealing && r.base > r.origin) parts.push(`${r.p.info.name} steals ${['', 'first', 'second', 'third', 'home'][r.base]}.`);
    else if (r.state === 'live' && !r.stealing && r.base > r.origin && (w.wildPitchFlag || w.passedBallFlag)) parts.push(`${r.p.info.name} advances on the ${w.wildPitchFlag ? 'wild pitch' : 'passed ball'}.`);
  }
  if (w.wildPitchFlag && w.runners.some((r) => r.state !== 'out' && r.base > r.origin)) w.pitcher.pit.wp++;
  w.wildPitchFlag = false;
  w.passedBallFlag = false;
  if (parts.length) {
    w.lastPlay = parts.join(' ');
    emit(w, { type: 'playEnd', description: w.lastPlay });
  }
}

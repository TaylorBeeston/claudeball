/**
 * Appeals for a missed base (rules 5.09(c)(2), 5.08(a)). A runner who ran past a bag without a foot on it is safe unless the
 * defense appeals before the next pitch: after the play the ball goes to the fielder at that base, he steps on the bag and
 * that base's umpire calls the runner out. The defense appeals only what its fielders saw (`MissedBase.seen`, perception when
 * the runner went by), and the decision goes through the decision provider (`appeal`; the built-in AI appeals what it saw).
 *
 * Runs: the appealed runner's own run comes off; when the appeal is the third out, runs by the runners behind him on that play
 * come off too, and every run of the play when he was forced (the batter-runner missing first is a force).
 */
import { emit } from './events';
import { PENDING } from './decisions';
import type { AppealDecision, AppealRequest } from './decisions';
import { ask, situationOf } from './dispatch';
import { BASE_POS } from './field';
import { lobBall } from './handling';
import { setGoal } from './movement';
import * as umpires from './umpires';
import { creditOut } from './rules';
import { footOnBase } from './tagging';
import type { MissedBase, PlayerRT, RunnerRT, World } from './world';
import { secToTicks } from './world';

/** An appeal in progress after the play. */
export interface AppealRT {
  m: MissedBase;
  /** The fielder who makes it (the one whose base it is). */
  F: PlayerRT;
  stage: 'toss' | 'step' | 'call';
  until: number;
  deadline: number;
}

const UMP_KEY = ['plate', 'first', 'second', 'third', 'plate'] as const;

/** The fielder whose base it is: first, second (the nearer middle infielder), third, the catcher at the plate. */
function baseman(w: World, b: number): PlayerRT | null {
  const d = w.fieldingTeam.defense;
  if (b === 1) return d.get('1B') ?? null;
  if (b === 3) return d.get('3B') ?? null;
  if (b === 4) return d.get('C') ?? null;
  const bp = BASE_POS[2];
  const cands = [d.get('2B'), d.get('SS')].filter((p): p is PlayerRT => !!p && p.onField);
  cands.sort((p, q) => Math.hypot(p.x - bp.x, p.z - bp.z) - Math.hypot(q.x - bp.x, q.z - bp.z));
  return cands[0] ?? null;
}

/** The built-in defense: appeal what a fielder saw. */
export function aiAppeal(req: AppealRequest): AppealDecision {
  return { appeal: req.seen };
}

/**
 * Called when the play is over, before the next batter / pitch (rules.afterPlayOver). Returns true when there is nothing (more) to
 * appeal, false while an appeal (or the question about one) is in progress.
 */
export function appealStage(w: World): boolean {
  if (w.gameOver) return true;
  if (w.appeal) return tickAppeal(w, w.appeal);
  for (const m of w.misses) {
    if (m.done) continue;
    const r = m.r;
    // nothing to appeal: he was put out anyway, or went back and touched it after all
    if (r.state === 'out' || r.touched[m.base]) {
      m.done = true;
      continue;
    }
    const d = ask(w, `appeal:${r.p.info.id}:${m.base}:${m.tick}`, 'appeal', w.fieldingTeam.side, () => ({ situation: situationOf(w), runner: r.p.info, base: m.base, seen: m.seen, scored: r.state === 'scored' }), { m });
    if (d === PENDING) return false;
    m.done = true;
    if (!d.appeal) continue;
    const F = baseman(w, m.base);
    if (!F) continue;
    if (w.cfg.pace === 0) {
      appealOut(w, m, F);
      continue;
    }
    w.appeal = { m, F, stage: 'toss', until: 0, deadline: w.tick + secToTicks(14) };
    emit(w, { type: 'appeal', stage: 'start', fielderId: F.info.id, runnerId: r.p.info.id, base: m.base });
    return false;
  }
  return true;
}

function tickAppeal(w: World, a: AppealRT): boolean {
  const { F, m } = a;
  const bp = m.base === 4 ? { x: 0, z: 0.2 } : BASE_POS[m.base];
  const ball = w.ball;
  if (w.tick > a.deadline) {
    w.appeal = null;
    return true;
  }
  switch (a.stage) {
    case 'toss': {
      setGoal(F, bp.x, bp.z, true, 0.6);
      // (the ball still on its way back to the pitcher: wait for it to land in a glove)
      if (ball.lob || !ball.holder || w.ret) return false;
      if (ball.holder !== F) {
        const D = Math.hypot(F.x - ball.holder.x, F.z - ball.holder.z);
        lobBall(w, ball.holder, F, 0.35 + D / 14, Math.min(2.5, 0.05 * D + 0.4), 'throw');
      }
      a.stage = 'step';
      return false;
    }
    case 'step': {
      setGoal(F, bp.x, bp.z, true, 0.6);
      if (ball.holder !== F || !footOnBase(F, m.base)) return false;
      a.stage = 'call';
      a.until = w.tick + secToTicks(0.5);
      return false;
    }
    case 'call': {
      if (w.tick < a.until) return false;
      appealOut(w, m, F);
      w.appeal = null;
      return true;
    }
  }
}

/** The umpire upholds the appeal: the runner is out, and the runs that rule 5.08(a) takes back come off. */
export function appealOut(w: World, m: MissedBase, F: PlayerRT): void {
  const r = m.r;
  const b = m.base;
  emit(w, { type: 'appeal', stage: 'out', fielderId: F.info.id, runnerId: r.p.info.id, base: b });
  umpires.scheduleCall(w, UMP_KEY[b], 'out', 0.25, { atBase: b, playerId: r.p.info.id });
  const play = w.play;
  if (r.state === 'scored') takeRunBack(w, r);
  const wasLive = r.state === 'live';
  // (an appeal after the third out, a "fourth out", only takes runs back)
  const fourth = w.outs >= 3;
  r.state = 'out';
  r.outTick = w.tick;
  if (!fourth) {
    w.outs++;
    creditOut(w, r.p);
  }
  if (wasLive) {
    // he leaves the field from where he is
    w.runners = w.runners.filter((q) => q !== r);
    if (w.cfg.pace === 0) r.p.onField = false;
    else if (!w.exiting.includes(r)) w.exiting.push(r);
  }
  emit(w, { type: 'out', playerId: r.p.info.id, outType: 'appeal', fielders: [F.info.id], base: b });
  if (w.outs >= 3 && play) {
    if (fourth) play.runsThisPlay = play.runsThisPlay.filter((rs) => rs.runner !== r);
    // a third out by appeal: runs after the miss by the runners behind him do not count (all of the play's runs on a force)
    const behind = (q: RunnerRT) => m.forced || q.origin < r.origin || (q.isBatter && !r.isBatter);
    const off = play.runsThisPlay.filter((rs) => rs.runner !== r && rs.tick >= m.tick && behind(rs.runner));
    for (const rs of off) takeRunBack(w, rs.runner);
  }
}

/** Undo a run that was scored (score, linescore, the runner's run, the pitcher's runs / earned runs). */
function takeRunBack(w: World, r: RunnerRT): void {
  const play = w.play;
  const team = r.p.team;
  team.runs -= 1;
  if (team.linescore.length) team.linescore[team.linescore.length - 1] -= 1;
  w.inningRuns -= 1;
  r.responsible.pit.r -= 1;
  if (r.earned) r.responsible.pit.er -= 1;
  r.p.bat.r -= 1;
  if (play) play.runsThisPlay = play.runsThisPlay.filter((rs) => rs.runner !== r);
  emit(w, { type: 'runsNullified', count: 1, runsHome: w.teams.home.runs, runsAway: w.teams.away.runs });
}

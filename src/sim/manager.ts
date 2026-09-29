import { emit } from './events';
import { PENDING } from './decisions';
import type { BuntDecision } from './decisions';
import { ask, situationOf } from './dispatch';
import { fatigueOf } from './pitchai';
import { DEFAULT_SPOTS } from './setup';
import type { PlayerRT, RunnerRT, TeamRT, World } from './world';
import { giveBall } from './util';

const pitcherQuality = (p: PlayerRT) => p.info.ratings.velocity * 0.9 + p.info.ratings.control * 0.5 + p.info.ratings.movement * 0.5;
const hitterQuality = (p: PlayerRT) => (p.info.ratings.contact + p.info.ratings.power + p.info.ratings.eye) / 3;

function slotOf(t: TeamRT, p: PlayerRT) {
  return t.lineup.find((s) => s.player === p);
}

// ---------------------------------------------------------------------------------------------
// the built-in manager (AI): decisions as pure functions of the live state
// ---------------------------------------------------------------------------------------------

/** Late-game intentional walk: first base open, runner in scoring position, dangerous hitter due, weaker bat on deck. */
export function aiIntentionalWalk(w: World): boolean {
  const t = w.battingTeam;
  const f = w.fieldingTeam;
  if (w.inning < 7 || f.runs < t.runs || f.runs - t.runs > 2) return false;
  const live = w.runners.filter((r) => r.state === 'live');
  if (live.some((r) => r.base === 1)) return false;
  if (!live.some((r) => r.base === 2 || r.base === 3)) return false;
  if (live.length >= 2 && live.some((r) => r.base === 1)) return false;
  const b = t.lineup[t.batIdx % 9].player;
  const next = t.lineup[(t.batIdx + 1) % 9].player;
  if (b.info.isPitcher) return false;
  const bq = hitterQuality(b);
  const nq = next.info.isPitcher ? 25 : hitterQuality(next);
  if (bq < 58 || nq > bq - 7) return false;
  if (w.outs >= 2 && nq > bq - 12) return false;
  return w.aiRng.next() < 0.85;
}

/** Bunt intent for a plate appearance: sacrifice with weak hitters (and pitchers), or a bunt for a hit by a fast, light hitter. */
export function aiBunt(w: World): BuntDecision {
  const b = w.batter!;
  const t = w.battingTeam;
  const rng = w.aiRng;
  const live = w.runners.filter((q) => q.state === 'live' && !q.isBatter);
  const on1 = live.some((q) => q.base === 1);
  const on2 = live.some((q) => q.base === 2);
  const on3 = live.some((q) => q.base === 3);
  const diff = t.runs - w.fieldingTeam.runs;
  const quality = (b.info.ratings.contact + b.info.ratings.power) / 2;
  const R = b.info.ratings;
  if (w.outs === 0 && (on1 || on2) && !on3 || (w.outs === 1 && on2 && !on3 && quality < 40)) {
    let p = 0;
    if (b.info.isPitcher) p = 0.75;
    else if (quality < 45 && w.inning >= 6 && diff >= -1 && diff <= 1) p = 0.4;
    else if (quality < 40 && w.inning >= 4 && Math.abs(diff) <= 2) p = 0.15;
    if (p > 0 && rng.next() < p) return { kind: 'sac', psi: -(0.05 + rng.next() * 0.09) };
  }
  if (!on2 && !on3 && R.speed >= 72 && R.power < 46 && rng.next() < 0.045) {
    return { kind: 'hit', psi: w.batStance === 'R' ? 0.13 : -0.13 };
  }
  return null;
}

/** The reliever the manager would bring in now (or null). */
export function aiPitchingChange(w: World, t: TeamRT): PlayerRT | null {
  const p = t.pitcher;
  const limit = 30 + p.info.ratings.stamina;
  const isStarter = p.info.id === t.team.startingPitcherId;
  const inn = w.inning;
  const lead = t.runs - (t === w.teams.home ? w.teams.away.runs : w.teams.home.runs);
  const runnersOn = w.runners.some((r) => r.state === 'live');
  const lateAndClose = inn >= 9 && lead > 0 && lead <= 3;
  const closerAvail = t.bullpen.find((b) => !b.used && b.info.id === t.team.bullpen[0]);
  let pull = false;
  if (p.pitchCount >= limit * 1.05) pull = true;
  else if (isStarter) {
    if (p.pitchCount >= limit * 0.9 && (runnersOn || w.count.balls > 0 || p.pit.r >= 3)) pull = true;
    if (p.pit.r >= 6 && p.pitchCount > 45) pull = true;
    if (p.pit.r >= 4 && p.pitchCount > 70) pull = true;
    if (inn >= 8 && lead > 0 && lead <= 3 && closerAvail && p.pitchCount > 80) pull = true;
  } else {
    if (p.pit.r >= 3 && p.pit.outs < 6) pull = true;
    if (p.pit.outs >= 6 && p.pitchCount > limit * 0.6) pull = true;
    if (p.pit.bf >= 6 && p.pit.outs >= 3 && p.pitchCount > 22 && w.count.balls === 0 && w.count.strikes === 0 && !runnersOn && lateAndClose && p.info.id !== t.team.bullpen[0]) pull = true;
  }
  if (lateAndClose && closerAvail && p.info.id !== closerAvail.info.id && inn === 9) pull = true;
  if (!pull) return null;
  const pool = t.bullpen.filter((b) => !b.used);
  if (!pool.length) return null;
  if (lateAndClose && closerAvail) return closerAvail;
  const nonCloser = pool.filter((b) => b.info.id !== t.team.bullpen[0]);
  const list = nonCloser.length ? nonCloser : pool;
  return list.reduce((a, c) => (pitcherQuality(c) > pitcherQuality(a) ? c : a));
}

export function aiPinchHitter(w: World): PlayerRT | null {
  const t = w.battingTeam;
  const slot = t.lineup[t.batIdx % 9];
  const b = slot.player;
  if (w.inning < 7) return null;
  const diff = t.runs - (t === w.teams.home ? w.teams.away.runs : w.teams.home.runs);
  const leverage = (w.runners.some((r) => r.state === 'live' && r.base >= 2) ? 1 : 0) + (Math.abs(diff) <= 2 ? 1 : 0) + (w.inning >= 9 ? 1 : 0);
  if (leverage < 2 && slot.position !== 'P') return null;
  if (w.outs >= 2 && leverage < 3) return null;
  const bq = slot.position === 'P' ? 20 : hitterQuality(b);
  const cands = t.bench.filter((p) => !p.used && !p.info.isPitcher);
  if (!cands.length) return null;
  const best = cands.reduce((a, c) => (hitterQuality(c) > hitterQuality(a) ? c : a));
  if (hitterQuality(best) < bq + 7) return null;
  if (slot.position === 'P') return null;
  return best;
}

export function aiPinchRunner(w: World): { r: RunnerRT; best: PlayerRT } | null {
  const t = w.battingTeam;
  if (w.inning < 8) return null;
  const diff = t.runs - (t === w.teams.home ? w.teams.away.runs : w.teams.home.runs);
  if (diff > 0 || diff < -1) return null;
  if (w.outs >= 2) return null;
  const r = w.runners.find((q) => q.state === 'live' && q.base >= 1 && q.base <= 2 && !q.ghost);
  if (!r) return null;
  if (r.p.info.ratings.speed >= 48) return null;
  const cands = t.bench.filter((p) => !p.used && !p.info.isPitcher && p.info.ratings.speed >= 62);
  if (!cands.length) return null;
  const best = cands.reduce((a, c) => (c.info.ratings.speed > a.info.ratings.speed ? c : a));
  return { r, best };
}

// ---------------------------------------------------------------------------------------------
// applying substitutions
// ---------------------------------------------------------------------------------------------

export function substitutePitcher(w: World, t: TeamRT, np: PlayerRT): void {
  const old = t.pitcher;
  np.inGame = true;
  np.used = true;
  np.fieldPos = 'P';
  old.inGame = false;
  old.onField = false;
  old.hasBall = false;
  t.defense.set('P', np);
  t.pitcher = np;
  const slot = t.lineup.find((s) => s.player === old);
  if (slot) slot.player = np; // no-DH league: the reliever inherits the batting slot
  t.bullpen = t.bullpen.filter((b) => b !== np);
  const spot = DEFAULT_SPOTS.P;
  np.onField = true;
  np.role = 'pitcher';
  np.x = spot.x;
  np.z = spot.z;
  np.vx = np.vz = 0;
  np.goal = null;
  np.facing = Math.PI;
  np.lookAt = { x: 0, z: 0 };
  if (t === w.fieldingTeam) {
    w.pitcher = np;
    giveBall(w, np);
  }
  emit(w, { type: 'pitchingChange', team: t.side, inId: np.info.id, outId: old.info.id });
  emit(w, { type: 'substitution', team: t.side, inId: np.info.id, outId: old.info.id, reason: 'pitching change' });
}

function replaceInLineup(w: World, t: TeamRT, out: PlayerRT, inn: PlayerRT, reason: string): void {
  const slot = slotOf(t, out);
  if (!slot) return;
  inn.inGame = true;
  inn.used = true;
  out.inGame = false;
  const pos = slot.position;
  slot.player = inn;
  inn.fieldPos = pos === 'DH' ? 'DH' : pos;
  if (pos !== 'DH') t.defense.set(pos, inn);
  t.bench = t.bench.filter((b) => b !== inn);
  emit(w, { type: 'substitution', team: t.side, inId: inn.info.id, outId: out.info.id, reason });
}

function pinchRun(w: World, t: TeamRT, r: RunnerRT, best: PlayerRT): void {
  const out = r.p;
  replaceInLineup(w, t, out, best, 'pinch runner');
  r.p = best;
  best.role = 'runner';
  best.onField = true;
  best.x = out.x;
  best.z = out.z;
  best.vx = best.vz = 0;
  best.vmax = 6.65 + 0.031 * best.info.ratings.speed;
  best.accel = 6.6 + 0.03 * best.info.ratings.speed;
  out.onField = false;
}

// ---------------------------------------------------------------------------------------------
// plate-appearance start: each stage asks its decision (returns true when done, false while waiting)
// ---------------------------------------------------------------------------------------------

export function stagePitchingChange(w: World): boolean {
  const t = w.fieldingTeam;
  const pool = t.bullpen.filter((b) => !b.used);
  if (!pool.length) return true;
  const bt = w.battingTeam;
  const due = bt.lineup[bt.batIdx % 9].player;
  const d = ask(
    w,
    'pc',
    'pitchingChange',
    t.side,
    () => ({
      situation: situationOf(w),
      current: { info: t.pitcher.info, pitchCount: t.pitcher.pitchCount, fatigue: fatigueOf(t.pitcher), line: { ...t.pitcher.pit }, isStarter: t.pitcher.info.id === t.team.startingPitcherId },
      bullpen: pool.map((p) => ({ info: p.info, isCloser: p.info.id === t.team.bullpen[0] })),
      batter: due.info,
    }),
    { t },
  );
  if (d === PENDING) return false;
  const np = d.replaceWith ? pool.find((p) => p.info.id === d.replaceWith) : null;
  if (np) substitutePitcher(w, t, np);
  return true;
}

export function stagePinchRun(w: World): boolean {
  const t = w.battingTeam;
  const bench = t.bench.filter((p) => !p.used && !p.info.isPitcher);
  const cands = w.runners.filter((q) => q.state === 'live' && q.base >= 1 && q.base <= 3 && !q.ghost && !q.isBatter);
  if (!bench.length || !cands.length) return true;
  const d = ask(w, 'pr', 'pinchRun', t.side, () => ({ situation: situationOf(w), runners: cands.map((q) => ({ base: q.base, info: q.p.info })), bench: bench.map((p) => p.info) }));
  if (d === PENDING) return false;
  if (d) {
    const r = cands.find((q) => q.base === d.base);
    const best = bench.find((p) => p.info.id === d.playerId);
    if (r && best) pinchRun(w, t, r, best);
  }
  return true;
}

export function stagePinchHit(w: World): boolean {
  const t = w.battingTeam;
  const bench = t.bench.filter((p) => !p.used && !p.info.isPitcher);
  if (!bench.length) return true;
  const slot = t.lineup[t.batIdx % 9];
  const d = ask(w, 'ph', 'pinchHit', t.side, () => ({ situation: situationOf(w), due: slot.player.info, position: slot.position, bench: bench.map((p) => p.info), pitcher: w.pitcher.info }));
  if (d === PENDING) return false;
  const best = d.playerId ? bench.find((p) => p.info.id === d.playerId) : null;
  if (best && best !== slot.player) replaceInLineup(w, t, slot.player, best, 'pinch hitter');
  return true;
}

/** 'wait' while the answer is pending; 'walk' if the batter is to be put on. */
export function stageIntentionalWalk(w: World): 'wait' | 'walk' | 'pitch' {
  const t = w.battingTeam;
  const b = w.batter!;
  const next = t.lineup[(t.batIdx + 1) % 9].player;
  const d = ask(w, 'ibb', 'intentionalWalk', w.fieldingTeam.side, () => ({ situation: situationOf(w), batter: b.info, onDeck: next.info }));
  if (d === PENDING) return 'wait';
  return d.walk ? 'walk' : 'pitch';
}

export function stageBunt(w: World): boolean {
  const b = w.batter!;
  const d = ask(w, 'bunt', 'bunt', w.battingTeam.side, () => ({ situation: situationOf(w), batter: b.info, stance: w.batStance }));
  if (d === PENDING) return false;
  w.buntPlan = d;
  return true;
}

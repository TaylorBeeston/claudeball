import { emit } from './events';
import { DEFAULT_SPOTS } from './setup';
import type { PlayerRT, TeamRT, World } from './world';
import { giveBall } from './util';

const pitcherQuality = (p: PlayerRT) => p.info.ratings.velocity * 0.9 + p.info.ratings.control * 0.5 + p.info.ratings.movement * 0.5;
const hitterQuality = (p: PlayerRT) => (p.info.ratings.contact + p.info.ratings.power + p.info.ratings.eye) / 3;

function slotOf(t: TeamRT, p: PlayerRT) {
  return t.lineup.find((s) => s.player === p);
}

/** Manager decisions taken between batters: bullpen, pinch hitters and pinch runners. */
/** Late-game intentional walk: first base open, runner in scoring position, dangerous hitter due, weaker bat on deck. */
export function considerIntentionalWalk(w: World): boolean {
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
  return w.rng.next() < 0.85;
}

/** Bunt intent for a plate appearance: sacrifice with weak hitters (and pitchers), or a bunt for a hit by a fast, light hitter. */
export function planBunt(w: World): { kind: 'sac' | 'hit'; psi: number } | null {
  const b = w.batter!;
  const t = w.battingTeam;
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
    if (p > 0 && w.rng.next() < p) return { kind: 'sac', psi: -(0.05 + w.rng.next() * 0.09) };
  }
  if (!on2 && !on3 && R.speed >= 72 && R.power < 46 && w.rng.next() < 0.045) {
    return { kind: 'hit', psi: w.batStance === 'R' ? 0.13 : -0.13 };
  }
  return null;
}

export function beforePlateAppearance(w: World): void {
  considerPitchingChange(w, w.fieldingTeam);
  considerPinchRunner(w);
  considerPinchHitter(w);
}

function considerPitchingChange(w: World, t: TeamRT): void {
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
  if (!pull) return;
  const pool = t.bullpen.filter((b) => !b.used);
  if (!pool.length) return;
  let pick: PlayerRT;
  if (lateAndClose && closerAvail) pick = closerAvail;
  else {
    const nonCloser = pool.filter((b) => b.info.id !== t.team.bullpen[0]);
    const list = nonCloser.length ? nonCloser : pool;
    pick = list.reduce((a, c) => (pitcherQuality(c) > pitcherQuality(a) ? c : a));
  }
  substitutePitcher(w, t, pick);
}

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

function considerPinchHitter(w: World): void {
  const t = w.battingTeam;
  const slot = t.lineup[t.batIdx % 9];
  const b = slot.player;
  if (w.inning < 7) return;
  if (slot.position === 'P') {
    // pitcher's spot in a no-DH game
    if (b.pit.pitches > 0 && w.inning >= 6) {
      /* fall through */
    }
  }
  const diff = t.runs - (t === w.teams.home ? w.teams.away.runs : w.teams.home.runs);
  const leverage = (w.runners.some((r) => r.state === 'live' && r.base >= 2) ? 1 : 0) + (Math.abs(diff) <= 2 ? 1 : 0) + (w.inning >= 9 ? 1 : 0);
  if (leverage < 2 && slot.position !== 'P') return;
  if (w.outs >= 2 && leverage < 3) return;
  const bq = slot.position === 'P' ? 20 : hitterQuality(b);
  const cands = t.bench.filter((p) => !p.used && !p.info.isPitcher);
  if (!cands.length) return;
  const best = cands.reduce((a, c) => (hitterQuality(c) > hitterQuality(a) ? c : a));
  if (hitterQuality(best) < bq + 7) return;
  if (slot.position === 'P') return;
  replaceInLineup(w, t, b, best, 'pinch hitter');
}

function considerPinchRunner(w: World): void {
  const t = w.battingTeam;
  if (w.inning < 8) return;
  const diff = t.runs - (t === w.teams.home ? w.teams.away.runs : w.teams.home.runs);
  if (diff > 0 || diff < -1) return;
  if (w.outs >= 2) return;
  const r = w.runners.find((q) => q.state === 'live' && q.base >= 1 && q.base <= 2 && !q.ghost);
  if (!r) return;
  if (r.p.info.ratings.speed >= 48) return;
  const cands = t.bench.filter((p) => !p.used && !p.info.isPitcher && p.info.ratings.speed >= 62);
  if (!cands.length) return;
  const best = cands.reduce((a, c) => (c.info.ratings.speed > a.info.ratings.speed ? c : a));
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

/**
 * Game events -> faces (docs/faces.md section 5, the event table): who reacts to what, with which preset, how strongly, after how long, and how
 * each team's mood moves. Pure: the engine's glue (players.ts) feeds it the sim's events and the cast, and hands the actions to the puppets.
 * Only events that exist are used (sim / adapter events); a brushback is derived from the pitch's plate crossing.
 */
import type { ReactionName } from './emotion';

/** a person on the field or the benches: team 0 = away, 1 = home, -1 = umpires / crew */
export interface CastMember {
  id: string;
  team: number;
  role: string;
  hand?: 'L' | 'R';
}

export interface FaceCtx {
  half: 'top' | 'bottom';
  /** the batter / pitcher of the plate appearance (ids) */
  batterId?: string;
  pitcherId?: string;
  cast: CastMember[];
  /** the batter whose home run just left the park (his own run, sent at the same moment, does not cut the grin short) */
  homer?: string;
}

export interface FaceAction {
  id: string;
  reaction?: ReactionName;
  /** what a calm person shows instead (a fiery one shows `reaction`) */
  calmAlt?: ReactionName;
  intensity?: number;
  delay?: number;
  /** a mood nudge (valence, arousal) */
  mood?: [number, number];
  /** seconds of talking (the jaw moves) */
  talk?: number;
}

/** the events the faces read (a structural subset of the engine's GameEvent) */
export type FaceEvent =
  | { type: 'pa_end'; batterId: string; result: string }
  | { type: 'homerun'; batterId: string }
  | { type: 'robbed_hr'; playerId: string; batterId: string }
  | { type: 'error'; fielderId: string }
  | { type: 'run'; playerId?: string }
  | { type: 'out'; playerId?: string; closePlay?: boolean }
  | { type: 'safe'; playerId?: string; closePlay?: boolean }
  | { type: 'pitch_crossed'; x: number; y: number }
  | { type: 'hbp'; batterId: string }
  | { type: 'coach_signal'; coachId: string; signal: string }
  | { type: 'ball_kid_retrieve'; kidId: string }
  | { type: 'ball_tossed_to_fan'; kidId: string }
  | { type: 'substitution'; inId: string; outId: string; reason: string }
  | { type: 'signs_given' | 'shake_off' | 'mound_visit' | 'challenge' | 'pitching_change_start' | 'mound_visit_end' | 'challenge_result'; playerId?: string }
  | { type: string; [k: string]: unknown };

const BENCH = /^(bench|manager|pitchcoach|bullpen|reliever)/;
const COACH = /^coach/;

/** the batting side's team number */
export const battingTeam = (half: 'top' | 'bottom') => (half === 'top' ? 0 : 1);

const HITS: Record<string, number> = { single: 0.75, double: 0.9, triple: 1, 'reached on error': 0.6 };
const OUTS = /out|double play|triple play|fielder's choice|sacrifice|grounds|flies|lines|pops/;

/**
 * Who reacts to `ev`. Teams: the batting side cheers a hit and groans at a strikeout, the fielding side the other way round (bench players,
 * managers and coaches carry it as mood, the close-up subjects as a reaction).
 */
export function reactionsFor(ev: FaceEvent, ctx: FaceCtx): FaceAction[] {
  const out: FaceAction[] = [];
  const bat = battingTeam(ctx.half);
  const roleOf = (id?: string) => ctx.cast.find((c) => c.id === id);
  const catcher = ctx.cast.find((c) => c.role === 'catcher')?.id;
  const team = (t: number, mood: [number, number], reaction?: ReactionName, intensity = 0.7) => {
    for (const c of ctx.cast) if (c.team === t && (BENCH.test(c.role) || COACH.test(c.role))) out.push({ id: c.id, mood, reaction, intensity });
  };
  const add = (a: FaceAction) => a.id && out.push(a);
  switch (ev.type) {
    case 'pa_end': {
      const { batterId, result } = ev as { batterId: string; result: string };
      const p = ctx.pitcherId;
      if (result.startsWith('strikeout')) {
        const looking = result.includes('looking');
        add({ id: batterId, reaction: looking ? 'frustration' : 'dejection', calmAlt: looking ? 'frustration' : 'dejection' });
        if (looking) add({ id: batterId, reaction: 'glare', calmAlt: 'concern', intensity: 0.8, delay: 1.2 });
        if (p) add({ id: p, reaction: 'yell', calmAlt: 'nod' });
        if (catcher) add({ id: catcher, reaction: 'grin', intensity: 0.6, delay: 0.3 });
        team(bat, [-0.12, 0.05]);
        team(1 - bat, [0.12, 0.08]);
      } else if (result === 'walk' || result === 'intentional walk') {
        add({ id: batterId, reaction: 'relief', intensity: result === 'walk' ? 0.9 : 0.5 });
        if (p) add({ id: p, reaction: 'frustration', calmAlt: 'concern', intensity: result === 'walk' ? 0.8 : 0.3 });
      } else if (result === 'hit by pitch') {
        // the wince comes with the pitch (`hbp`); afterwards a look at the pitcher
        add({ id: batterId, reaction: 'glare', calmAlt: 'concern', intensity: 0.9, delay: 0.9 });
        if (p) add({ id: p, reaction: 'concern', intensity: 0.8, delay: 0.4 });
      } else if (HITS[result] !== undefined) {
        add({ id: batterId, reaction: result === 'reached on error' ? 'grin' : 'joy', intensity: HITS[result] });
        if (p) add({ id: p, reaction: result === 'single' ? 'frustration' : 'dejection', calmAlt: 'concern', intensity: 0.7 });
        team(bat, [0.15, 0.1], 'grin', 0.5);
        team(1 - bat, [-0.1, 0.05]);
      } else if (result !== 'home run' && OUTS.test(result)) {
        const dp = /double play|triple play/.test(result);
        add({ id: batterId, reaction: dp ? 'dejection' : 'frustration', calmAlt: 'concern', intensity: dp ? 0.9 : 0.6 });
        if (p) add({ id: p, reaction: dp ? 'yell' : 'nod', calmAlt: dp ? 'grin' : 'nod', intensity: dp ? 0.8 : 0.6 });
        team(bat, [-0.05, 0]);
        team(1 - bat, [0.05, 0.03]);
      }
      break;
    }
    case 'homerun': {
      const b = (ev as { batterId: string }).batterId;
      // the grin as it clears the fence, the shout around the bases; the pitcher stunned, then down; the benches
      add({ id: b, reaction: 'grin', intensity: 1 });
      add({ id: b, reaction: 'shout', intensity: 1, delay: 2.2 });
      if (ctx.pitcherId) {
        add({ id: ctx.pitcherId, reaction: 'shock', intensity: 0.8 });
        add({ id: ctx.pitcherId, reaction: 'dejection', intensity: 1, delay: 1.6 });
      }
      if (catcher) add({ id: catcher, reaction: 'dejection', intensity: 0.6, delay: 0.5 });
      team(bat, [0.4, 0.4], 'joy', 0.9);
      team(1 - bat, [-0.3, 0.1], 'dejection', 0.6);
      break;
    }
    case 'robbed_hr': {
      const e = ev as { playerId: string; batterId: string };
      add({ id: e.playerId, reaction: 'yell', calmAlt: 'joy', intensity: 1 });
      add({ id: e.batterId, reaction: 'shock', intensity: 0.9 });
      add({ id: e.batterId, reaction: 'dejection', intensity: 0.8, delay: 1.2 });
      break;
    }
    case 'error': {
      const f = (ev as { fielderId: string }).fielderId;
      add({ id: f, reaction: 'grimace', intensity: 1 });
      if (ctx.pitcherId && ctx.pitcherId !== f) add({ id: ctx.pitcherId, reaction: 'frustration', calmAlt: 'concern', intensity: 0.6, delay: 0.5 });
      break;
    }
    case 'run': {
      const r = (ev as { playerId?: string }).playerId;
      if (r && r !== ctx.homer) add({ id: r, reaction: 'shout', intensity: 0.8 });
      team(bat, [0.15, 0.15], 'joy', 0.6);
      team(1 - bat, [-0.12, 0.05]);
      break;
    }
    case 'out': {
      const e = ev as { playerId?: string; closePlay?: boolean };
      if (e.closePlay && e.playerId && roleOf(e.playerId)?.team === bat) add({ id: e.playerId, reaction: 'argue', calmAlt: 'frustration', intensity: 0.9, talk: 2.5 });
      break;
    }
    case 'safe': {
      const e = ev as { playerId?: string; closePlay?: boolean };
      if (e.closePlay && e.playerId) add({ id: e.playerId, reaction: 'relief', intensity: 0.8 });
      break;
    }
    case 'pitch_crossed': {
      // a brushback: high and far inside (plate x toward the batter's side: + for a right-handed batter)
      const e = ev as { x: number; y: number };
      const b = roleOf(ctx.batterId);
      if (!b) break;
      const side = b.hand === 'L' ? -1 : 1;
      if (e.y > 1.25 && e.x * side > 0.45) {
        add({ id: b.id, reaction: 'flinch', intensity: 1 });
        add({ id: b.id, reaction: 'glare', calmAlt: 'concern', intensity: 0.9, delay: 0.7 });
        if (ctx.pitcherId) add({ id: ctx.pitcherId, reaction: 'glare', calmAlt: 'concern', intensity: 0.5, delay: 1.0 });
      }
      break;
    }
    case 'hbp': {
      const b = (ev as { batterId: string }).batterId;
      add({ id: b, reaction: 'wince', intensity: 1 });
      break;
    }
    case 'coach_signal': {
      const e = ev as { coachId: string; signal: string };
      add({ id: e.coachId, reaction: 'concentration', intensity: 0.8 });
      if (e.signal === 'signs' && ctx.batterId) add({ id: ctx.batterId, reaction: 'concentration', intensity: 0.8 });
      break;
    }
    case 'ball_kid_retrieve':
    case 'ball_tossed_to_fan':
      add({ id: (ev as { kidId: string }).kidId, reaction: 'delight', intensity: ev.type === 'ball_tossed_to_fan' ? 1 : 0.7 });
      break;
    case 'substitution': {
      const e = ev as { inId: string; outId: string; reason: string };
      if (/pitching/.test(e.reason)) {
        add({ id: e.outId, reaction: 'dejection', intensity: 0.8 });
        add({ id: e.inId, reaction: 'concentration', intensity: 0.9 });
      }
      break;
    }
    case 'shake_off':
      if (ctx.pitcherId) add({ id: ctx.pitcherId, reaction: 'grimace', intensity: 0.4 });
      break;
    case 'mound_visit': {
      // the visitor talks, the pitcher listens (and answers a little)
      const v = (ev as { playerId?: string }).playerId;
      if (v) add({ id: v, talk: 6, reaction: 'concentration', intensity: 0.6 });
      if (ctx.pitcherId) add({ id: ctx.pitcherId, reaction: 'concern', intensity: 0.5, talk: 2 });
      if (catcher) add({ id: catcher, talk: 3 });
      break;
    }
    case 'challenge': {
      const m = (ev as { playerId?: string }).playerId;
      if (m) add({ id: m, reaction: 'argue', calmAlt: 'argue', intensity: 1, talk: 5 });
      break;
    }
    case 'pitching_change_start': {
      if (ctx.pitcherId) add({ id: ctx.pitcherId, reaction: 'dejection', intensity: 0.7 });
      break;
    }
  }
  return out;
}

/**
 * The pressure of the moment for one person, 0..1: two strikes on the batter, bases loaded, a late close game (seventh inning on, one run or
 * less) for the batter, the pitcher, the catcher and the managers.
 */
export function tensionFor(role: string, s: { inning: number; score: { away: number; home: number }; runners: [boolean, boolean, boolean]; count: { strikes: number; balls: number } }): number {
  const key = role === 'batter' || role === 'pitcher' || role === 'catcher' || role === 'manager';
  if (!key) return 0;
  let t = 0;
  if (s.runners[0] && s.runners[1] && s.runners[2]) t += 0.4;
  else if (s.runners[1] || s.runners[2]) t += 0.15;
  if (s.inning >= 7 && Math.abs(s.score.away - s.score.home) <= 1) t += 0.3;
  if (role === 'batter' && s.count.strikes === 2) t += 0.25;
  if (role === 'pitcher' && s.count.balls === 3) t += 0.2;
  return Math.min(1, t);
}

/**
 * The built-in AI as a complete `DecisionProvider`: every decision kind answered from the live game state. The heavy lifting
 * lives next to the mechanics it reasons about (pitchai, manager, running, fielding, batting); this file just adapts each
 * of them to the request / decision shapes. Randomness (mixed strategies, judgement noise) comes from `w.aiRng`.
 */
import { aiSwingDecision } from './batting';
import { ctxOf } from './dispatch';
import type { FullDecisionProvider, SwingRequest } from './decisions';
import { callPitch } from './pitchai';
import * as fielding from './fielding';
import * as manager from './manager';
import * as running from './running';
import type { PlayerRT, RunnerRT, TeamRT, World } from './world';
import type { SwingObservation } from './batting';

export function createAI(w: World): FullDecisionProvider {
  return {
    pitch() {
      const c = callPitch(w);
      return { pitchType: c.spec.type, targetX: c.x, targetY: c.y, careful: c.intent === 'middle' };
    },
    pickoff(req) {
      return running.aiPickoff(w, ctxOf<{ r: RunnerRT }>(req).r);
    },
    swing(req: SwingRequest) {
      const { obs } = ctxOf<{ obs: SwingObservation }>(req);
      const B = w.batter!;
      const d = aiSwingDecision(
        B.info,
        { balls: w.count.balls, strikes: w.count.strikes, outs: w.outs, runnersOn: w.runners.some((r) => r.state === 'live'), scoringPosition: w.runners.some((r) => r.state === 'live' && r.base >= 2), inning: w.inning, scoreDiff: w.battingTeam.runs - w.fieldingTeam.runs },
        obs.dPerceived,
      );
      return { swing: d.swing, protect: d.protect };
    },
    bunt() {
      return manager.aiBunt(w);
    },
    lead(req) {
      return running.aiLead(req);
    },
    steal(req) {
      return running.aiSteal(w, ctxOf<{ r: RunnerRT }>(req).r, req);
    },
    runner(req) {
      return running.aiRunner(w, ctxOf<{ r: RunnerRT }>(req).r, req);
    },
    throw(req) {
      const c = ctxOf<{ F: PlayerRT; options: Parameters<typeof fielding.aiThrow>[2] }>(req);
      return fielding.aiThrow(w, c.F, c.options);
    },
    alignment() {
      const runnerThird = w.runners.some((r) => r.state === 'live' && r.base === 3);
      const runnerFirst = w.runners.some((r) => r.state === 'live' && r.base === 1);
      const infieldIn = runnerThird && w.outs < 2 && w.inning >= 7 && Math.abs(w.battingTeam.runs - w.fieldingTeam.runs) <= 1;
      const power = w.batter ? w.batter.info.ratings.power : 50;
      return { infieldIn, doublePlayDepth: runnerFirst && w.outs < 2, outfieldDepth: power > 65 ? 5 : power < 40 ? -4 : 0 };
    },
    pitchingChange(req) {
      const { t } = ctxOf<{ t: TeamRT }>(req);
      const np = manager.aiPitchingChange(w, t);
      return { replaceWith: np ? np.info.id : null };
    },
    pinchHit() {
      const np = manager.aiPinchHitter(w);
      return { playerId: np ? np.info.id : null };
    },
    pinchRun() {
      const c = manager.aiPinchRunner(w);
      return c ? { base: c.r.base, playerId: c.best.info.id } : null;
    },
    intentionalWalk() {
      return { walk: manager.aiIntentionalWalk(w) };
    },
    wallPlay(req) {
      return fielding.aiWallPlay(ctxOf<{ F: PlayerRT }>(req).F, req);
    },
  };
}

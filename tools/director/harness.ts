/**
 * The broadcast director over a whole real game without a browser: the real sim (src/sim through the engine's RealSimAdapter), the real
 * CameraDirector (cameraDirector.ts + broll.ts + reactionShots.ts) and the faces' emotion model (face/emotion.ts + face/reactions.ts, fed the
 * same events the page feeds them), stepped at 60 frames a second of game time. Nothing is rendered: the puppets' head positions are estimated by
 * the director's own fallback, and the dugout bench (the side cast) does not exist here.
 *
 * It records every camera segment and every strong reaction (strikeout, walk, home run, hit by pitch, brushback, error, close-play argument,
 * robbed homer, run scored, pitching change, manager anger) and whether the camera showed the reacting person while the reaction ran.
 * Loaded through vite (`import.meta.glob` in simAdapter.ts): run it with `npx tsx tools/director/measure.ts`.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { createGame } from '../../src/sim/index';
import { CameraDirector } from '../../src/engine/cameraDirector';
import { RealSimAdapter, type RealGame } from '../../src/engine/realSimAdapter';
import { SIM_DT, type SimDriver, type TimedEvent } from '../../src/engine/simAdapter';
import { FaceState, personalityFor, type ReactionName } from '../../src/engine/face/emotion';
import { reactionsFor, type FaceCtx, type FaceEvent } from '../../src/engine/face/reactions';
import type { BroadcastEvent, GameEvent, GameLike, GameState } from '../../src/engine/types';
import type { Stadium } from '../../src/engine/stadium';

const FRAME = 1 / 60;

/** the part of SimDriver the director uses, stepping the sim by whole frames */
class HeadlessDriver {
  speed = 1;
  paused = false;
  hold = false;
  skipping = false;
  tempo: 'broadcast' | 'standard' | 'quick' = 'broadcast';
  readonly history: GameState[] = [];
  private ls = new Set<(e: TimedEvent) => void>();
  private cross = new Set<(x: number, y: number, inZone: boolean) => void>();
  private curr: GameState;
  private acc = 0;
  constructor(readonly game: GameLike) {
    this.curr = game.getState();
    game.on((event) => {
      const te = { simTime: this.curr.time, event };
      for (const l of this.ls) l(te);
    });
  }
  on(cb: (e: TimedEvent) => void) {
    this.ls.add(cb);
    return () => this.ls.delete(cb);
  }
  emit(event: GameEvent) {
    const te = { simTime: this.curr.time, event };
    for (const l of this.ls) l(te);
  }
  onPitchCross(cb: (x: number, y: number, inZone: boolean) => void) {
    this.cross.add(cb);
  }
  get state() {
    return this.curr;
  }
  advance(dt: number) {
    if (this.hold) return this.curr;
    this.acc += dt * this.speed;
    let n = 0;
    while (this.acc >= SIM_DT - 1e-9) {
      this.game.step(SIM_DT);
      this.acc -= SIM_DT;
      n++;
    }
    if (!n) return this.curr;
    const prev = this.curr;
    this.curr = this.game.getState();
    const a = prev.ball, b = this.curr.ball;
    if (b.visible && a.visible && a.pos.z > 0 && b.pos.z <= 0 && b.vel.z < -5) {
      const f = a.pos.z / (a.pos.z - b.pos.z);
      const x = a.pos.x + (b.pos.x - a.pos.x) * f, y = a.pos.y + (b.pos.y - a.pos.y) * f;
      for (const l of this.cross) l(x, y, Math.abs(x) < 0.252 && y > 0.464 && y < 1.086);
    }
    this.history.push(this.curr);
    if (this.history.length > 75 * 60) this.history.splice(0, this.history.length - 75 * 60);
    return this.curr;
  }
}

export interface Segment {
  t0: number;
  t1: number;
  /** the director's shot, with the B-roll / person-shot label when there is one (`broll:faceCloseup`, `toss:kidToss`) */
  shot: string;
  subject?: string;
  /** a person-shot that met a running reaction (the face holds it through the shot) */
  held?: boolean;
  reaction?: string | null;
  /** the sim's phase and time when the shot began */
  phase?: string;
  simTime?: number;
}

export interface StrongReaction {
  /** wall clock (s) of the broadcast (the sim stops during replays) */
  t: number;
  simTime: number;
  inning: string;
  label: string;
  detail?: string;
  /** who reacts in person (not the team-wide mood), with the reaction they show */
  people: { id: string; role: string; reaction: ReactionName | null; delay: number }[];
  /** the camera when it fired and over its reaction window (seconds per shot) */
  camAt: string;
  camWindow: Record<string, number>;
  /** a person-shot of one of them while the reaction ran (and the shot's label) */
  seen: string | null;
  /** 1 s after it: the lull the game is in (kind, seconds left) and whether a ball is still in play */
  after?: { lull: string | null; left: number; inPlay: boolean; shot: string };
}

export interface GameResult {
  seed: number;
  tempo: string;
  gameSeconds: number;
  wallSeconds: number;
  segments: Segment[];
  reactions: StrongReaction[];
  personShots: number;
  reactionShots: number;
  groupShots: number;
  /** the director's own reaction shots (shot kind `reaction`) and those shorter than 2 s (cut short) */
  reactionCuts: number;
  shortReactions: number;
  replays: number;
  cuts: number;
  /** cuts less than a second after the one before */
  quickCuts: number;
}

const STRONG_PA = (r: string) => (r.startsWith('strikeout') ? 'strikeout' : r === 'walk' || r === 'intentional walk' ? 'walk' : r === 'hit by pitch' ? 'hit by pitch' : /double play|triple play/.test(r) ? 'double play' : /^(single|double|triple)$/.test(r) ? 'hit' : null);

export async function runGame(opts: { seed: number; tempo?: 'broadcast' | 'standard' | 'quick'; innings?: number; maxSeconds?: number; reactions?: boolean }): Promise<GameResult> {
  const tempo = opts.tempo ?? 'broadcast';
  const game = new RealSimAdapter(createGame({ seed: opts.seed, tempo, innings: opts.innings ?? 9 } as never) as unknown as RealGame);
  const sim = new HeadlessDriver(game);
  sim.tempo = tempo;
  const camera = new PerspectiveCamera(30, 16 / 9, 0.3, 800);
  const doc = { addEventListener() {}, removeEventListener() {} };
  const dom = { addEventListener() {}, removeEventListener() {}, getRootNode: () => doc, ownerDocument: doc, style: {} } as unknown as HTMLElement;
  const crowdShots = [
    { pos: new Vector3(-60, 8, 20), target: new Vector3(-75, 12, 30) },
    { pos: new Vector3(60, 8, 20), target: new Vector3(75, 12, 30) },
    { pos: new Vector3(-30, 8, -30), target: new Vector3(-40, 12, -45) },
    { pos: new Vector3(30, 8, -30), target: new Vector3(40, 12, -45) },
  ];
  const stadium = { crowdShots } as unknown as Stadium;
  const director = new CameraDirector(camera, sim as unknown as SimDriver, dom, stadium);
  // by day the page gives the director no key lights (the sky fills a face turned from the sun; engine.ts): nothing to plug in here
  director.dugoutShots.push({ pos: new Vector3(23, 3.2, 10), target: new Vector3(26, -0.2, 0) }, { pos: new Vector3(-23, 3.2, 10), target: new Vector3(-26, -0.2, 0) });

  // ---- the faces, as players.ts / gltfCharacter.ts drive them ----
  const faces = new Map<string, FaceState>();
  const faceOf = (id: string, st: GameState) => {
    let f = faces.get(id);
    if (!f) {
      const snap = st.players.find((p) => p.id === id);
      if (!snap) return null;
      f = new FaceState(id, personalityFor(id, snap.ratings, snap.role));
      faces.set(id, f);
    }
    return f;
  };
  let homer: { id: string; t: number } | null = null;
  const ctxOf = (st: GameState): FaceCtx => ({
    half: st.half,
    batterId: st.batter?.id,
    pitcherId: st.pitcher?.id,
    homer: homer && st.time - homer.t < 1 ? homer.id : undefined,
    cast: st.players.map((p) => ({ id: p.id, team: p.team, role: p.role, hand: p.hand })),
  });
  const faceEvent = (ev: GameEvent | FaceEvent, st: GameState) => {
    if (ev.type === 'homerun') homer = { id: (ev as { batterId: string }).batterId, t: st.time };
    const acts = reactionsFor(ev as FaceEvent, ctxOf(st));
    for (const a of acts) {
      const f = faceOf(a.id, st);
      if (!f) continue;
      if (a.mood) f.moodShift(a.mood[0], a.mood[1]);
      const r = a.reaction && a.calmAlt && f.pers.fiery < 0.4 ? a.calmAlt : a.reaction;
      if (r) f.react(r, a.intensity ?? 1, a.delay ?? 0);
    }
    return acts;
  };
  // (off: the director as it was before reaction shots)
  if (opts.reactions !== false) director.reactionLookup = (id) => faces.get(id)?.reactionInfo() ?? null;

  // ---- the record ----
  let wall = 0;
  const segments: Segment[] = [];
  let seg: Segment | null = null;
  let personShots = 0, reactionShots = 0, groupShots = 0, replays = 0, cuts = 0, quickCuts = 0, lastCut = -9;
  const openSeg = (shot: string, subject?: string, held?: boolean, reaction?: string | null) => {
    if (seg) seg.t1 = wall;
    seg = { t0: wall, t1: wall, shot, subject, held, reaction, phase: sim.state.phase, simTime: +sim.state.time.toFixed(2) };
    segments.push(seg);
  };
  director.onBroadcast = (e: BroadcastEvent) => {
    // cut() announces the cut, then the shot it starts (a person-shot names its subject): label the segment the cut opened
    if (e.type === 'cameraCut') {
      openSeg(e.to);
      cuts++;
      if (wall - lastCut < 1) quickCuts++;
      lastCut = wall;
    } else if (e.type === 'replayStart') replays++;
    else if (e.type === 'shot' && e.phase === 'start') {
      if (!seg) openSeg(director.shot);
      const sg = seg!;
      sg.shot = `${sg.shot}:${e.kind}`;
      if (e.subjectId) {
        personShots++;
        const f = faces.get(e.subjectId);
        sg.subject = e.subjectId;
        sg.reaction = f?.reactionInfo()?.name ?? null;
        sg.held = f?.holdFor(e.holdMs / 1000) ?? false;
        if (sg.held) reactionShots++;
      }
      if (e.kind === 'dugoutReaction' || e.kind === 'moundHuddle') groupShots++;
    }
  };
  sim.on((te) => {
    const ev = te.event;
    const st = sim.state;
    const acts = faceEvent(ev, st);
    let label: string | null = null;
    let detail: string | undefined;
    switch (ev.type) {
      case 'pa_end':
        label = STRONG_PA(ev.result);
        detail = ev.result;
        break;
      case 'homerun': label = 'home run'; break;
      case 'robbed_hr': label = 'robbed homer'; break;
      case 'error': label = 'error'; detail = ev.kind; break;
      case 'out': case 'safe': if (ev.closePlay) { label = `close play (${ev.type})`; } break;
      case 'run': label = 'run scored'; break;
      case 'substitution': if (/pitching/.test(ev.reason)) label = 'pitching change'; detail = ev.reason; break;
      case 'challenge': label = 'manager anger'; break;
    }
    if (label) note(label, detail, acts, st);
  });
  sim.onPitchCross((x, y) => {
    const st = sim.state;
    const acts = faceEvent({ type: 'pitch_crossed', x, y }, st);
    if (acts.some((a) => a.reaction === 'flinch')) note('brushback', undefined, acts, st);
  });
  const reactions: StrongReaction[] = [];
  function note(label: string, detail: string | undefined, acts: ReturnType<typeof reactionsFor>, st: GameState) {
    const people = acts.filter((a) => a.reaction && !/^(bench|manager|pitchcoach|bullpen|reliever|coach)/.test(st.players.find((p) => p.id === a.id)?.role ?? '') || (label === 'manager anger' && a.reaction))
      .map((a) => ({ id: a.id, role: st.players.find((p) => p.id === a.id)?.role ?? '?', reaction: (a.reaction ?? null) as ReactionName | null, delay: a.delay ?? 0 }));
    reactions.push({ t: wall, simTime: +st.time.toFixed(2), inning: `${st.half === 'top' ? 'T' : 'B'}${st.inning}`, label, detail, people, camAt: '', camWindow: {}, seen: null });
  }

  // ---- the loop ----
  const positions = new Map<string, Vector3>();
  const ball = new Vector3();
  const maxT = opts.maxSeconds ?? 20000;
  while (!sim.state.over && sim.state.time < maxT) {
    wall += FRAME;
    const live = sim.advance(FRAME);
    for (const p of live.players) (positions.get(p.id) ?? positions.set(p.id, new Vector3()).get(p.id)!).set(p.pos.x, p.pos.y, p.pos.z);
    ball.set(live.ball.pos.x, live.ball.pos.y, live.ball.pos.z);
    const out = director.update(FRAME, live, ball, positions);
    // the faces' clocks run with the animation (slower in a slow-motion replay), as in engine.ts
    for (let i = reactions.length - 1; i >= 0 && wall - reactions[i].t < 1.2; i--) {
      const r = reactions[i];
      if (r.after || wall - r.t < 1) continue;
      const li = director.lullInfo;
      r.after = { lull: li?.kind ?? null, left: +(li?.remaining ?? 0).toFixed(1), inPlay: (director as unknown as { inPlay: boolean }).inPlay, shot: out.shot };
    }
    const k = out.replaying ? out.replaySpeed : 1;
    for (const f of faces.values()) f.tick(FRAME * k);
  }
  if (seg) (seg as Segment).t1 = wall;

  // ---- what the camera showed around each reaction ----
  const shotAt = (t: number) => {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (segments[m].t0 <= t) lo = m;
      else hi = m - 1;
    }
    return lo;
  };
  for (const r of reactions) {
    const span = Math.max(3, ...r.people.map((p) => p.delay + 3));
    const i0 = shotAt(r.t);
    r.camAt = segments[i0]?.shot ?? '?';
    for (let i = i0; i < segments.length && segments[i].t0 < r.t + span; i++) {
      const s = segments[i];
      const dur = Math.min(s.t1, r.t + span) - Math.max(s.t0, r.t);
      if (dur > 0) r.camWindow[s.shot] = +((r.camWindow[s.shot] ?? 0) + dur).toFixed(2);
      if (!r.seen && s.subject && s.held && r.people.some((p) => p.id === s.subject)) r.seen = s.shot;
      if (!r.seen && s.shot.endsWith('dugoutReaction') && (r.label === 'run scored' || r.label === 'home run')) r.seen = s.shot;
    }
  }
  const reacts = segments.filter((s) => s.shot.endsWith(':reaction'));
  return {
    seed: opts.seed, tempo, gameSeconds: +sim.state.time.toFixed(1), wallSeconds: +wall.toFixed(1), segments, reactions, personShots, reactionShots, groupShots,
    reactionCuts: reacts.length, shortReactions: reacts.filter((s) => s.t1 - s.t0 < 2).length, replays, cuts, quickCuts,
  };
}

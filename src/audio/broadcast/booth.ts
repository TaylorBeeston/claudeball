/**
 * The booth: ties the game log, the lexicon (calls for events), the conversation topics and the director together.
 *
 *   observe(event, ctx)  -> updates the log, submits the calls for the event to the director
 *   tick(t, ctx, flags)  -> the director's actions (start / cut) for the sink
 *
 * Pure (no audio): `channels.ts` executes the actions with the speech engines.
 */
import type { RawEvent } from '../types';
import { Director, type Action, type Level, type Topic } from './director';
import { GameLog } from './gamelog';
import { callsFor, LEX, type Call, type Env } from './lexicon';
import { TopicPicker } from './stories';
import { factsFor, type LmSource } from './lm';
import { lastNameOf } from './ctx';
import { say } from './grammar';
import type { BoothCtx } from './ctx';
import { handoffLine, openingSegment, type OpeningFacts } from './pregame';

export interface BoothOpts {
  rng: () => number;
  level?: Level;
}

export class Booth {
  readonly log = new GameLog();
  readonly director: Director;
  private picker: TopicPicker;
  private ctx: BoothCtx | null = null;
  private rng: () => number;
  private epoch = 0;
  /** optional tiny language model for colour lines (experimental, off by default): its validated line is used now and then, else the grammar speaks */
  lm: LmSource | null = null;
  private recentSaid: string[] = [];
  /** where the game is: topics only start when the game is between pitches */
  canTalk = true;
  private live = { balls: 0, strikes: 0, outs: 0, batterId: '' as string | undefined };
  /** a transcript of what was scheduled (debug / tests / the report) */
  readonly transcript: { t: number; voice: string; text: string; tag?: string; imp: string }[] = [];
  private env: Env;
  /** who and where (park, officials, records, weather): the controller sets it when the game is known; null: no opening segment */
  private facts: OpeningFacts | null = null;
  /** seconds the PA's welcome takes at the start of the pregame: the booth's opening starts after it */
  private lead = 0;
  /** the user's chatter level (the director's may be lowered for a while, e.g. under break music) */
  private userLevel: Level;
  /** the pregame: from gameStart until the handoff into the top of the first */
  pregame: 'none' | 'waiting' | 'opening' | 'done' = 'none';
  private handoffAt: number | null = null;
  private fieldIdleSince = -99;

  constructor(o: BoothOpts) {
    this.rng = o.rng;
    this.picker = new TopicPicker(o.rng);
    this.director = new Director({ rng: o.rng, level: o.level ?? 'normal', topicSource: () => this.nextTopic() });
    this.env = { rng: o.rng, epoch: () => this.epoch, live: () => this.live };
    this.userLevel = o.level ?? 'normal';
  }

  /** the game's facts for the opening (and later segments); `lead`: seconds of PA welcome before the booth starts */
  setFacts(f: OpeningFacts | null, lead = 0) {
    this.facts = f;
    this.lead = lead;
  }
  get openingFacts() {
    return this.facts;
  }

  /** start the opening segment now: `sec` seconds of pregame left */
  private startOpening(t: number, sec: number) {
    if (!this.facts || this.pregame === 'opening' || this.pregame === 'done') return;
    const lead = Math.min(this.lead, Math.max(0, sec - 8));
    const seg = openingSegment(this.facts, { budget: Math.max(4, sec - lead - 1), level: this.userLevel });
    if (seg.turns[0]) seg.turns[0] = { ...seg.turns[0], notBefore: lead };
    this.director.runSegment(seg, t, t + sec - 1);
    // (a quiet booth, e.g. audio not unlocked yet, does not take it: the opening then starts from the lull once it can talk)
    if (this.director.segmentActive) this.pregame = 'opening';
  }

  private handoff(t: number, c: BoothCtx) {
    if (this.pregame !== 'opening' && this.pregame !== 'waiting') return;
    this.pregame = 'done';
    this.handoffAt = null;
    this.director.endSegment();
    if (!this.facts) return;
    const text = handoffLine(this.facts, c.batter ? lastNameOf(c.batter.name) : undefined, c.pitcher ? lastNameOf(c.pitcher.name) : undefined);
    this.director.submit({ importance: 'must', speaker: 'pxp', text, ttl: 20, tag: 'open.handoff' }, t);
  }

  private nextTopic(): Topic | null {
    const c = this.ctx;
    if (!c || !this.canTalk || this.pregame === 'waiting' || this.pregame === 'opening') return null;
    const tense = c.inning >= 7 && Math.abs(c.score.home - c.score.away) <= 2 || (c.runners[1] || c.runners[2]) && c.outs === 2;
    if (this.lm) {
      const line = this.rng() < 0.5 ? this.lm.take() : null;
      this.lm.prepare(factsFor(c, this.log, this.recentSaid)); // precompute the next one while the game is busy
      if (line) return { id: -1, tag: 'lm', turns: [{ speaker: 'color', text: line }] };
    }
    return this.picker.next(this.log, c, !!tense);
  }

  /** feed every sim event (before `tick`) */
  observe(ev: RawEvent, c: BoothCtx, t: number) {
    this.ctx = c;
    this.live = { balls: c.balls, strikes: c.strikes, outs: this.log.outs, batterId: c.batter?.id };
    if (ev.type === 'pitchReleased' || ev.type === 'batterUp') this.epoch++;
    this.director.setEpoch(this.epoch);
    this.log.observe(ev, c);
    // the pregame: the opening segment while the teams take the field, then the handoff at the umpire's "play ball"
    if (this.facts) {
      if (ev.type === 'gameStart' && this.pregame === 'none') this.pregame = 'waiting';
      if (ev.type === 'breakStart' && (ev.pregame || (ev.inning === 1 && ev.half === 'top' && this.log.pitches.length === 0)) && this.pregame === 'waiting') this.startOpening(t, Number(ev.sec) || 20);
      if (ev.type === 'umpireCall' && ev.kind === 'play_ball') this.handoffAt = t + 0.3;
      if (ev.type === 'batterUp' && (this.pregame === 'opening' || this.pregame === 'waiting')) this.handoffAt ??= t + 1.5; // (an older sim without "play ball")
      if (ev.type === 'pitchReleased' && this.pregame !== 'done' && this.pregame !== 'none') this.handoff(t, c);
    }
    if (ev.type === 'call') {
      // the count the fold will speak: after this call
      const cl = (ev.call ?? {}) as { kind?: string; balls?: number; strikes?: number };
      let b = cl.balls ?? c.balls;
      let s = cl.strikes ?? c.strikes;
      if (cl.kind === 'ball') b++;
      else if (cl.kind === 'strikeLooking' || cl.kind === 'strikeSwinging') s++;
      else if ((cl.kind === 'foul' || cl.kind === 'foulTip') && s < 2) s++;
      this.live = { ...this.live, balls: Math.min(3, b), strikes: Math.min(2, s) };
    }
    if (ev.type === 'batterUp' || ev.type === 'halfInningStart') this.live = { ...this.live, balls: 0, strikes: 0 };
    for (const call of callsFor(ev, c, this.log, this.env)) {
      if (!call.text) continue;
      // the opening replaces "here we go" / "the top of the 1st" / the first batter's intro: the handoff says it
      if ((this.pregame === 'waiting' || this.pregame === 'opening') && call.importance === 'could') continue;
      if (this.pregame !== 'none' && (call.tag === 'start' || (c.inning === 1 && c.half === 'top' && (call.tag === 'half.start' || (call.tag === 'batter.up' && this.log.pitches.length === 0))))) continue;
      this.director.submit({ importance: call.importance, speaker: call.speaker, text: call.text, ttl: call.ttl, excited: call.excited, fold: call.fold, foldable: call.foldable, tag: call.tag }, t);
      this.maybeReact(call, t);
      if (call.react) this.director.submit({ importance: 'could', speaker: 'color', text: call.react, ttl: 4, interject: true, excited: true, tag: 'react' }, t);
    }
  }

  /** the analyst chimes in over the last words of a big call, now and then (more at chatter High) */
  private reactP = 0.35;
  private maybeReact(call: Call, t: number) {
    if (call.importance !== 'must' || call.react) return;
    const tag = call.tag;
    const key = tag.startsWith('strikeout') ? 'react.k' : tag.startsWith('hit.') ? 'react.hit' : tag.startsWith('error') ? 'react.err' : tag.startsWith('out.') && !tag.startsWith('out.dp') && !tag.startsWith('out.tp') ? 'react.out' : tag.startsWith('out.dp') || tag.startsWith('out.tp') || tag === 'robbed' || tag === 'hr.slam' || tag === 'hr.walkoff' ? 'react.big' : null;
    if (!key || this.rng() > this.reactP) return;
    const text = say(LEX[key], {}, this.rng);
    if (text) this.director.submit({ importance: 'could', speaker: 'color', text, ttl: 4, interject: true, excited: key === 'react.big', tag: key }, t);
  }

  /** the user's chatter setting */
  setUserLevel(l: Level) {
    this.userLevel = l;
  }

  setLevel(l: Level) {
    this.director.setLevel(l);
    this.reactP = l === 'high' ? 0.6 : l === 'low' ? 0 : 0.35;
  }

  /** the broadcast cut to a replay */
  replay(c: BoothCtx, t: number) {
    const text = say(LEX['replay.pxp'], {}, this.rng);
    if (text) this.director.submit({ importance: 'should', speaker: 'pxp', text, ttl: 6, tag: 'replay' }, t);
  }

  tick(t: number, c: BoothCtx, opts: { suppressed: boolean; fieldHold?: boolean }): Action[] {
    this.ctx = c;
    this.director.holdForField = !!opts.fieldHold;
    const out: Action[] = this.director.setSuppressed(opts.suppressed, t);
    // the handoff answers the umpire's "Play ball!": with voices that cannot overlap it waits until the PA / umpire have been quiet for a moment
    if (opts.fieldHold) this.fieldIdleSince = Infinity;
    else if (this.fieldIdleSince === Infinity) this.fieldIdleSince = t;
    if (this.handoffAt !== null && t >= this.handoffAt && t - this.fieldIdleSince >= 0.8) this.handoff(t, c);
    // a segment that was cut short by a pause / mute resumes while its lull lasts, else it is dropped
    if (this.director.parked && !opts.suppressed) {
      const left = c.lull?.kind === 'break' ? c.lull.remaining ?? 0 : 0;
      if (left > 4) this.director.resumeSegment(t, t + left - 1);
      else this.director.parked = null;
    }
    // joined late (the audio started during the pregame): open from the snapshot's lull
    if (this.facts && this.pregame !== 'opening' && this.pregame !== 'done' && !opts.suppressed && c.lull?.kind === 'break' && c.inning === 1 && c.half === 'top' && this.log.pitches.length === 0 && (c.lull.remaining ?? 0) > 8) {
      this.lead = 0;
      this.startOpening(t, c.lull.remaining!);
    }
    if (!opts.suppressed) out.push(...this.director.tick(t));
    for (const a of out) if (a.type === 'start') this.recentSaid = [...this.recentSaid, a.clauses.map((x) => x.text).join(' ')].slice(-4);
    for (const a of out) if (a.type === 'start') this.transcript.push({ t, voice: a.voice, text: a.clauses.map((x) => x.text).join(' '), tag: a.item.tag, imp: a.item.importance });
    if (this.transcript.length > 400) this.transcript.splice(0, this.transcript.length - 400);
    return out;
  }
}

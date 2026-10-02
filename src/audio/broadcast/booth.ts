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
import { say } from './grammar';
import type { BoothCtx } from './ctx';

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
  /** where the game is: topics only start when the game is between pitches */
  canTalk = true;
  private live = { balls: 0, strikes: 0, outs: 0, batterId: '' as string | undefined };
  /** a transcript of what was scheduled (debug / tests / the report) */
  readonly transcript: { t: number; voice: string; text: string; tag?: string; imp: string }[] = [];
  private env: Env;

  constructor(o: BoothOpts) {
    this.rng = o.rng;
    this.picker = new TopicPicker(o.rng);
    this.director = new Director({ rng: o.rng, level: o.level ?? 'normal', topicSource: () => this.nextTopic() });
    this.env = { rng: o.rng, epoch: () => this.epoch, live: () => this.live };
  }

  private nextTopic(): Topic | null {
    const c = this.ctx;
    if (!c || !this.canTalk) return null;
    const tense = c.inning >= 7 && Math.abs(c.score.home - c.score.away) <= 2 || (c.runners[1] || c.runners[2]) && c.outs === 2;
    return this.picker.next(this.log, c, !!tense);
  }

  /** feed every sim event (before `tick`) */
  observe(ev: RawEvent, c: BoothCtx, t: number) {
    this.ctx = c;
    this.live = { balls: c.balls, strikes: c.strikes, outs: this.log.outs, batterId: c.batter?.id };
    if (ev.type === 'pitchReleased' || ev.type === 'batterUp') this.epoch++;
    this.director.setEpoch(this.epoch);
    this.log.observe(ev, c);
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

  setLevel(l: Level) {
    this.director.setLevel(l);
    this.reactP = l === 'high' ? 0.6 : l === 'low' ? 0 : 0.35;
  }

  /** the broadcast cut to a replay */
  replay(c: BoothCtx, t: number) {
    const text = say(LEX['replay.pxp'], {}, this.rng);
    if (text) this.director.submit({ importance: 'should', speaker: 'pxp', text, ttl: 6, tag: 'replay' }, t);
  }

  tick(t: number, c: BoothCtx, opts: { suppressed: boolean }): Action[] {
    this.ctx = c;
    const out: Action[] = this.director.setSuppressed(opts.suppressed, t);
    if (!opts.suppressed) out.push(...this.director.tick(t));
    for (const a of out) if (a.type === 'start') this.transcript.push({ t, voice: a.voice, text: a.clauses.map((x) => x.text).join(' '), tag: a.item.tag, imp: a.item.importance });
    if (this.transcript.length > 400) this.transcript.splice(0, this.transcript.length - 400);
    return out;
  }
}

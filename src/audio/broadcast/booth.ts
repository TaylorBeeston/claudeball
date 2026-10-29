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
import { TopicPicker, script, slotsOf, type Story } from './stories';
import { breakSegment, closingSegment, jokeTurns, lastTimeUp, promoLines, type Box } from './segments';
import { CATCHPHRASES, RUNNING_JOKES, CAST, type RunningJoke } from './cast';
import { pitcherNote } from './pregame';
import { factsFor, type LmSource } from './lm';
import { lastNameOf } from './ctx';
import { say } from './grammar';
import type { BoothCtx } from './ctx';
import { handoffLine, openingSegment, type OpeningFacts } from './pregame';
import { BoothMemory, withMemory } from './memory';
import { ANECDOTES, type Anecdote, type AnecdoteWhen } from './anecdotes';

/** running jokes begun in one game (the stages of a begun joke still come back) */
const MAX_JOKES = 4;
const numW = (n: number) => ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
/** the booth's own stories: at most this many a game, this many seconds apart */
const MAX_ANECDOTES = 10;
const ANECDOTE_GAP = 240;

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
  /** the pregame's length (the closing is sized like it: a Quick game gets a short wrap-up) */
  private pregameSec = 0;
  /** a break between half innings waiting to be said (it starts as soon as the booth can talk; the stretch break after the organ) */
  private pendingBreak: { inning: number; half: 'top' | 'bottom'; sec: number; at: number; stretch: boolean; sawQuiet: boolean; pitcherId?: string } | null = null;
  private breaks = 0;
  private lastHalfPitcher: string | undefined;
  /** catchphrases: uses this game and when */
  private phraseUse = new Map<string, { n: number; at: number }>();
  /** running jokes: the next stage and when the last one was told */
  private jokeState = new Map<string, { stage: number; at: number }>();
  /** things that happened that a joke or a story can pick up (a steal, a mound visit, a pitching change) */
  private recent: { steal?: number; visitBy?: string; visitAt?: number; error?: { inning: number; half: 'top' | 'bottom' }; change?: { outId: string; inId: string; pitches: number; runs: number; side: 'home' | 'away'; at: number } } = {};
  /** the booth's own stories told this game, and when the last one was */
  private told = { anecdotes: new Set<string>(), at: -1e9 };
  /** errors this game: by whom and when (a callback when he comes to bat) */
  private errors: { fielderId: string; inning: number }[] = [];
  /** running jokes begun this game (a few a game: which ones is up to the memory) */
  private jokesBegun = 0;
  /** the last 150 lines said (any voice, calls included): a new line with the same words is re-worded or skipped */
  private said: string[] = [];
  /** every break line said this game (a promo or a joke-free filler is not said twice in a game) */
  private segSaid = new Set<string>();
  private now = 0;
  private closed = false;
  /**
   * a home run is being trotted out: the runs count only as each runner touches home, so the game situation still shows the runners
   * on base and the old score; no conversation topic starts until the next batter is up (it used to say "two out, runner in scoring
   * position" and "a chance to be the hero" over the trot, "it is tight in the ninth, 7-7" after a walk-off)
   */
  private trotting = false;

  /**
   * What the booth has said, this game and (when the app shares one memory between games, `sharedMemory()`) the games before: every template, story
   * and joke it picks prefers the one heard longest ago. A fresh booth has its own memory.
   */
  private mem = new BoothMemory();
  get memory(): BoothMemory {
    return this.mem;
  }
  set memory(m: BoothMemory) {
    this.mem = m;
    m.beginGame();
    this.nameFacts();
  }
  /** the names the memory masks out of its keys: the game's clubs, park, officials and lineups (players who come in later: as they appear) */
  private nameFacts() {
    const f = this.facts;
    if (!f) return;
    const club = (c: OpeningFacts['home']) => [c.name, c.city, c.nick, c.manager?.name, c.manager?.pitchingCoach, c.starter?.name, ...c.lineup.map((x) => x.name)];
    this.mem.addNames([f.venue?.name, f.venue?.short, f.venue?.city, f.mascot, ...(f.umpires ?? []).map((u) => u.name), ...club(f.home), ...club(f.away)]);
  }
  private named = new Set<string>();

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
    this.nameFacts();
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
    if (!c || !this.canTalk || this.closed || this.trotting || this.pendingBreak || this.pregame === 'waiting' || this.pregame === 'opening') return null;
    const tense = c.inning >= 7 && Math.abs(c.score.home - c.score.away) <= 2 || (c.runners[1] || c.runners[2]) && c.outs === 2;
    if (this.lm) {
      const line = this.rng() < 0.5 ? this.lm.take() : null;
      this.lm.prepare(factsFor(c, this.log, this.recentSaid)); // precompute the next one while the game is busy
      if (line) return { id: -1, tag: 'lm', turns: [{ speaker: 'color', text: line }] };
    }
    // a pitching change's lull is long, but the change itself is called first: long talk waits for it
    const changeCalled = !!this.recent.change && this.now - this.recent.change.at < 90;
    const lull = c.lull && c.lull.kind !== 'betweenPitches' && c.lull.kind !== 'break' && (c.lull.kind !== 'pitchingChange' || changeCalled) ? c.lull.remaining ?? 0 : 0;
    const topic = this.picker.next(this.log, c, !!tense, { extra: this.extraStories(c, lull), maxTurns: lull >= 15 ? 6 : 4, fresh: (x) => !this.said.includes(x) });
    // (the picker re-words a story whose lines were said recently; what still repeats is not said)
    return topic && topic.turns.some((x) => this.said.includes(x.text)) ? null : topic;
  }

  /**
   * A running joke that fits now (its trigger, the gap since its last stage, a stage left). Of the jokes not yet begun, the one heard longest ago
   * (the memory spans games) is offered, and only a few are begun in a game.
   */
  private jokeFor(trigger: RunningJoke['trigger'], t: number): { joke: RunningJoke; stage: number } | null {
    const fits = RUNNING_JOKES.filter((j) => {
      if (j.trigger !== trigger) return false;
      const st = this.jokeState.get(j.id) ?? { stage: 0, at: -1e9 };
      return st.stage < j.stages.length && t - st.at >= j.gap && (st.stage > 0 || this.jokesBegun < MAX_JOKES);
    });
    // a joke under way goes on before a new one starts
    const going = fits.find((j) => (this.jokeState.get(j.id)?.stage ?? 0) > 0);
    const j = going ?? fits[this.mem.order(fits.map((x) => `joke:${x.id}`), this.rng)[0]];
    return j ? { joke: j, stage: this.jokeState.get(j.id)?.stage ?? 0 } : null;
  }
  private toldJoke(j: { joke: RunningJoke; stage: number }, t: number) {
    if (j.stage === 0) {
      this.jokesBegun++;
      this.mem.use(`joke:${j.joke.id}`);
    }
    this.jokeState.set(j.joke.id, { stage: j.stage + 1, at: t });
  }

  /** what kind of moment this is, for the booth's own stories (`anecdotes.ts`) */
  private momentKinds(c: BoothCtx): Set<AnecdoteWhen> {
    const t = this.now;
    const k = new Set<AnecdoteWhen>();
    const diff = Math.abs(c.score.home - c.score.away);
    const inHalf = (m: { inning: number; half: 'top' | 'bottom' }) => m.inning === c.inning && m.half === c.half;
    if (c.inning >= 2) k.add('lull');
    if (c.inning <= 3) k.add('early');
    if ((c.batter && c.person?.(c.batter.id)?.role === 'catcher') || (this.recent.visitBy === 'catcher' && t - (this.recent.visitAt ?? -99) < 30)) k.add('catcher');
    if (t - (this.recent.visitAt ?? -99) < 30) k.add('visit');
    if (this.recent.change && t - this.recent.change.at < 90) k.add('change');
    if (this.facts?.tod === 'day') k.add('day');
    if (this.facts?.tod === 'night') k.add('night');
    if (diff >= 6 && c.inning >= 5) k.add('blowout');
    if (c.score.home + c.score.away === 0 && c.inning >= 4) k.add('scoreless');
    if (this.recent.steal !== undefined && t - this.recent.steal < 40) k.add('steal');
    if (this.log.moments.some((m) => m.kind === 'hr' && inHalf(m))) k.add('homer');
    if (this.log.moments.some((m) => m.kind === 'doublePlay' && inHalf(m))) k.add('dp');
    if (this.recent.error && inHalf(this.recent.error)) k.add('error');
    if (c.inning >= 10) k.add('extra');
    if ((c.pitcher?.pit?.so ?? 0) >= 6) k.add('strikeouts');
    return k;
  }

  /** a booth story for this moment: one that fits it (one made for the moment first), heard longest ago, not told yet this game */
  private anecdote(c: BoothCtx): Anecdote | null {
    const kinds = this.momentKinds(c);
    const ok = (a: Anecdote) => kinds.has(a.when) && !this.told.anecdotes.has(a.id) && (!a.lines.some((l) => l.t.some((x) => x.includes('$mascot'))) || !!this.facts?.mascot);
    const key = (a: Anecdote) => `anecdote:${a.id}`;
    const special = ANECDOTES.filter((a) => a.when !== 'lull' && ok(a));
    const any = ANECDOTES.filter(ok);
    const sp = special[this.mem.order(special.map(key), this.rng)[0]];
    // (a story made for the moment, unless the listener heard it lately and a general one is fresher)
    if (sp && this.mem.age(key(sp)) >= 5000) return sp;
    return any[this.mem.order(any.map(key), this.rng)[0]] ?? sp ?? null;
  }

  /**
   * The booth's own stories on top of the game log's: a callback to the hitter's last trip, the running jokes when their moment comes, the
   * starters' scouting reports and the clubs' form in long lulls, and a light disagreement over a pitching change.
   */
  private extraStories(c: BoothCtx, lull: number): Story[] {
    const out: Story[] = [];
    const t = this.now;
    const S = slotsOf(c);
    const name = (id: string) => {
      const p = c.person?.(id);
      return p ? lastNameOf(p.name) : undefined;
    };
    // callbacks: the hitter's last time up
    const bat = c.batter;
    if (bat && c.balls + c.strikes === 0) {
      const cb = lastTimeUp(this.log, bat.id, name);
      if (cb)
        // (a home-run callback and "he already has a homer tonight" are the same fact: one key)
        out.push({ id: 'callback', key: /homered/.test(cb) && bat.bat?.hr ? `hr:${bat.id}:${bat.bat.hr}` : `cb:${bat.id}:${this.log.batterPas(bat.id).length}`, salience: 0.62, relevance: 1, opener: 'pxp', build: (rng, o) => script([
          { who: 'A', t: [cb] },
          { who: 'B', t: /struck out/.test(cb) ? ['He will want this one back.', '$p has had his number so far.', 'He has to shorten up with two strikes.', 'He will be looking to put this one in play.', 'He is due.'] : /double play/.test(cb) ? ['He would like a different result this time.', 'Anything in the air would do this time.', 'He will want to stay off the ground ball.'] : /error/.test(cb) ? ['A little gift last time.', 'He will take it, but he would rather earn one.'] : /walked/.test(cb) ? ['$p has not given him much to hit.', 'A good eye tonight.', 'He has been patient up there.'] : ['He will be looking for more of the same.', '$p will remember that one.', "Let's see if he can do it again.", 'He has been seeing it well.', 'The pitcher has to make an adjustment.', 'Pitch him carefully.'], opt: true },
        ], S, rng, o) });
      // the fielder who made an error comes to bat
      const err = this.errors.find((e) => e.fielderId === bat.id);
      if (err)
        out.push({ id: 'callbackError', key: `cbe:${bat.id}:${err.inning}`, salience: 0.58, relevance: 1, opener: 'pxp', build: (rng, o) => script([
          { who: 'A', t: [`${lastNameOf(bat.name)} was charged with the error in the ${['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'][err.inning - 1] ?? 'early innings'}.`, `Here is ${lastNameOf(bat.name)}, who made the error in the field.`] },
          { who: 'B', t: ['A chance to make up for it at the plate.', 'Nothing erases an error like a base hit.', 'He will want to get that one back.'], opt: true },
        ], S, rng, o) });
      // the man who robbed a home run comes to bat
      const robbed = this.log.moments.find((m) => m.kind === 'robbed' && m.fielderId === bat.id);
      if (robbed && name(robbed.batterId))
        out.push({ id: 'callbackRobbed', key: `cbr:${bat.id}:${robbed.inning}`, salience: 0.7, relevance: 1, opener: 'color', build: (rng, o) => script([
          { who: 'A', t: [`That is the man who took a home run away from ${name(robbed.batterId)} back in the ${S.ord && robbed.inning ? ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'][robbed.inning - 1] ?? 'early innings' : 'early innings'}.`] },
          { who: 'B', t: ['The crowd has not forgotten, and neither has he.', 'Still the play of the game, $other.'], opt: true },
        ], S, rng, o) });
    }
    // running jokes
    const jokeStory = (j: { joke: RunningJoke; stage: number } | null, sal: number): Story | null =>
      j ? { id: `joke.${j.joke.id}`, key: `joke:${j.joke.id}:${j.stage}`, salience: sal, relevance: 0.8, opener: j.joke.a === 'pbp' ? 'pxp' : 'color', build: (rng) => {
        this.toldJoke(j, t);
        return jokeTurns(j.joke, j.stage, rng);
      } } : null;
    const isCatcher = bat ? c.person?.(bat.id)?.role === 'catcher' : false;
    if (isCatcher && c.inning >= 2) out.push(jokeStory(this.jokeFor('catcherBats', t), 0.68)!);
    if (this.recent.steal !== undefined && t - this.recent.steal < 40) out.push(jokeStory(this.jokeFor('stolenBase', t), 0.66)!);
    if (lull >= 12 && c.inning >= 3) out.push(jokeStory(this.jokeFor('foodLull', t), 0.7)!, jokeStory(this.jokeFor('lull', t), 0.65)!);
    if (t - (this.recent.visitAt ?? -99) < 30 && lull >= 10) out.push(jokeStory(this.jokeFor('moundVisit', t), 0.62)!);
    if (this.recent.change && t - this.recent.change.at < 90 && lull >= 12) out.push(jokeStory(this.jokeFor('pitchingChange', t), 0.6)!);
    // the booth's own stories: in a long lull, now and then (one every few innings, a handful a game)
    const tense = (c.inning >= 7 && Math.abs(c.score.home - c.score.away) <= 2) || ((c.runners[1] || c.runners[2]) && c.outs === 2);
    if (lull >= 10 && !tense && t - this.told.at >= ANECDOTE_GAP && this.told.anecdotes.size < MAX_ANECDOTES) {
      const a = this.anecdote(c);
      if (a)
        out.push({ id: `anecdote.${a.id}`, key: `anecdote:${a.id}`, salience: a.when === 'lull' || a.when === 'early' || a.when === 'day' || a.when === 'night' ? 0.5 : 0.6, relevance: 0.6, opener: a.a, build: (rng, o) => {
          const turns = script(a.lines, { ...S, mascot: this.facts?.mascot }, rng, o);
          if (turns) {
            this.told.anecdotes.add(a.id);
            this.told.at = t;
            this.mem.use(`anecdote:${a.id}`);
          }
          return turns;
        } });
    }
    // a catcher's tangent on a catcher's mound visit
    if (this.recent.visitBy === 'catcher' && t - (this.recent.visitAt ?? -99) < 30)
      out.push({ id: 'visitTangent', key: `vt:${Math.floor((this.recent.visitAt ?? 0) / 60)}`, salience: 0.6, relevance: 0.9, opener: 'pxp', build: (rng, o) => script([
        { who: 'A', t: ['The catcher goes out to talk it over. What are they saying out there, $other?', 'A visit from the catcher. You made a few of those, $other.'] },
        { who: 'B', t: ['Half the time you are buying time for the bullpen. The other half you are asking what he wants for dinner.', 'Usually it is: slow down, breathe, trust the sign. Sometimes it is: where are we eating after the game.'] },
        { who: 'A', t: ['Spoken like a man who made a lot of those trips.', 'And which one is this?'], opt: true },
      ], S, rng, o) });
    // second-guessing the move: Biscuit (the catcher) defends the pitcher he would have kept, Lyle sides with the manager, or they agree
    const ch = this.recent.change;
    if (ch && t - ch.at < 60) {
      const outN = name(ch.outId);
      const inN = name(ch.inId);
      const mgr = this.facts?.[ch.side]?.manager?.name.split(' ')[1];
      if (outN && inN)
        out.push({ id: 'secondGuess', key: `sg:${ch.outId}`, salience: 0.72, relevance: 1, opener: 'color', build: (rng, o) =>
          ch.pitches < 90 && ch.runs <= 2
            ? script([
                { who: 'A', t: [`I would have let ${outN} face one more, $other. ${ch.pitches} pitches, and he was still throwing strikes.`, `I am not sure I make that move. ${outN} was at ${ch.pitches} pitches.`] },
                { who: 'B', t: [`I see it the other way. ${inN} is fresh, and ${mgr ? `${mgr} has` : 'they have'} been waiting on this spot.`, `Not me. I take the fresh arm there every time, and ${inN} is ready.`] },
                { who: 'A', t: ['Well, that is why he manages and I talk.', 'We will find out who is right in about two minutes.'] },
              ], S, rng, o)
            : script([
                { who: 'A', t: [`${outN} was done. ${ch.pitches} pitches, and he was laboring.`, `Right time for that one. ${outN} gave them what he had.`] },
                { who: 'B', t: ['No argument from me.', `Agreed. ${inN} takes it from here.`] },
              ], S, rng, o) });
    }
    // long lulls: the starters' scouting reports and the clubs' form coming in (said once each)
    if (lull >= 15 && this.facts) {
      for (const side of ['home', 'away'] as const) {
        const club = this.facts[side];
        const sp = club.starter;
        if (sp && c.pitcher && lastNameOf(c.pitcher.name) === sp.last) {
          const n = pitcherNote(sp, this.rng);
          if (n.best)
            out.push({ id: 'scouting', key: `scout:${sp.last}`, salience: 0.55, relevance: 0.7, opener: 'pxp', build: (rng, o) => script([
              { who: 'A', t: [`What makes ${sp.last} go, $other?`, `Tell me about ${sp.last}, $other.`] },
              { who: 'B', t: [`${n.best ? n.best.charAt(0).toUpperCase() + n.best.slice(1) : ''}. When it is on, hitters are guessing.`] },
              { who: 'A', t: ['And tonight?', 'Is it on tonight?'], opt: true },
              { who: 'B', t: [c.pitcher?.pit && c.pitcher.pit.so >= 4 ? `${c.pitcher.pit.so} strikeouts says yes.` : 'Ask me again in a couple of innings.'], opt: true },
            ], S, rng, o) });
        }
        const rec = club.record;
        if (rec && rec.streak.n >= 3)
          out.push({ id: 'form', key: `form:${side}`, salience: 0.45, relevance: 0.4, opener: 'pxp', build: (rng, o) => script([
            { who: 'A', t: [`The ${club.nick} came in ${rec.streak.kind === 'W' ? `winners of ${rec.streak.n} straight` : `having lost ${rec.streak.n} in a row`}.`] },
            { who: 'B', t: [rec.streak.kind === 'W' ? 'A winning clubhouse is a loose clubhouse. You can see it in the dugout.' : 'You can feel a losing streak in the dugout. Everybody is pressing.'] },
          ], S, rng, o) });
      }
      // the season so far: the clubs' records coming in, against what tonight looks like
      const hr = this.facts.home.record;
      const ar = this.facts.away.record;
      if (hr && ar && c.inning >= 3) {
        const H = this.facts.home.nick;
        const A = this.facts.away.nick;
        const better = hr.w - hr.l > ar.w - ar.l + 2 ? 'home' : ar.w - ar.l > hr.w - hr.l + 2 ? 'away' : null;
        const lead = c.score.home > c.score.away ? 'home' : c.score.away > c.score.home ? 'away' : null;
        const nick = (x: 'home' | 'away') => (x === 'home' ? H : A);
        const w10 = (r: typeof hr) => r.last10.filter((x) => x === 'W').length;
        out.push({ id: 'records', key: 'records', salience: 0.42, relevance: 0.4, opener: 'pxp', build: (rng, o) => script([
          { who: 'A', t: [`The ${H} came into tonight at ${hr.w} and ${hr.l}, the ${A} at ${ar.w} and ${ar.l}.`, `Coming in, it was ${ar.w} and ${ar.l} for the ${A}, ${hr.w} and ${hr.l} for the ${H}.`] },
          { who: 'B', t: better && lead && better !== lead ? [`The ${nick(better)} have been the better club this year. You would not know it tonight.`, 'Records do not mean much once the game starts. Tonight is proving it.'] : better && lead === better ? [`About what you would expect from the better club, $other.`, `The ${nick(better)} are playing like their record tonight.`] : ['Two clubs that are about even, and it shows.', 'Not much between them in the standings, or tonight.'] },
          { who: 'A', t: [`The ${H} have won ${numW(w10(hr))} of their last ten.`, `The ${A} have won ${numW(w10(ar))} of their last ten.`], opt: true },
        ], S, rng, o) });
      }
      if (this.facts.venue && c.inning >= 4)
        out.push({ id: 'promo', key: `promo:${c.inning}`, salience: 0.35, relevance: 0.3, opener: 'pxp', build: (rng, o) => {
          const ps = promoLines(this.facts!);
          return ps.length ? script([{ who: 'A', t: ps }], S, rng, o) : null;
        } });
    }
    return out.filter(Boolean);
  }

  /** a catchphrase for this trigger, if its owner has one left this game and its cooldown has passed (said about half the time it could be) */
  private catchphrase(trigger: (typeof CATCHPHRASES)[number]['trigger'], t: number): { id: string; who: 'pbp' | 'color'; text: string } | null {
    for (const c of CATCHPHRASES) {
      if (c.trigger !== trigger) continue;
      const u = this.phraseUse.get(c.id) ?? { n: 0, at: -1e9 };
      if (u.n >= c.max || t - u.at < c.cooldown || this.rng() > 0.5) continue;
      this.phraseUse.set(c.id, { n: u.n + 1, at: t });
      return { id: c.id, who: c.who, text: c.lines[Math.floor(this.rng() * c.lines.length)] };
    }
    return null;
  }

  /** start the break segment now (`sec` seconds left) */
  private startBreak(t: number, c: BoothCtx, sec: number) {
    const b = this.pendingBreak;
    this.pendingBreak = null;
    if (!b || !this.facts || sec < 5) return;
    const name = (id: string) => {
      const p = c.person?.(id);
      return p ? lastNameOf(p.name) : undefined;
    };
    const nextSide = b.half === 'top' ? 'home' : 'away';
    const joke = this.jokeFor('lull', t);
    this.breaks++;
    const seg = breakSegment({
      facts: this.facts,
      log: this.log,
      inning: b.inning,
      half: b.half,
      score: c.score,
      sec,
      dueUp: c.sim?.dueUp?.(nextSide, 3) ?? [],
      box: (c.sim?.box?.() as Box | undefined) ?? null,
      name,
      pitcherId: b.pitcherId,
      level: this.userLevel,
      joke,
      n: this.breaks,
      stretch: b.stretch && b.sawQuiet,
      avoid: (x) => this.said.some((y) => y.includes(x)) || this.segSaid.has(x),
    });
    this.director.runSegment(seg, t, t + sec - 1.5);
    // (also when it waits at the end as an extra: once offered, a stage is not offered again)
    if (joke && seg.turns.some((x) => x.block.startsWith(`joke.${joke.joke.id}`))) this.toldJoke(joke, t);
  }

  /** feed every sim event (before `tick`) */
  observe(ev: RawEvent, c: BoothCtx, t: number) {
    withMemory(this.mem, () => this.observeNow(ev, c, t));
  }

  private observeNow(ev: RawEvent, c: BoothCtx, t: number) {
    this.ctx = c;
    for (const n of [c.batter?.name, c.pitcher?.name, ...(c.runnerNames ?? [])])
      if (n && !this.named.has(n)) {
        this.named.add(n);
        this.mem.addNames([n]);
      }
    this.live = { balls: c.balls, strikes: c.strikes, outs: this.log.outs, batterId: c.batter?.id };
    if (ev.type === 'pitchReleased' || ev.type === 'batterUp') this.epoch++;
    if (ev.type === 'homeRun') this.trotting = true;
    if (ev.type === 'batterUp' || ev.type === 'halfInningStart' || ev.type === 'gameEnd') this.trotting = false;
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
    // breaks between half innings, the closing, and what jokes and stories may pick up later
    if (ev.type === 'breakStart' && !ev.pregame && this.facts && this.pregame !== 'waiting' && this.pregame !== 'opening') {
      const ended = { inning: Number(ev.half === 'top' ? Number(ev.inning) - 1 : ev.inning), half: (ev.half === 'top' ? 'bottom' : 'top') as 'top' | 'bottom' };
      if (ended.inning >= 1) this.pendingBreak = { ...ended, sec: Number(ev.sec) || 0, at: t, stretch: ended.inning === 7 && ended.half === 'top', sawQuiet: false, pitcherId: this.lastHalfPitcher };
    }
    if (ev.type === 'breakStart' && ev.pregame) this.pregameSec = Number(ev.sec) || 0;
    if (ev.type === 'halfInningEnd') this.lastHalfPitcher = this.log.cur?.pitcherId;
    if (ev.type === 'safe' && this.log.stealing && Number(ev.time ?? c.time ?? 0) - this.log.stealing.time < 8) this.recent.steal = t;
    if (ev.type === 'error') {
      this.recent.error = { inning: c.inning, half: c.half };
      if (ev.fielderId) this.errors.push({ fielderId: String(ev.fielderId), inning: c.inning });
    }
    if (ev.type === 'moundVisit') {
      this.recent.visitBy = String(ev.by ?? '');
      this.recent.visitAt = t;
    }
    if (ev.type === 'pitchingChange') {
      const outId = String(ev.outId ?? '');
      const side = c.half === 'top' ? 'home' : 'away';
      const box = c.sim?.box?.() as Box | undefined;
      const line = box?.[side]?.pitchers.find((p) => p.id === outId)?.line;
      this.recent.change = { outId, inId: String(ev.inId ?? ''), pitches: line?.pitches ?? this.log.pitcherPitches(outId).length, runs: line?.r ?? 0, side, at: t };
    }
    if (ev.type === 'gameEnd' && this.facts && !this.closed) {
      this.closed = true;
      this.pendingBreak = null;
      // nothing competes with the wrap-up (the game-over screen comes up over it), whatever the tempo
      const budget = 45;
      const name = (id: string) => {
        const p = c.person?.(id);
        return p ? lastNameOf(p.name) : undefined;
      };
      const h = Number(ev.home ?? c.score.home);
      const a = Number(ev.away ?? c.score.away);
      this.director.endSegment();
      this.director.runSegment(closingSegment({ facts: this.facts, log: this.log, score: { home: h, away: a }, box: (c.sim?.box?.() as Box | undefined) ?? null, name, budget, level: this.userLevel }), t, t + budget + 8);
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
    let calls = callsFor(ev, c, this.log, this.env);
    // the same words twice in a short while sound canned: ask the lexicon again (its templates vary) before saying it
    for (let k = 0; k < 2 && calls.some((x) => x.text && this.said.includes(x.text)); k++) {
      const again = callsFor(ev, c, this.log, this.env);
      calls = calls.map((x) => (x.text && this.said.includes(x.text) ? again.find((y) => y.tag === x.tag && y.text && !this.said.includes(y.text)) ?? x : x));
    }
    for (const call of calls) {
      if (!call.text) continue;
      // a break segment says the new half and who is due up
      if (call.tag === 'half.start' && (this.pendingBreak || this.director.segmentActive === 'break')) continue;
      // when the sim has breaks, the break's recap ends the half ("Middle of the fourth ..."), not "that'll do it for the top of the fourth"
      if (call.tag === 'half.end' && this.facts && this.pregameSec > 0) continue;
      // the opening replaces "here we go" / "the top of the 1st" / the first batter's intro: the handoff says it
      if ((this.pregame === 'waiting' || this.pregame === 'opening') && call.importance === 'could') continue;
      if (this.pregame !== 'none' && (call.tag === 'start' || (c.inning === 1 && c.half === 'top' && (call.tag === 'half.start' || (call.tag === 'batter.up' && this.log.pitches.length === 0))))) continue;
      // a signature phrase now and then: Lyle's goes on the end of his own call, Biscuit's comes in over its last words
      const trig = call.tag.startsWith('hr.') && call.tag !== 'hr.dist' ? 'homeRun' : call.tag.startsWith('strikeout.') && call.tag !== 'strikeout.count' ? 'strikeout' : call.tag.startsWith('out.dp') ? 'doublePlay' : call.tag === 'steal.safe' ? 'stolenBase' : call.tag === 'end' ? 'win' : null;
      const phrase = trig && call.speaker === 'pxp' ? this.catchphrase(trig, t) : null;
      const text = phrase && phrase.who === 'pbp' ? `${call.text} ${phrase.text}` : call.text;
      this.director.submit({ importance: call.importance, speaker: call.speaker, text, ttl: call.ttl, excited: call.excited, fold: call.fold, foldable: call.foldable, tag: call.tag }, t);
      if (phrase && phrase.who === 'color') this.director.submit({ importance: 'could', speaker: 'color', text: phrase.text, ttl: 4, interject: true, tag: `phrase.${phrase.id}` }, t);
      else if (!phrase) this.maybeReact(call, t);
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
    withMemory(this.mem, () => this.replayNow(c, t));
  }

  private replayNow(c: BoothCtx, t: number) {
    void c;
    const text = say(LEX['replay.pxp'], {}, this.rng);
    if (text) this.director.submit({ importance: 'should', speaker: 'pxp', text, ttl: 6, tag: 'replay' }, t);
  }

  tick(t: number, c: BoothCtx, opts: { suppressed: boolean; fieldHold?: boolean }): Action[] {
    return withMemory(this.mem, () => this.tickNow(t, c, opts));
  }

  private tickNow(t: number, c: BoothCtx, opts: { suppressed: boolean; fieldHold?: boolean }): Action[] {
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
    this.now = t;
    // a break waits until the booth can talk (the stretch: until the organ has played); then it gets the time that is left
    const pb = this.pendingBreak;
    if (pb) {
      if (opts.suppressed) pb.sawQuiet = true;
      const left = c.lull?.kind === 'break' ? c.lull.remaining ?? 0 : pb.sec - (t - pb.at);
      const wait = pb.stretch && !pb.sawQuiet && t - pb.at < 4;
      if (left < 5 || t - pb.at > pb.sec) this.pendingBreak = null;
      else if (!opts.suppressed && !wait && !this.director.busy) this.startBreak(t, c, left);
    }
    if (!opts.suppressed) out.push(...this.director.tick(t));
    for (const a of out) if (a.type === 'start') {
      if (a.item.tag?.startsWith('break.')) this.segSaid.add(a.item.text);
      this.said.push(a.item.text);
      if (this.said.length > 150) this.said.shift();
    }
    for (const a of out) if (a.type === 'start') this.recentSaid = [...this.recentSaid, a.clauses.map((x) => x.text).join(' ')].slice(-4);
    for (const a of out) if (a.type === 'start') this.transcript.push({ t, voice: a.voice, text: a.clauses.map((x) => x.text).join(' '), tag: a.item.tag, imp: a.item.importance });
    if (this.transcript.length > 400) this.transcript.splice(0, this.transcript.length - 400);
    return out;
  }
}

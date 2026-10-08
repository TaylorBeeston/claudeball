/**
 * The broadcast director: turn-taking for the two booth voices (play-by-play "pxp" and colour "color"), like a live TV broadcast.
 * Pure and deterministic: time, randomness, and the speaking-time estimate are injected, so it is tested with a fake clock.
 *
 * Importance of an item:
 *  - MUST (outs, hits, runs, home runs, big moments): never dropped. May cut a filler / colour / SHOULD line at the next clause
 *    (or at once if no clause ends within 1.5 s) unless that line has less than `finishUnder` seconds left, in which case it finishes
 *    first. Never cuts another MUST.
 *  - SHOULD (ball and strike calls, pitch type, the count): said only if a voice is free within `shouldWindow` seconds; otherwise it is
 *    NOT said over a line in progress: its `fold` (a key plus a function resolved when it is finally spoken) is folded into the next
 *    utterance ("... that makes it two and one") or dropped when stale.
 *  - COULD (colour, stats, banter): topics with turns; they start only in a lull, with pauses of 0.2-0.6 s between turns, short
 *    interjections ("Ooh", "Wow") may start over the last 0.4 s of the other voice, and a topic is dropped (its remaining turns too) when
 *    something more important comes. After a topic the booth breathes for a while (shorter at chatter High, topics off at Low).
 *
 * The director never speaks by itself: `tick(t)` returns `start` / `cut` actions for a sink (`channels.ts`) which reports
 * `voiceEnded(voice, t)` when audio really finished (otherwise the estimate is used).
 */
import { clauseEnds, estimateDuration } from './text';

export type Importance = 'must' | 'should' | 'could';
export type VoiceId = 'pxp' | 'color';
export type Level = 'low' | 'normal' | 'high';

export interface Fold {
  key: string;
  epoch: number;
  /** resolved at the time of speaking: null when the information is no longer current */
  render: () => string | null;
}

export interface Item {
  id: string;
  importance: Importance;
  speaker: VoiceId | 'any';
  text: string;
  /** seconds a queued item stays valid */
  ttl: number;
  interject?: boolean;
  excited?: boolean;
  fold?: Fold;
  /** may carry a folded (missed) count in front of it: batted-ball calls, the next batter ... */
  foldable?: boolean;
  tag?: string;
  /** set by the director */
  createdAt?: number;
  notBefore?: number;
  topic?: number;
}

export interface TopicTurn {
  speaker: VoiceId;
  text: string;
  excited?: boolean;
  interject?: boolean;
}

export interface Topic {
  id: number;
  tag: string;
  turns: TopicTurn[];
}

/** A turn of a scripted segment (the opening, a break, the closing): who says what; optional turns are skipped when they would not fit. */
export interface SegmentTurn {
  speaker: VoiceId;
  text: string;
  /** the block (a short exchange) this turn belongs to: when a block's first turn is skipped, the block's later turns go too */
  block: string;
  /** may be skipped when the segment runs out of time (essential turns are always said; a MUST may still cut them) */
  optional?: boolean;
  excited?: boolean;
  /** start no earlier than this many seconds after the segment began (a deliberate gap: "we'll be right back" ... "and we're back") */
  notBefore?: number;
}

export interface Segment {
  tag: string;
  turns: SegmentTurn[];
}

export interface StartAction {
  type: 'start';
  voice: VoiceId;
  at: number;
  item: Item;
  /** what to say, clause by clause (a fold, when there is one, comes first) */
  clauses: { text: string; fold?: boolean }[];
  est: number;
}
export interface CutAction {
  type: 'cut';
  voice: VoiceId;
  at: number;
  reason: string;
}
export type Action = StartAction | CutAction;

export interface DirectorCfg {
  pauseMin: number;
  pauseMax: number;
  shouldWindow: number;
  finishUnder: number;
  maxCutWait: number;
  interjectOverlap: number;
  breatheMin: number;
  breatheMax: number;
  /** topics are started in lulls (false at chatter Low) */
  topics: boolean;
}

export const CFG: Record<Level, DirectorCfg> = {
  low: { pauseMin: 0.3, pauseMax: 0.7, shouldWindow: 0.7, finishUnder: 1.2, maxCutWait: 1.5, interjectOverlap: 0.4, breatheMin: 99, breatheMax: 99, topics: false },
  normal: { pauseMin: 0.2, pauseMax: 0.6, shouldWindow: 0.7, finishUnder: 1.2, maxCutWait: 1.5, interjectOverlap: 0.4, breatheMin: 5, breatheMax: 11, topics: true },
  high: { pauseMin: 0.2, pauseMax: 0.5, shouldWindow: 0.7, finishUnder: 1.2, maxCutWait: 1.5, interjectOverlap: 0.4, breatheMin: 2.5, breatheMax: 6, topics: true },
};

interface VoiceState {
  item: Item | null;
  start: number;
  end: number;
  /** the voice was cut at this time (its end is then `end`) */
  cut: boolean;
  lastEnd: number;
  clauseEnds: number[];
}

export interface DirectorOpts {
  rng: () => number;
  level?: Level;
  /** speaking time of a line (seconds) */
  dur?: (text: string, excited?: boolean) => number;
  /** cumulative clause end times of a line (seconds from its start) */
  ends?: (text: string, excited?: boolean) => number[];
  /** next conversation topic when the booth is idle (return null when there is nothing worth saying) */
  topicSource?: (t: number) => Topic | null;
}

export class Director {
  readonly voices: Record<VoiceId, VoiceState> = {
    pxp: { item: null, start: 0, end: 0, cut: false, lastEnd: -99, clauseEnds: [] },
    color: { item: null, start: 0, end: 0, cut: false, lastEnd: -99, clauseEnds: [] },
  };
  private pending: Item[] = [];
  private folds = new Map<string, Fold & { at: number }>();
  private active: { topic: Topic; next: number; lastVoice: VoiceId; lastStartedAt: number; pauseUntil?: number } | null = null;
  private seg: { s: Segment; next: number; start: number; deadline: number; pauseUntil?: number; skipBlock?: string; heldAt?: number } | null = null;
  /** the field channel (PA, umpire) is speaking and voices cannot overlap: segment / topic turns and colour lines wait for it (calls do not) */
  holdForField = false;
  private breatheUntil = 0;
  private epoch = 0;
  private suppressed = false;
  private seq = 1;
  private cfg: DirectorCfg;
  private rng: () => number;
  private dur: (text: string, excited?: boolean) => number;
  private ends: (text: string, excited?: boolean) => number[];
  topicSource: ((t: number) => Topic | null) | null;
  /** debug / tests */
  readonly stats = { started: 0, cuts: 0, foldedIn: 0, foldDropped: 0, shouldDropped: 0, topicsStarted: 0, topicsAborted: 0, segments: 0, segmentTurns: 0, segmentSkipped: 0 };

  constructor(o: DirectorOpts) {
    this.rng = o.rng;
    this.cfg = CFG[o.level ?? 'normal'];
    this.dur = o.dur ?? ((t, e) => estimateDuration(t, e ? 1.1 : 1));
    this.ends = o.ends ?? ((t, e) => clauseEnds(t, e ? 1.1 : 1));
    this.topicSource = o.topicSource ?? null;
  }

  setLevel(l: Level) {
    this.cfg = CFG[l];
  }

  /** a new pitch / play began: infomation tied to an older epoch is stale */
  setEpoch(n: number) {
    this.epoch = n;
  }

  get busy() {
    return !!(this.voices.pxp.item || this.voices.color.item);
  }

  /**
   * Run a scripted segment now (it replaces a running topic or segment). Turns follow each other with the usual beats; MUST calls pre-empt a turn and
   * the segment resumes after them; optional turns (with the rest of their block) are skipped when they would end after `deadline` (absolute time).
   * Segments play at every chatter level (the builder makes them short at Low).
   */
  runSegment(s: Segment, t: number, deadline: number) {
    if (this.suppressed || !s.turns.length) return;
    if (this.active) {
      this.active = null;
      this.stats.topicsAborted++;
    }
    this.seg = { s, next: 0, start: t, deadline };
    this.stats.segments++;
  }

  /** stop the running segment (its remaining turns are dropped; a line in progress finishes) */
  endSegment() {
    this.seg = null;
    this.parked = null;
  }

  /** the rest of a segment that was running when the booth went quiet (pause, mute, fast-forward) */
  parked: { s: Segment } | null = null;
  /** resume the parked segment (its optional turns are fitted to the new deadline) */
  resumeSegment(t: number, deadline: number) {
    const p = this.parked;
    this.parked = null;
    if (p && p.s.turns.length) this.runSegment(p.s, t, deadline);
  }

  get segmentActive(): string | null {
    return this.seg ? this.seg.s.tag : null;
  }

  /** seconds the rest of the segment would take from its next turn (estimate) */
  segmentRemaining(): number {
    const g = this.seg;
    if (!g) return 0;
    let sum = 0;
    for (let i = g.next; i < g.s.turns.length; i++) sum += this.dur(g.s.turns[i].text, g.s.turns[i].excited) + (this.cfg.pauseMin + this.cfg.pauseMax) / 2;
    return sum;
  }

  /** Muted (2x and above, fast-forward, chatter off): nothing is said; running lines are cut. */
  setSuppressed(on: boolean, t: number): Action[] {
    if (on === this.suppressed) return [];
    this.suppressed = on;
    if (!on) return [];
    this.pending = [];
    this.folds.clear();
    this.active = null;
    // a running segment is parked (the booth resumes it with the time that is left, or drops it)
    if (this.seg) this.parked = { s: { ...this.seg.s, turns: this.seg.s.turns.slice(this.seg.next) } };
    this.seg = null;
    const out: Action[] = [];
    for (const v of ['pxp', 'color'] as VoiceId[]) {
      if (this.voices[v].item) out.push(this.cutNow(v, t, 'suppressed'));
    }
    return out;
  }

  submit(item: Omit<Item, 'id'> & { id?: string }, t: number) {
    if (this.suppressed) return;
    const it: Item = { ...item, id: item.id ?? `i${this.seq++}`, createdAt: t };
    if (it.importance === 'could' && !this.cfg.topics && !it.interject) return; // chatter Low: calls only
    this.pending.push(it);
    // newest SHOULD about the same fold key replaces an older unspoken one
    if (it.importance === 'should' && it.fold) this.pending = this.pending.filter((p) => p === it || !(p.importance === 'should' && p.fold?.key === it.fold!.key && p.createdAt! < t));
  }

  /** the sink reports that a voice's audio really ended (or was cut) */
  voiceEnded(voice: VoiceId, t: number) {
    const v = this.voices[voice];
    if (!v.item) return;
    this.finish(voice, t);
  }

  private finish(voice: VoiceId, t: number) {
    const v = this.voices[voice];
    v.item = null;
    v.lastEnd = Math.min(t, v.end > 0 ? v.end : t);
    if (this.active && this.active.topic.turns.length <= this.active.next && this.active.lastVoice === voice) {
      // last turn done: breathe
      this.breatheUntil = t + this.cfg.breatheMin + this.rng() * (this.cfg.breatheMax - this.cfg.breatheMin);
      this.active = null;
    }
  }

  private pause(t: number) {
    return this.cfg.pauseMin + this.rng() * (this.cfg.pauseMax - this.cfg.pauseMin) + 0 * t;
  }

  /** earliest time a voice may start a new line */
  private freeAt(voice: VoiceId, t: number): number {
    const v = this.voices[voice];
    const o = this.voices[voice === 'pxp' ? 'color' : 'pxp'];
    // one person talks at a time: the other voice must be finished (or nearly) too
    const own = v.item ? v.end + this.cfg.pauseMin : Math.max(t, v.lastEnd + this.cfg.pauseMin);
    const theirs = o.item ? o.end + this.cfg.pauseMin : 0;
    return Math.max(own, theirs);
  }

  private cutNow(voice: VoiceId, at: number, reason: string): CutAction {
    const v = this.voices[voice];
    v.end = at;
    v.cut = true;
    v.lastEnd = at;
    v.item = null;
    this.stats.cuts++;
    if (this.active) {
      // a topic that was cut loses its remaining turns
      this.stats.topicsAborted++;
      this.active = null;
      this.breatheUntil = at + this.cfg.breatheMin;
    }
    return { type: 'cut', voice, at, reason };
  }

  /** resolve folds for a line that is about to start */
  private foldClauses(t: number, item: Item): { text: string; fold: true }[] {
    if (!item.foldable || item.interject) return [];
    const out: { text: string; fold: true }[] = [];
    for (const [key, f] of [...this.folds]) {
      if (item.fold?.key === key) {
        this.folds.delete(key);
        continue;
      }
      this.folds.delete(key);
      if (f.epoch < this.epoch - 1) {
        this.stats.foldDropped++;
        continue;
      }
      const text = f.render();
      if (text) {
        out.push({ text, fold: true });
        this.stats.foldedIn++;
      } else this.stats.foldDropped++;
    }
    void t;
    return out;
  }

  private start(voice: VoiceId, t: number, item: Item, actions: Action[]) {
    const v = this.voices[voice];
    const fold = this.foldClauses(t, item);
    const cl = [...fold, { text: item.text }];
    const text = cl.map((c) => c.text).join(' ');
    const est = this.dur(text, item.excited);
    v.item = item;
    v.start = t;
    v.end = t + est;
    v.cut = false;
    v.clauseEnds = this.ends(text, item.excited);
    this.stats.started++;
    actions.push({ type: 'start', voice, at: t, item, clauses: cl, est });
  }

  /** Advance to time `t`; returns what the sink should do now. Call often (e.g. 20-30 Hz). */
  tick(t: number): Action[] {
    const actions: Action[] = [];
    if (this.suppressed) return actions;
    // lines whose estimated end has passed are over (the sink normally reports it earlier)
    for (const id of ['pxp', 'color'] as VoiceId[]) {
      const v = this.voices[id];
      if (v.item && t >= v.end) this.finish(id, v.end);
    }
    // expiry
    this.pending = this.pending.filter((p) => {
      if (p.importance === 'must') return true;
      if (t - p.createdAt! <= p.ttl) return true;
      if (p.importance === 'should') this.foldOrDrop(p, t);
      return false;
    });

    // something important is waiting: a running conversation gives way (its remaining turns are dropped)
    if (this.active && this.pending.some((p) => p.importance === 'must')) {
      this.active = null;
      this.stats.topicsAborted++;
      this.breatheUntil = t + this.cfg.breatheMin;
    }

    // 1. MUST items, oldest first
    for (const it of this.pending.filter((p) => p.importance === 'must')) {
      const voice: VoiceId = it.speaker === 'color' ? 'color' : 'pxp';
      if (it.notBefore !== undefined && t < it.notBefore) continue;
      const v = this.voices[voice];
      const other = this.voices[voice === 'pxp' ? 'color' : 'pxp'];
      if (other.item && other.item.importance !== 'must' && !other.item.interject) {
        // the other voice is mid-line: it yields at its next clause (or finishes if nearly done)
        const rem = other.end - t;
        if (rem > this.cfg.finishUnder) {
          let cutAt = t;
          for (const e of other.clauseEnds) {
            const abs = other.start + e;
            if (abs > t) {
              if (abs - t <= this.cfg.maxCutWait) cutAt = abs;
              break;
            }
          }
          actions.push(this.cutNow(voice === 'pxp' ? 'color' : 'pxp', cutAt, 'must'));
          it.notBefore = cutAt + 0.1;
          continue;
        }
        it.notBefore = other.end + 0.1;
        continue;
      } else if (other.item && other.item.importance === 'must') {
        it.notBefore = Math.max(it.notBefore ?? 0, other.end + 0.1);
        if (!v.item) continue;
      }
      if (!v.item) {
        if (t >= v.lastEnd + 0.15) {
          this.start(voice, t, it, actions);
          this.pending = this.pending.filter((p) => p !== it);
        }
        continue;
      }
      if (v.item.importance === 'must') continue; // never cut a MUST: wait
      const remaining = v.end - t;
      if (remaining <= this.cfg.finishUnder) continue; // let it finish
      // cut at the next clause end (or now when none is near)
      let cutAt = t;
      for (const e of v.clauseEnds) {
        const abs = v.start + e;
        if (abs > t) {
          if (abs - t <= this.cfg.maxCutWait) cutAt = abs;
          break;
        }
      }
      if (cutAt <= t) {
        actions.push(this.cutNow(voice, t, 'must'));
        // starts on the next tick after the 0.15 s breath
        it.notBefore = t + 0.15;
      } else {
        actions.push(this.cutNow(voice, cutAt, 'must'));
        it.notBefore = cutAt + 0.15;
      }
    }

    // 2. SHOULD items: a voice free within the window, else fold into the next line
    for (const it of this.pending.filter((p) => p.importance === 'should')) {
      const voice: VoiceId = it.speaker === 'color' ? 'color' : 'pxp';
      const startAt = this.freeAt(voice, it.createdAt!);
      if (t - it.createdAt! === 0 || it.notBefore === undefined) {
        // decision time: can it start within the window?
        if (startAt - it.createdAt! <= this.cfg.shouldWindow) it.notBefore = Math.max(it.createdAt!, startAt);
        else {
          this.foldOrDrop(it, t);
          this.pending = this.pending.filter((p) => p !== it);
          continue;
        }
      }
      if (t >= it.notBefore! && !this.voices[voice].item && t >= this.voices[voice].lastEnd + this.cfg.pauseMin) {
        this.start(voice, t, it, actions);
        this.pending = this.pending.filter((p) => p !== it);
      }
    }

    // 3. interjections and single COULD lines
    for (const it of this.pending.filter((p) => p.importance === 'could')) {
      const voice: VoiceId = it.speaker === 'pxp' ? 'pxp' : 'color';
      const v = this.voices[voice];
      const other = this.voices[voice === 'pxp' ? 'color' : 'pxp'];
      const mustWaiting = this.pending.some((p) => p.importance === 'must');
      if (mustWaiting || v.item) continue;
      if ((this.seg || this.holdForField) && !it.interject) continue;
      if (it.interject) {
        const rem = other.item ? other.end - t : 0;
        if (rem <= this.cfg.interjectOverlap && t >= v.lastEnd + 0.1) {
          this.start(voice, t, it, actions);
          this.pending = this.pending.filter((p) => p !== it);
        }
      } else if (!other.item && t >= v.lastEnd + this.pause(t) && t >= this.breatheUntil && !this.active) {
        this.start(voice, t, it, actions);
        this.breatheUntil = t + this.cfg.breatheMin + this.rng() * (this.cfg.breatheMax - this.cfg.breatheMin);
        this.pending = this.pending.filter((p) => p !== it);
      }
    }

    // 4. the running segment, or the running topic (whose next turn waits while the PA / umpire speak and voices cannot overlap)
    if (this.seg) this.advanceSegment(t, actions);
    else if (this.active && !this.holdForField) this.advanceTopic(t, actions);
    else if (this.active && this.holdForField) this.active.lastStartedAt = t; // (the hold does not count as a stall)

    // 5. a new topic in a lull
    if (!this.seg && !this.active && !this.holdForField && this.cfg.topics && this.topicSource && !this.busy && !this.pending.some((p) => p.importance !== 'could') && t >= this.breatheUntil && t >= Math.max(this.voices.pxp.lastEnd, this.voices.color.lastEnd) + this.cfg.pauseMin) {
      const topic = this.topicSource(t);
      if (topic && topic.turns.length) {
        this.stats.topicsStarted++;
        this.active = { topic, next: 0, lastVoice: topic.turns[0].speaker, lastStartedAt: t };
        this.advanceTopic(t, actions);
      } else this.breatheUntil = t + 1.5; // nothing worth saying: look again shortly
    }
    return actions;
  }

  private advanceTopic(t: number, actions: Action[]) {
    const a = this.active!;
    if (a.next >= a.topic.turns.length) return;
    const turn = a.topic.turns[a.next];
    const v = this.voices[turn.speaker];
    const other = this.voices[turn.speaker === 'pxp' ? 'color' : 'pxp'];
    if (a.next > 0) {
      // stalled for too long: give the topic up
      const prev = this.voices[a.lastVoice];
      if (t - Math.max(prev.end, a.lastStartedAt) > 4) {
        this.active = null;
        this.stats.topicsAborted++;
        this.breatheUntil = t + this.cfg.breatheMin;
        return;
      }
    }
    if (v.item) return;
    if (a.next === 0) {
      if (other.item) return;
    } else if (turn.interject) {
      const rem = other.item ? other.end - t : 0;
      if (rem > this.cfg.interjectOverlap) return;
      if (!other.item && t < other.lastEnd + 0.1) return;
    } else {
      if (other.item) return; // wait for the other voice to finish its turn
      if (a.pauseUntil === undefined) a.pauseUntil = Math.max(t, other.lastEnd) + this.pause(t); // the beat between turns
      if (t < a.pauseUntil) return;
    }
    const item: Item = { id: `t${a.topic.id}.${a.next}`, importance: 'could', speaker: turn.speaker, text: turn.text, ttl: 99, excited: turn.excited, interject: turn.interject, topic: a.topic.id, tag: a.topic.tag, createdAt: t };
    this.start(turn.speaker, t, item, actions);
    a.lastVoice = turn.speaker;
    a.lastStartedAt = t;
    a.next++;
    a.pauseUntil = undefined;
  }

  private advanceSegment(t: number, actions: Action[]) {
    const g = this.seg!;
    if (this.busy || this.holdForField || this.pending.some((p) => p.importance === 'must' || (p.importance === 'should' && p.notBefore !== undefined))) {
      g.pauseUntil = undefined; // a fresh beat after whatever is speaking now
      if (this.holdForField) g.heldAt = t;
      return;
    }
    const lastEnd = Math.max(this.voices.pxp.lastEnd, this.voices.color.lastEnd, g.heldAt ?? -99);
    while (g.next < g.s.turns.length) {
      const turn = g.s.turns[g.next];
      if (g.skipBlock !== undefined && turn.block === g.skipBlock && turn.optional !== false) {
        g.next++;
        this.stats.segmentSkipped++;
        continue;
      }
      g.skipBlock = undefined;
      if (g.pauseUntil === undefined) g.pauseUntil = Math.max(t, lastEnd + this.pause(t));
      const at = Math.max(g.pauseUntil, turn.notBefore !== undefined ? g.start + turn.notBefore : 0);
      if (turn.optional) {
        // the turn and the rest of its block must fit before the deadline
        let need = 0;
        for (let i = g.next; i < g.s.turns.length && g.s.turns[i].block === turn.block; i++) need += this.dur(g.s.turns[i].text, g.s.turns[i].excited) + this.cfg.pauseMin;
        if (at + need > g.deadline) {
          g.skipBlock = turn.block;
          g.next++;
          this.stats.segmentSkipped++;
          continue;
        }
      }
      if (t < at) return;
      const item: Item = { id: `s${this.stats.segments}.${g.next}`, importance: 'could', speaker: turn.speaker, text: turn.text, ttl: 99, excited: turn.excited, tag: `${g.s.tag}.${turn.block}`, createdAt: t };
      this.start(turn.speaker, t, item, actions);
      this.stats.segmentTurns++;
      g.next++;
      g.pauseUntil = undefined;
      return;
    }
    // done: the booth breathes before the next topic
    this.seg = null;
    this.breatheUntil = Math.max(this.breatheUntil, t + this.cfg.breatheMin);
  }

  private foldOrDrop(it: Item, t: number) {
    if (it.fold) this.folds.set(it.fold.key, { ...it.fold, at: t });
    else this.stats.shouldDropped++;
  }

  /** debug: a snapshot */
  snapshot() {
    return { pending: this.pending.map((p) => `${p.importance}:${p.text}`), folds: [...this.folds.keys()], active: this.active?.topic.tag ?? null, segment: this.seg ? `${this.seg.s.tag} ${this.seg.next}/${this.seg.s.turns.length}` : null, breatheUntil: this.breatheUntil };
  }
}

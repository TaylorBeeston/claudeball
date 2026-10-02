/**
 * Executes the director's actions with the speech engine: the booth channel. (The stadium PA and the umpire are the "field" channel, a
 * `SpeechQueue` on the gate's other view; see `gate.ts`.) Reports back when a voice really finished, applies the excited delivery
 * (faster, higher) and cuts a running line at a clause boundary when told to.
 */
import type { SpeakHandle, SpeechEngine } from '../speech';
import type { Action, StartAction, VoiceId } from './director';

export interface BoothSinkOpts {
  /** seconds, the same clock the director uses */
  now: () => number;
  /** a voice finished (really, or because it was cut) */
  voiceEnded: (voice: VoiceId, t: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** volume of the booth voices, 0..1 */
  volume: () => number;
}

/** delivery per voice: the play-by-play a touch quicker, the analyst relaxed; excited lines faster and higher */
const BASE = { pxp: { rate: 1.04, pitch: 1 }, color: { rate: 1.0, pitch: 1 } } as const;
const EXCITED = { rate: 1.12, pitch: 1.1, shift: 1.06 };

export class BoothSink {
  private lines: Partial<Record<VoiceId, { handle: SpeakHandle | void; id: number; text: string }>> = {};
  private timers = new Set<unknown>();
  private seq = 1;
  readonly spoken: { voice: VoiceId; text: string; excited: boolean }[] = [];

  constructor(private engine: SpeechEngine, private o: BoothSinkOpts) {}

  apply(actions: Action[]) {
    for (const a of actions) {
      if (a.type === 'start') this.start(a);
      else this.cut(a.voice, a.at);
    }
  }

  private start(a: StartAction) {
    const text = a.clauses.map((c) => c.text).join(' ');
    const ex = !!a.item.excited;
    const d = BASE[a.voice];
    const id = this.seq++;
    this.cancelLine(a.voice);
    this.spoken.push({ voice: a.voice, text, excited: ex });
    if (this.spoken.length > 200) this.spoken.shift();
    const done = () => {
      if (this.lines[a.voice]?.id !== id) return;
      delete this.lines[a.voice];
      this.o.voiceEnded(a.voice, this.o.now());
    };
    const role = a.voice === 'pxp' ? 'pbp' : 'color';
    const handle = this.engine.speak(text, {
      role,
      voiceName: this.engine.voiceFor?.(role),
      pitch: ex ? EXCITED.pitch : d.pitch,
      shift: ex ? EXCITED.shift : 1,
      rate: ex ? EXCITED.rate : d.rate,
      volume: Math.min(1, (a.voice === 'pxp' ? 0.95 : 0.9) * this.o.volume()),
      maxWaitMs: a.item.importance === 'must' ? 20000 : 1500,
      onend: done,
      onerror: done,
    });
    this.lines[a.voice] = { handle, id, text };
  }

  /** cut at `at` (director time): the engine finishes the current clause when it can, else stops at once */
  private cut(voice: VoiceId, at: number) {
    const line = this.lines[voice];
    if (!line) return;
    const run = () => {
      const l = this.lines[voice];
      if (!l || l.id !== line.id) return;
      const h = l.handle;
      if (h && typeof h === 'object') {
        if (h.cutAtClause) h.cutAtClause();
        else h.cancel();
      } else this.engine.cancel();
      delete this.lines[voice];
      this.o.voiceEnded(voice, this.o.now());
    };
    const wait = Math.max(0, (at - this.o.now()) * 1000);
    if (wait < 30) return run();
    const timer = (this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)))(() => {
      this.timers.delete(timer);
      run();
    }, wait);
    this.timers.add(timer);
  }

  private cancelLine(voice: VoiceId) {
    const l = this.lines[voice];
    if (!l) return;
    const h = l.handle;
    if (h && typeof h === 'object') h.cancel();
    delete this.lines[voice];
  }

  /** stop everything the booth is saying */
  stopAll() {
    for (const t of this.timers) (this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as never)))(t);
    this.timers.clear();
    for (const v of ['pxp', 'color'] as VoiceId[]) {
      const l = this.lines[v];
      if (!l) continue;
      const h = l.handle;
      if (h && typeof h === 'object') h.cancel();
      else this.engine.cancel();
      delete this.lines[v];
    }
  }

  get speaking() {
    return !!(this.lines.pxp || this.lines.color);
  }
}

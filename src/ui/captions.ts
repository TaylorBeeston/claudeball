/**
 * The captions bar. It sits inside the HUD (so it shares the HUD's layout variables and safe-area margins), shows what the booth, PA and
 * umpires say with a speaker label, and does DOM work only when a line starts, ends or fades: one timer for the next deadline, never per frame.
 *
 * Source: the audio controller's speech events (`onSpeech`, see `captionModel.ts`). `feed(raw)` accepts one event, so tests and demos can drive it.
 */
import { CaptionModel, SIZE_SCALE, normalizeSpeech, type CaptionLine } from './captionModel';
import type { GameSettings } from './settings';

/** What the captions need from the audio controller; both callbacks are optional (the layer may send starts and ends through `onSpeech` alone). */
export interface SpeechFeed {
  onSpeech?(cb: (e: unknown) => void): (() => void) | void;
  onSpeechEnd?(cb: (e: unknown) => void): (() => void) | void;
}

type CapSettings = Pick<GameSettings, 'subtitles' | 'subtitleSize' | 'subtitleBg' | 'subtitleLabels' | 'subtitlePos'>;

export class Captions {
  readonly el = document.createElement('div');
  private model = new CaptionModel('off', 2);
  private rows = new Map<string | number, HTMLElement>();
  private timer = 0;
  private offs: (() => void)[] = [];
  private host: HTMLElement | null = null;
  private pos: CapSettings['subtitlePos'] = 'bottom';
  private mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 900px), (max-height: 520px)') : null;
  now = () => performance.now();

  constructor() {
    this.el.className = 'cb-caps';
    this.el.setAttribute('role', 'log');
    this.el.setAttribute('aria-live', 'off');
    this.el.setAttribute('aria-label', 'Captions');
    this.el.hidden = true;
    this.mq?.addEventListener?.('change', () => this.layout());
  }

  /** Put the bar into the HUD (or any element carrying the HUD's CSS variables). */
  mount(host: HTMLElement) {
    this.host = host;
    host.append(this.el);
    this.layout();
  }

  /** Apply the player's settings. */
  apply(s: CapSettings) {
    const was = this.model.mode;
    if (this.model.setMode(s.subtitles) || was !== s.subtitles) this.render();
    const d = this.el.dataset;
    d.size = s.subtitleSize;
    d.bg = s.subtitleBg;
    d.labels = s.subtitleLabels ? '1' : '0';
    d.pos = s.subtitlePos;
    this.el.style.setProperty('--cap-scale', String(SIZE_SCALE[s.subtitleSize]));
    this.pos = s.subtitlePos;
    this.layout();
    this.el.hidden = s.subtitles === 'off';
    if (s.subtitles === 'off') this.reset();
  }

  /** Phones, tablets in portrait and short screens show one entry (the newest) and the HUD makes room for the bar at the bottom. */
  private layout() {
    const phone = !!this.mq?.matches;
    this.model.setMaxLines(phone ? 1 : 2, this.now());
    this.el.dataset.phone = phone ? '1' : '0';
    const on = this.model.mode !== 'off' && this.pos === 'bottom';
    this.host?.classList.toggle('has-caps', on);
    if (this.host) this.host.dataset.capsize = this.el.dataset.size ?? 'M';
    this.render();
  }

  /** Connect to the audio controller's speech events; returns false if it has none (the captions then stay quiet). */
  attach(feed: SpeechFeed | null | undefined): boolean {
    this.detach();
    if (!feed || typeof feed.onSpeech !== 'function') return false;
    const sub = (fn?: (cb: (e: unknown) => void) => (() => void) | void) => {
      const off = fn?.call(feed, (e: unknown) => this.feed(e));
      if (typeof off === 'function') this.offs.push(off);
    };
    sub(feed.onSpeech);
    sub(feed.onSpeechEnd);
    return true;
  }

  detach() {
    for (const o of this.offs) o();
    this.offs = [];
    this.reset();
  }

  /** One speech event (start or end). */
  feed(raw: unknown) {
    if (this.model.mode === 'off') return;
    const ev = normalizeSpeech(raw);
    if (!ev) return;
    const changed = ev.kind === 'start' ? this.model.start(ev.ev, this.now()) : this.model.end(ev.ev, this.now());
    if (changed) this.render();
    this.schedule();
  }

  private reset() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.model.clear()) this.render();
  }

  private schedule() {
    clearTimeout(this.timer);
    const at = this.model.next();
    if (at === null) return void (this.timer = 0);
    this.timer = window.setTimeout(() => {
      if (this.model.advance(this.now())) this.render();
      this.schedule();
    }, Math.max(0, at - this.now()) + 1);
  }

  /** Reconcile the DOM with the model: add, update and remove only what changed. */
  private render() {
    const lines = this.model.lines();
    const seen = new Set<string | number>();
    for (const l of lines) {
      seen.add(l.id);
      let row = this.rows.get(l.id);
      if (!row) {
        row = this.makeRow(l);
        this.rows.set(l.id, row);
        this.el.append(row);
        requestAnimationFrame(() => row!.classList.add('in'));
      }
      this.paintRow(row, l);
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.remove();
        this.rows.delete(id);
      }
    }
  }

  private makeRow(l: CaptionLine): HTMLElement {
    const row = document.createElement('div');
    row.className = `cb-cap k-${l.kind}`;
    const who = document.createElement('b');
    who.className = 'who';
    const txt = document.createElement('span');
    txt.className = 'txt';
    row.append(who, txt);
    return row;
  }

  private paintRow(row: HTMLElement, l: CaptionLine) {
    const who = row.firstChild as HTMLElement, txt = row.lastChild as HTMLElement;
    if (who.textContent !== l.label) who.textContent = l.label;
    who.hidden = !l.label;
    if (txt.textContent !== l.text) txt.textContent = l.text;
    row.classList.toggle('out', l.phase === 'out');
  }
}

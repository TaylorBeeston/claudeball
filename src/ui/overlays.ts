/** Overlay plumbing (a focus-trapping layer, toast, rotate hint) and the pause and game-over screens. */
import { h, focusables } from './dom';
import { button } from './widgets';
import { batterTotals, boxBatters, boxPitchers, pitcherTotals } from '../engine/hudStats';
import type { GameState, TeamStatsView } from '../engine/types';

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** A full-screen layer that holds one screen at a time, traps Tab inside itself and gives focus back when it closes. */
export class Layer {
  readonly el = h('div', { class: 'cb-ui', hidden: true });
  private scrim = h('div', { class: 'cb-scrim' });
  private back: HTMLElement | null = null;
  /** Escape pressed while this layer is open */
  onEscape: (() => void) | null = null;

  constructor(label: string, modal: boolean) {
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', label);
    this.el.classList.toggle('modal', modal);
    this.el.append(this.scrim);
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = focusables(this.el);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const a = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (a === first || !this.el.contains(a))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (a === last || !this.el.contains(a))) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  get visible() {
    return !this.el.hidden && !this.el.classList.contains('fade');
  }

  /** Replace the content with `screen` and focus its first control (or `focus`). */
  show(screen: HTMLElement, focus?: HTMLElement | null) {
    if (this.el.hidden) this.back = document.activeElement as HTMLElement | null;
    [...this.el.children].forEach((c) => c !== this.scrim && c.remove());
    this.el.append(screen);
    this.el.hidden = false;
    requestAnimationFrame(() => {
      this.el.classList.remove('fade');
      (focus ?? focusables(screen).find((e) => e.classList.contains('primary')) ?? focusables(screen)[0])?.focus({ preventScroll: true });
    });
  }

  hide(immediately = false) {
    if (this.el.hidden) return;
    this.el.classList.add('fade');
    const done = () => {
      if (this.el.classList.contains('fade')) {
        this.el.hidden = true;
        this.el.classList.remove('fade');
        [...this.el.children].forEach((c) => c !== this.scrim && c.remove());
      }
    };
    if (immediately) done();
    else setTimeout(done, 380);
    this.back?.focus?.({ preventScroll: true });
    this.back = null;
  }
}

export class Toast {
  private el = h('div', { class: 'cb-toast', role: 'status', 'aria-live': 'polite' });
  private timer = 0;
  constructor() {
    document.body.append(this.el);
  }
  show(msg: string, ms = 2200) {
    this.el.textContent = msg;
    this.el.classList.add('show');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('show'), ms);
  }
}

/** "Rotate your device for a better view": narrow portrait screens, dismissible, remembered for the session. */
export class RotateHint {
  private el: HTMLElement;
  private dismissed = false;
  private enabled = false;
  constructor() {
    this.el = h('div', { class: 'cb-rotate', role: 'status' }, h('span', { class: 'ph', 'aria-hidden': 'true' }, '📱'), h('span', {}, 'Rotate your device for a better view'), button('✕', () => this.dismiss(), 'quiet', { 'aria-label': 'Dismiss' }));
    document.body.append(this.el);
    const mq = matchMedia('(orientation: portrait) and (max-width: 640px)');
    mq.addEventListener?.('change', () => this.update());
    addEventListener('resize', () => this.update());
    try {
      this.dismissed = sessionStorage.getItem('claudeball.rotate') === '1';
    } catch {
      /* no session storage */
    }
  }
  /** Only while a game is on screen (the menus work fine in portrait). */
  setEnabled(on: boolean) {
    this.enabled = on;
    this.update();
  }
  private dismiss() {
    this.dismissed = true;
    try {
      sessionStorage.setItem('claudeball.rotate', '1');
    } catch {
      /* ignore */
    }
    this.update();
  }
  private update() {
    const narrow = innerWidth <= 640 && innerHeight > innerWidth;
    this.el.classList.toggle('show', this.enabled && narrow && !this.dismissed);
  }
}

export function pauseScreen(a: { resume(): void; settings(): void; restart(): void; quit(): void }): HTMLElement {
  return h(
    'div',
    { class: 'cb-panel' },
    h('div', { class: 'cb-eyebrow' }, 'Paused'),
    h('h2', { class: 'cb-h2' }, 'Game paused'),
    h('div', { class: 'cb-stack' }, button('Resume', a.resume, 'primary'), button('Settings', a.settings), button('Restart game', a.restart), button('Quit to menu', a.quit, 'danger')),
    h('div', { class: 'cb-hint' }, 'Esc resumes. Restart replays this exact game from the first pitch.'),
  );
}

function teamBox(t: TeamStatsView | undefined, name: string, abbr: string, runs: number): string {
  const bt = boxBatters(t), pt = boxPitchers(t);
  const bo = batterTotals(bt), po = pitcherTotals(pt);
  const brow = bt.filter((r) => r.inGame || r.ab > 0).map((r) => `<tr><td>${esc(r.name)} <small style="opacity:.55">${r.pos}</small></td><td>${r.ab}</td><td>${r.r}</td><td>${r.h}</td><td>${r.rbi}</td><td>${r.hr}</td><td>${r.bb}</td><td>${r.so}</td></tr>`).join('');
  const prow = pt.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.ip}</td><td>${r.h}</td><td>${r.r}</td><td>${r.er}</td><td>${r.bb}</td><td>${r.so}</td><td>${r.pitches}</td></tr>`).join('');
  return `<h4><span>${esc(name)} <small>${abbr}</small></span><span>${runs}</span></h4>
    <table><tr><th>BATTING</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>HR</th><th>BB</th><th>SO</th></tr>${brow}<tr class="tot"><td>Totals</td><td>${bo.ab}</td><td>${bo.r}</td><td>${bo.h}</td><td>${bo.rbi}</td><td>${bo.hr}</td><td>${bo.bb}</td><td>${bo.so}</td></tr></table>
    <table><tr><th>PITCHING</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>SO</th><th>P</th></tr>${prow}<tr class="tot"><td>Totals</td><td>${po.ip}</td><td>${po.h}</td><td>${po.r}</td><td>${po.er}</td><td>${po.bb}</td><td>${po.so}</td><td>${po.pitches}</td></tr></table>`;
}

export function gameOverScreen(s: GameState, a: { again(): void; menu(): void }): HTMLElement {
  const { away, home } = s.teams;
  const aw = s.score.away > s.score.home, hw = s.score.home > s.score.away;
  const t = (name: string, abbr: string, n: number, win: boolean) => h('div', { class: 't' }, h('small', {}, abbr), h('span', { class: `n${win ? ' w' : ''}` }, n), h('small', {}, name));
  const box = h('div', { class: 'cb-fbox', tabindex: 0, role: 'region', 'aria-label': 'Box score' });
  box.innerHTML = s.stats ? teamBox(s.stats.away, away.name, away.abbr, s.score.away) + teamBox(s.stats.home, home.name, home.abbr, s.score.home) : '<div class="cb-hint">No stats from this sim.</div>';
  const headline = aw ? `${away.name} win` : hw ? `${home.name} win` : 'Tie game';
  return h(
    'div',
    { class: 'cb-panel', style: 'width:min(640px,94vw)' },
    h('div', { class: 'cb-eyebrow' }, 'Final'),
    h('div', { class: 'cb-final-score' }, t(away.name, away.abbr, s.score.away, aw), h('span', { class: 'dash' }, '–'), t(home.name, home.abbr, s.score.home, hw)),
    h('div', { class: 'cb-hint', style: 'text-align:center' }, headline),
    box,
    h('div', { class: 'cb-btnrow' }, button('Play again', a.again, 'primary'), button('Menu', a.menu)),
  );
}

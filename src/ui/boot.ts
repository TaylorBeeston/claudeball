/**
 * The loading screen: markup and critical CSS live in `index.html` (it paints before any script runs); this drives its progress bar
 * and stage label, shows failures with a retry button and fades it away. It doubles as the curtain while a match is being prepared.
 */
export class Boot {
  private el = document.getElementById('cb-boot') as HTMLElement;
  private bar = this.el.querySelector('.bar i') as HTMLElement;
  private track = this.el.querySelector('.bar') as HTMLElement;
  private stageEl = this.el.querySelector('.stage') as HTMLElement;
  private noteEl = this.el.querySelector('.note') as HTMLElement;
  private retryBtn = this.el.querySelector('.retry') as HTMLButtonElement;
  private frac = 0;
  /** sequence of (milliseconds since page start, fraction, stage) for the loading report / tests */
  readonly log: { t: number; frac: number; stage: string }[] = [];

  /** Progress never goes backwards; `stage` names what is happening ("Loading players…"). */
  progress(frac: number, stage?: string) {
    this.frac = Math.max(this.frac, Math.min(1, frac));
    this.bar.style.transform = `scaleX(${Math.max(0.02, this.frac).toFixed(3)})`;
    this.track.setAttribute('aria-valuenow', String(Math.round(this.frac * 100)));
    if (stage && stage !== this.stageEl.textContent) {
      this.stageEl.textContent = stage;
      this.log.push({ t: Math.round(performance.now()), frac: +this.frac.toFixed(3), stage });
    }
  }

  note(text: string) {
    this.noteEl.textContent = text;
    this.noteEl.hidden = !text;
  }

  /** Show the screen again as a curtain (e.g. "Preparing the match…"), bar from zero; it is up at once (no fade-in), `hide()` fades it out. */
  show(stage: string) {
    this.frac = 0;
    this.el.classList.add('instant');
    this.el.classList.remove('gone', 'fail');
    void this.el.offsetWidth;
    requestAnimationFrame(() => this.el.classList.remove('instant'));
    this.retryBtn.hidden = true;
    this.note('');
    this.progress(0, stage);
  }

  /** A fatal problem (e.g. no WebGL2): message, red bar and a retry button. */
  fail(message: string, retry: () => void) {
    this.el.classList.add('fail');
    this.el.classList.remove('gone');
    this.stageEl.textContent = message;
    this.note('');
    this.retryBtn.hidden = false;
    this.retryBtn.onclick = () => retry();
    this.retryBtn.focus();
  }

  /** Fade out; resolves when it is no longer visible. */
  hide(): Promise<void> {
    this.progress(1);
    this.el.classList.add('gone');
    return new Promise((r) => {
      let done = false;
      const fin = () => !done && ((done = true), r());
      this.el.addEventListener('transitionend', fin, { once: true });
      setTimeout(fin, 750);
    });
  }
}

/**
 * `?audiodebug=1`: a small live panel over the game for checking the mix without ears: the master's level, the duck's gain
 * reduction, a meter per microphone of the array, the crowd zones' levels, who is talking, voices and sources, and the venue (its IR's
 * measured RT60). Updated 5 times a second; the mic meters exist only with this flag (an analyser per strip).
 */
import type { Mixer } from './mixer';
import type { Ambience } from './ambience';
import { stadiumIR } from './venue/ir';
import { mono, rt60, rt60Band } from './venue/analysis';

const dbfs = (v: number) => (v > 0 ? 20 * Math.log10(v) : -120);

export class AudioDebugPanel {
  private el: HTMLElement;
  private timer: ReturnType<typeof setInterval>;
  private rt: Record<string, string> = {};

  constructor(private mixer: Mixer, private ambience: Ambience, root: HTMLElement = document.body) {
    this.el = document.createElement('pre');
    this.el.className = 'cb-audiodebug';
    Object.assign(this.el.style, {
      position: 'fixed', left: '8px', bottom: '8px', zIndex: '9999', margin: '0', padding: '8px 10px', maxHeight: '70vh', overflow: 'auto',
      font: '11px/1.35 ui-monospace, monospace', color: '#d8f5d0', background: 'rgba(0,0,0,0.78)', borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'pre',
    } satisfies Partial<CSSStyleDeclaration>);
    root.append(this.el);
    this.timer = setInterval(() => void this.paint(), 200);
  }

  /** the venue's RT60 (computed once per preset from the same IR the convolver loads) */
  private rt60(venue: string): string {
    if (!this.rt[venue]) {
      const ir = stadiumIR(22050, venue);
      const m = mono(ir.ch);
      this.rt[venue] = `${rt60(m, 22050, 30).toFixed(2)} s (250 Hz ${rt60Band(m, 22050, 250).toFixed(2)}, 4 kHz ${rt60Band(m, 22050, 4000).toFixed(2)})`;
    }
    return this.rt[venue];
  }

  private async paint() {
    const m = this.mixer;
    const g = m.graph;
    if (!g) {
      this.el.textContent = 'audio: not running';
      return;
    }
    const lv = m.level();
    const red = await g.duckNow();
    const info = m.debugInfo();
    const bar = (db: number, lo = -60) => '█'.repeat(Math.max(0, Math.min(24, Math.round(((db - lo) / -lo) * 24)))).padEnd(24, '·');
    const lines = [
      `master  ${bar(dbfs(lv.rms))} ${dbfs(lv.rms).toFixed(1)} dBFS rms   peak ${dbfs(lv.peak).toFixed(1)}`,
      `duck    ${bar(red + 24, 0).replace(/█/g, '▓')} ${red.toFixed(1)} dB   (${g.stats.worklet === 'on' ? 'worklet' : 'analyser'}; depth ${g.duck.depth} dB, presence ${g.duck.eqDepth} dB)`,
      `talk    booth ${info.talk.booth ? 'ON ' : 'off'}  pa ${info.talk.pa ? 'ON ' : 'off'}  ${info.talk.routed ? '(Web Audio voices)' : '(browser speech: keyed by the gate)'}`,
      `venue   ${g.venue}, RT60 ${this.rt60(g.venue)}   mix: ${g.perspective}   mics ${g.mics.length}   nodes ${g.stats.nodes}`,
      `voices  ${info.voices} fx + ${info.crowdVoices} crowd (${info.sources} sources)   dropped ${info.dropped}  stolen ${info.stolen}`,
      '',
      'mics (strip level, dBFS rms)',
    ];
    const ml = g.micLevels();
    for (const [id, v] of Object.entries(ml)) lines.push(`  ${id.padEnd(12)} ${bar(v)} ${v.toFixed(1)}`);
    lines.push('', 'crowd zones (roar)');
    for (const [id, v] of Object.entries(this.ambience.zoneGains)) lines.push(`  ${id.padEnd(12)} ${'█'.repeat(Math.round((v ?? 0) * 20)).padEnd(24, '·')} ${(v ?? 0).toFixed(2)}`);
    this.el.textContent = lines.join('\n');
  }

  dispose() {
    clearInterval(this.timer);
    this.el.remove();
  }
}

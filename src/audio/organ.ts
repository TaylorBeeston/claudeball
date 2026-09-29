/**
 * Stadium organ: short synthesised riffs (charge, home-run fanfare, between-innings ditty, seventh-inning stretch, sting).
 * One PeriodicWave oscillator per note (drawbar-style harmonics) with a rotary-speaker style tremolo and vibrato, into the
 * organ bus (which also feeds the stadium reverb). All melodies here are original or plain scale/arpeggio figures.
 */
import type { OrganId } from './types';
import type { Mixer } from './mixer';

/** [midi note or 0 for a rest, beats] */
type Step = [number, number];

const G4 = 67, A4 = 69, B4 = 71, C5 = 72, D5 = 74, E5 = 76, F5 = 77, G5 = 79, C4 = 60, E4 = 64, G3 = 55, C6 = 84;

export const RIFFS: Record<OrganId, { bpm: number; steps: Step[]; chord?: number[] }> = {
  // the classic "da-da-da-DAH ... da-DAH"
  charge: { bpm: 150, steps: [[G4, 0.5], [C5, 0.5], [E5, 0.5], [G5, 1.25], [0, 0.25], [E5, 0.5], [G5, 2]] },
  hr_fanfare: { bpm: 132, steps: [[C5, 0.5], [E5, 0.5], [G5, 0.5], [C6, 1.5], [G5, 0.5], [C6, 0.5], [E5 + 12, 3]], chord: [C4, E4, G4, C5] },
  ditty: { bpm: 126, steps: [[C5, 0.5], [C5, 0.5], [G4, 0.5], [A4, 0.5], [G4, 1], [E5, 0.5], [D5, 0.5], [C5, 1.5]] },
  // waltz-time stretch tune: original
  stretch: {
    bpm: 108,
    steps: [[G4, 1], [C5, 1], [E5, 1], [D5, 2], [0, 1], [C5, 1], [B4, 1], [A4, 1], [G4, 3], [A4, 1], [B4, 1], [C5, 1], [D5, 1.5], [E5, 0.5], [D5, 1], [C5, 3]],
  },
  walk_up: { bpm: 140, steps: [[C4, 0.5], [E4, 0.5], [G4, 0.5], [A4, 0.5], [G4, 0.5], [E4, 0.5], [C4, 1.5]] },
  sting: { bpm: 150, steps: [[C5, 0.5], [0, 0.25], [G4, 0.5], [0, 0.25], [C4, 1.5]] },
  dirge: { bpm: 84, steps: [[G4, 1], [F5 - 12, 1], [F5 - 13, 1], [E4, 3]] },
};

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Organ {
  private wave: PeriodicWave | null = null;
  private lfo: OscillatorNode | null = null;
  private trem: GainNode | null = null;
  private playing = 0;
  /** riffs started, by id (debug/tests) */
  readonly started: Record<string, number> = {};

  constructor(private mixer: Mixer) {}

  private init(): boolean {
    const ctx = this.mixer.ctx;
    if (!ctx) return false;
    if (this.wave) return true;
    // drawbars: fundamental, 2nd, 3rd, 4th, 6th, 8th
    const n = 9;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    const w = [0, 1, 0.55, 0.32, 0.22, 0, 0.14, 0, 0.08];
    for (let i = 1; i < n; i++) imag[i] = w[i];
    this.wave = ctx.createPeriodicWave(real, imag);
    this.trem = ctx.createGain();
    this.trem.gain.value = 0.8;
    this.trem.connect(this.mixer.organBus);
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 5.8;
    const depth = ctx.createGain();
    depth.gain.value = 0.2;
    this.lfo.connect(depth).connect(this.trem.gain);
    this.lfo.start();
    return true;
  }

  /** Play a riff; returns false when audio is not running or another riff is still playing. */
  play(id: OrganId, gain = 1, delay = 0): boolean {
    const ctx = this.mixer.ctx;
    if (!ctx || ctx.state !== 'running' || !this.init() || this.playing > 0) return false;
    const r = RIFFS[id];
    if (!r) return false;
    const beat = 60 / r.bpm;
    let t = ctx.currentTime + delay + 0.02;
    const end = t;
    let last = t;
    const note = (m: number, at: number, dur: number, g: number) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this.wave!);
      o.frequency.value = mtof(m);
      const vib = ctx.createOscillator();
      vib.frequency.value = 6.1;
      const vd = ctx.createGain();
      vd.gain.value = 6; // cents
      vib.connect(vd).connect(o.detune);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0, at);
      e.gain.linearRampToValueAtTime(g, at + 0.015);
      e.gain.setValueAtTime(g, at + Math.max(0.02, dur - 0.06));
      e.gain.linearRampToValueAtTime(0, at + dur + 0.05);
      o.connect(e).connect(this.trem!);
      o.start(at);
      vib.start(at);
      o.stop(at + dur + 0.08);
      vib.stop(at + dur + 0.08);
      o.onended = () => {
        try {
          o.disconnect();
          vib.disconnect();
          vd.disconnect();
          e.disconnect();
        } catch {
          /* ignore */
        }
      };
    };
    for (const [m, beats] of r.steps) {
      const dur = beats * beat;
      if (m > 0) note(m, t, dur * 0.94, 0.16 * gain);
      t += dur;
      last = t;
    }
    if (r.chord) for (const m of r.chord) note(m, t - beat * 2.6, beat * 2.6, 0.1 * gain);
    this.playing++;
    this.started[id] = (this.started[id] ?? 0) + 1;
    setTimeout(() => (this.playing = Math.max(0, this.playing - 1)), Math.max(200, (last - end + delay) * 1000 + 300));
    return true;
  }

  stop() {
    try {
      this.lfo?.stop();
    } catch {
      /* ignore */
    }
    this.lfo = null;
    this.wave = null;
  }
}

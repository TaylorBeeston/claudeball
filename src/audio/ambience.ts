/**
 * Continuous stadium bed: three looping crowd buffers (murmur, roar wash, applause) whose gains and brightness follow the crowd
 * reaction model (`crowd.ts`). Everything that happens at a moment (a pop, a groan, a lone whoop) is a one-shot made by the model; this
 * only holds the loops, so the whole bed is three sources and four automated parameters.
 */
import type { Mixer } from './mixer';
import type { CrowdBed } from './crowd';

export class Ambience {
  private sources: AudioBufferSourceNode[] = [];
  private gMurmur: GainNode | null = null;
  private gRoar: GainNode | null = null;
  private gClap: GainNode | null = null;
  private lp: BiquadFilterNode | null = null;
  started = false;
  /** last applied gains (debug) */
  gains = { murmur: 0, roar: 0, clap: 0 };

  constructor(private mixer: Mixer) {}

  /** Start the loops once their buffers exist. Safe to call repeatedly. */
  start(): boolean {
    const ctx = this.mixer.ctx;
    if (this.started || !ctx || !this.mixer.ready || ctx.state !== 'running') return this.started;
    const bm = this.mixer.buffers.get('loop:murmur')?.[0];
    const br = this.mixer.buffers.get('loop:roar')?.[0];
    const bc = this.mixer.buffers.get('loop:claps')?.[0];
    if (!bm || !br) return false;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 2400;
    this.lp.connect(this.mixer.crowdProx);
    const loop = (buf: AudioBuffer, offset: number) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(g).connect(this.lp!);
      src.start(0, offset); // decorrelate the loops
      this.sources.push(src);
      return g;
    };
    this.gMurmur = loop(bm, 0);
    this.gRoar = loop(br, 2.5);
    if (bc) this.gClap = loop(bc, 1.7);
    this.started = true;
    return true;
  }

  /** apply the model's bed (call ~10 times a second) */
  apply(bed: CrowdBed) {
    if (!this.started || !this.mixer.ctx) return;
    const t = this.mixer.ctx.currentTime;
    this.gains = { murmur: bed.murmur, roar: bed.roar, clap: bed.clap };
    this.gMurmur!.gain.setTargetAtTime(bed.murmur, t, 0.35);
    this.gRoar!.gain.setTargetAtTime(bed.roar, t, 0.3);
    this.gClap?.gain.setTargetAtTime(bed.clap, t, 0.3);
    this.lp!.frequency.setTargetAtTime(bed.cutoff, t, 0.4);
  }

  stop() {
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources = [];
    this.started = false;
  }
}

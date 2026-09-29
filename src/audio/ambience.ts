/**
 * Continuous stadium bed: two looping crowd buffers (murmur, roar wash) whose gains and brightness follow the crowd's
 * excitement level, plus sparse random one-shots (a whoop, a burst of claps) so it never sounds like a loop.
 */
import type { Mixer } from './mixer';

export class Ambience {
  private murmur: AudioBufferSourceNode | null = null;
  private roar: AudioBufferSourceNode | null = null;
  private gMurmur: GainNode | null = null;
  private gRoar: GainNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private nextOneShot = 4;
  private clock = 0;
  started = false;
  /** last applied gains (debug) */
  gains = { murmur: 0, roar: 0 };

  constructor(private mixer: Mixer, private rnd: () => number = Math.random) {}

  /** Start the loops once their buffers exist. Safe to call repeatedly. */
  start(): boolean {
    const ctx = this.mixer.ctx;
    if (this.started || !ctx || !this.mixer.ready || ctx.state !== 'running') return this.started;
    const bm = this.mixer.buffers.get('loop:murmur')?.[0];
    const br = this.mixer.buffers.get('loop:roar')?.[0];
    if (!bm || !br) return false;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 2400;
    this.lp.connect(this.mixer.crowdBus);
    this.gMurmur = ctx.createGain();
    this.gRoar = ctx.createGain();
    this.gMurmur.gain.value = 0;
    this.gRoar.gain.value = 0;
    this.murmur = ctx.createBufferSource();
    this.roar = ctx.createBufferSource();
    this.murmur.buffer = bm;
    this.roar.buffer = br;
    this.murmur.loop = this.roar.loop = true;
    this.roar.loopStart = 0;
    this.murmur.connect(this.gMurmur).connect(this.lp);
    this.roar.connect(this.gRoar).connect(this.lp);
    this.murmur.start();
    this.roar.start(0, 2.5); // decorrelate the two loops
    this.started = true;
    return true;
  }

  /** excitement 0..1 (see `excitement.ts`); call ~10-30 times a second */
  update(level: number, dt: number) {
    if (!this.started || !this.mixer.ctx) return;
    const t = this.mixer.ctx.currentTime;
    const gm = 0.55 + 0.35 * level;
    const gr = Math.pow(level, 1.6) * 1.25;
    this.gains = { murmur: gm, roar: gr };
    this.gMurmur!.gain.setTargetAtTime(gm, t, 0.35);
    this.gRoar!.gain.setTargetAtTime(gr, t, 0.35);
    this.lp!.frequency.setTargetAtTime(1600 + 4400 * level, t, 0.4);
    this.clock += dt;
    if (this.clock >= this.nextOneShot) {
      this.clock = 0;
      // busier crowds make more incidental noise: a lone whoop, a ripple of applause
      this.nextOneShot = 5 + this.rnd() * 9 - level * 4;
      if (this.rnd() < 0.5) this.mixer.playCrowd('whoop', 0.12 + 0.2 * level);
      else if (level > 0.4) this.mixer.playCrowd('applause_small', 0.14 + 0.25 * level);
    }
  }

  stop() {
    for (const s of [this.murmur, this.roar]) {
      try {
        s?.stop();
        s?.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.started = false;
    this.murmur = this.roar = null;
  }
}

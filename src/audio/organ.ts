/**
 * Stadium organ: a Hammond-style synth played from `music.ts` pieces.
 *
 * Each note is a drawbar-style tone (a PeriodicWave of 8', 4', 2 2/3', 2', 1 3/5', 1 1/3', 1' partials, plus a 16' sub sine and a
 * decaying 2nd-harmonic "percussion" on lead notes) with a short key click. All notes go through a rotary-speaker ("Leslie") stage:
 * amplitude modulation, a Doppler-style delay vibrato and slow stereo movement at ~0.8 Hz (chorale) or ~6.7 Hz (tremolo),
 * a gentle low-pass and tube-style saturation, into the organ bus (which also feeds the stadium reverb).
 *
 * Pieces are scheduled a second ahead by a timer and can be cancelled at any time (pause, skip, mute, a more important riff).
 * One piece plays at a time: a higher priority one cuts a lower one (a fanfare cuts the soft bed), never the other way round.
 */
import type { Mixer } from './mixer';
import { BEDS, DITTIES, PIECES, buildPiece, pieceBeats, type NoteEvent, type OrganId, type Piece } from './music';

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

const LAYER_GAIN = { lead: 0.2, chord: 0.085, bass: 0.17, arp: 0.075 } as const;

interface Running {
  id: OrganId;
  pri: number;
  stop(fadeSec: number): void;
}

export class Organ {
  private wave: PeriodicWave | null = null;
  private bus: GainNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfo2: OscillatorNode | null = null;
  private click: AudioBuffer | null = null;
  private cur: Running | null = null;
  private dittyN = 0;
  private bedN = 0;
  /** riffs started, by id (debug/tests) */
  readonly started: Record<string, number> = {};
  /** piece ids that were refused because something more important was playing */
  refused = 0;

  constructor(private mixer: Mixer) {}

  get playing(): OrganId | null {
    return this.cur?.id ?? null;
  }

  private init(): boolean {
    const ctx = this.mixer.ctx;
    if (!ctx) return false;
    if (this.bus) return true;
    // drawbars 8', 4', 2 2/3', 2', 1 3/5', 1 1/3', 1' -> harmonics 1, 2, 3, 4, 5, 6, 8
    const w = [0, 1, 0.5, 0.42, 0.3, 0.14, 0.12, 0, 0.08];
    const imag = new Float32Array(w.length);
    for (let i = 1; i < w.length; i++) imag[i] = w[i];
    this.wave = ctx.createPeriodicWave(new Float32Array(w.length), imag);
    // key click: a few ms of band-passed noise
    const n = Math.floor(ctx.sampleRate * 0.03);
    const cb = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = cb.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = ((seed / 4294967296) * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.006));
    }
    this.click = cb;

    // rotary speaker: AM + Doppler delay + stereo sway
    const input = ctx.createGain();
    const am = ctx.createGain();
    am.gain.value = 0.8;
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.003;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200;
    lp.Q.value = 0.5;
    const sat = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(1.8 * x) / Math.tanh(1.8);
    }
    sat.curve = curve;
    const pan = ctx.createStereoPanner();
    const out = ctx.createGain();
    out.gain.value = 1;
    input.connect(am).connect(delay).connect(lp).connect(sat).connect(pan).connect(out).connect(this.mixer.organBus);
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.9;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.2;
    const dopDepth = ctx.createGain();
    dopDepth.gain.value = 0.0006;
    this.lfo.connect(amDepth).connect(am.gain);
    this.lfo.connect(dopDepth).connect(delay.delayTime);
    this.lfo2 = ctx.createOscillator(); // not exactly locked to the first: the horn and the drum rotate separately
    this.lfo2.frequency.value = 0.8;
    const swayDepth = ctx.createGain();
    swayDepth.gain.value = 0.28;
    this.lfo2.connect(swayDepth).connect(pan.pan);
    this.lfo.start();
    this.lfo2.start();
    this.bus = input;
    return true;
  }

  /** chorale (slow) or tremolo (fast) */
  private leslie(fast: boolean) {
    const ctx = this.mixer.ctx;
    if (!ctx || !this.lfo || !this.lfo2) return;
    this.lfo.frequency.setTargetAtTime(fast ? 6.7 : 0.9, ctx.currentTime, 0.5);
    this.lfo2.frequency.setTargetAtTime(fast ? 5.9 : 0.8, ctx.currentTime, 0.5);
  }

  /** The riff to play next from a rotating set (so the same ditty is not heard twice in a row). */
  pick(id: OrganId): OrganId {
    if (id === 'ditty') return DITTIES[this.dittyN++ % DITTIES.length];
    if (id === 'bed') return BEDS[this.bedN++ % BEDS.length];
    return id;
  }

  /** Play a piece; returns false when audio is not running or something more important is playing. */
  play(id: OrganId, gain = 1, delay = 0): boolean {
    const ctx = this.mixer.ctx;
    if (!ctx || ctx.state !== 'running' || !this.init()) return false;
    const piece = PIECES[this.pick(id)];
    if (!piece) return false;
    if (this.cur && this.cur.pri >= piece.pri && this.cur.pri > 0) {
      this.refused++;
      return false;
    }
    this.stop(0.12);
    this.cur = this.run(piece, gain, delay);
    this.started[piece.id] = (this.started[piece.id] ?? 0) + 1;
    return true;
  }

  /** stop whatever is playing (fade in seconds) */
  stop(fade = 0.2) {
    const c = this.cur;
    this.cur = null;
    c?.stop(fade);
  }

  private run(piece: Piece, gain: number, delay: number): Running {
    const ctx = this.mixer.ctx!;
    const events = buildPiece(piece);
    const spb = 60 / piece.bpm;
    const total = pieceBeats(piece);
    const t0 = ctx.currentTime + delay + 0.04;
    const grp = ctx.createGain();
    grp.gain.value = gain * piece.level;
    grp.connect(this.bus!);
    this.leslie(!!piece.fast);
    const live = new Set<OscillatorNode>();
    let idx = 0;
    let cycle = 0;
    let done = false;
    const me: Running = { id: piece.id, pri: piece.pri, stop: () => {} };
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      setTimeout(() => {
        try {
          grp.disconnect();
        } catch {
          /* ignore */
        }
      }, 500);
      if (this.cur === me) this.cur = null;
    };
    const tick = () => {
      const horizon = ctx.currentTime + 1.2;
      for (;;) {
        if (idx >= events.length) {
          if (piece.loop) {
            idx = 0;
            cycle++;
            continue;
          }
          // all scheduled: finished once the last note has ended
          if (ctx.currentTime > t0 + total * spb + 0.6) finish();
          return;
        }
        const e = events[idx];
        const at = t0 + (e.at + cycle * total) * spb;
        if (at > horizon) return;
        if (at >= ctx.currentTime - 0.05) this.note(e, Math.max(at, ctx.currentTime), e.dur * spb, grp, live);
        idx++;
      }
    };
    const timer = setInterval(tick, 150);
    tick();
    me.stop = (fade: number) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      const now = ctx.currentTime;
      grp.gain.cancelScheduledValues(now);
      grp.gain.setTargetAtTime(0, now, Math.max(0.02, fade / 3));
      setTimeout(() => {
        for (const o of live) {
          try {
            o.stop();
          } catch {
            /* already stopped */
          }
        }
        live.clear();
        try {
          grp.disconnect();
        } catch {
          /* ignore */
        }
      }, fade * 1000 + 120);
    };
    return me;
  }

  private note(e: NoteEvent, at: number, dur: number, dest: AudioNode, live: Set<OscillatorNode>) {
    const ctx = this.mixer.ctx!;
    const f = mtof(e.midi);
    const g = LAYER_GAIN[e.layer] * e.vel;
    const env = ctx.createGain();
    const end = at + dur;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(g, at + 0.008);
    env.gain.setValueAtTime(g, Math.max(at + 0.01, end - 0.04));
    env.gain.linearRampToValueAtTime(0, end + 0.07);
    env.connect(dest);
    const oscs: OscillatorNode[] = [];
    const add = (type: 'wave' | 'sine', freq: number, level: number, dest2: AudioNode) => {
      const o = ctx.createOscillator();
      if (type === 'wave') o.setPeriodicWave(this.wave!);
      else o.type = 'sine';
      o.frequency.value = freq;
      if (level === 1) o.connect(dest2);
      else o.connect(ctx.createGain()).connect(dest2);
      o.start(at);
      o.stop(end + 0.1);
      oscs.push(o);
      live.add(o);
      return o;
    };
    add('wave', f, 1, env);
    if (e.midi >= 40) {
      // 16' sub-octave
      const sub = ctx.createGain();
      sub.gain.value = e.layer === 'bass' ? 0.5 : 0.3;
      sub.connect(env);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f / 2;
      o.connect(sub);
      o.start(at);
      o.stop(end + 0.1);
      oscs.push(o);
      live.add(o);
    }
    if (e.layer === 'lead' || e.layer === 'arp') {
      // percussion: a quickly decaying 2nd harmonic on the attack
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.5, at);
      pg.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
      pg.connect(env);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * 2;
      o.connect(pg);
      o.start(at);
      o.stop(at + 0.25);
      oscs.push(o);
      live.add(o);
    }
    if (this.click && (e.layer === 'lead' || e.layer === 'bass')) {
      const s = ctx.createBufferSource();
      s.buffer = this.click;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600;
      bp.Q.value = 0.8;
      const cg = ctx.createGain();
      cg.gain.value = 0.5;
      s.connect(bp).connect(cg).connect(env);
      s.start(at);
    }
    const first = oscs[0];
    first.onended = () => {
      for (const o of oscs) {
        live.delete(o);
        try {
          o.disconnect();
        } catch {
          /* ignore */
        }
      }
      try {
        env.disconnect();
      } catch {
        /* ignore */
      }
    };
  }

  dispose() {
    this.stop(0.05);
    try {
      this.lfo?.stop();
      this.lfo2?.stop();
    } catch {
      /* ignore */
    }
    this.lfo = this.lfo2 = null;
    this.bus = null;
    this.wave = null;
  }
}

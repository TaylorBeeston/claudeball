/**
 * The park soundscape and the broadcast mix as a Web Audio graph (the "truck"):
 *
 *   PARK (everything that sounds in the ballpark)
 *     field effects (bat, mitt, glove, bounces, wall, slides ...) ──┐  each one-shot = K buffer sources started at its pickups' delays,
 *     crowd one-shots (per zone / diffuse) ─────────────────────────┤  one gain each into a mic strip (near or far input)
 *     crowd zone beds (loops) ── zone level / low-pass ── delay+gain pairs ─┤
 *     umpire voice (at the plate) ── delay+gain pairs ──────────────────────┤
 *     PA SYSTEM: PA voice + organ + park music ── band-limit 150 Hz-7 kHz, horn EQ, drive ── speaker clusters
 *                 (electronic delays) ── delay+gain pairs (propagation) ──┤   + slap-backs off the upper deck / scoreboard, a heavy reverb send
 *                                                                          ▼
 *     MIC STRIPS (fixed mic array, `mics.ts`): near / far(air-absorbed) inputs -> mic EQ -> fader -> static pan -> PARK BUS
 *                                                                                      └> reverb send -> CONVOLVER (stadium IR) -> PARK BUS
 *     PARK BUS -> sidechain duck (gain + dynamic 1-4 kHz cut, keyed by the booth) -> MASTER
 *
 *   BOOTH (announcers, close-miked headsets): per-voice EQ -> HP 90 Hz -> presence -> de-ess shelf -> compressor -> makeup -> limiter
 *          -> booth fader -> MASTER (dry, centred)                                └> sidechain key
 *   BROADCAST FX (camera stings, replay whooshes): dry, centred -> MASTER (not ducked: produced, not in the park)
 *   REPLAY (slow-motion replay SFX): a produced, low-passed path into the park bus, not the mics
 *   MASTER: HP 60 Hz -> glue compressor -> limiter -> soft clipper (ceiling -1 dBFS, 4x oversampled) -> analyser -> out
 *
 * Per-frame JS is zero: one-shot pickups are computed when a sound is triggered (`mics.ts`), continuous sources are wired once.
 */
import { DUCK_DEFAULTS, PROCESSOR_NAME, workletSource, type DuckParams } from './duck';
import { stadiumIR, VENUES, type VenuePreset } from './ir';
import { MICS, PLACES, SPEAKERS, micPan, micsFor, pickupOne, pickups, type MicDef, type MicId, type Pickup } from './mics';
import type { Vec3 } from '../types';

export type Perspective = 'broadcast' | 'close';

export interface Strip {
  def: MicDef;
  near: GainNode;
  far: GainNode;
  fader: GainNode;
  send: GainNode;
  meter: AnalyserNode | null;
}

/** loudness trims of the park's source families into the mic array (set by measurement, see the README's tuning guide) */
export const TRIM = { sfx: 0.9, crowd: 0.55, bed: 0.5, pa: 0.5, ump: 0.55 };

const dbToGain = (d: number) => Math.pow(10, d / 20);

/** per mic tone: a high-pass (Hz) and one shaping filter */
const TONE: Record<MicDef['tone'], { hp: number; shape: { type: BiquadFilterType; f: number; q: number; g: number } }> = {
  parabolic: { hp: 220, shape: { type: 'peaking', f: 2500, q: 0.9, g: 3 } }, // dishes are thin and bright
  shotgun: { hp: 120, shape: { type: 'peaking', f: 4500, q: 0.8, g: 2 } },
  boundary: { hp: 60, shape: { type: 'lowshelf', f: 160, q: 0.7, g: 2 } }, // boundary loading
  crowd: { hp: 140, shape: { type: 'highshelf', f: 7000, q: 0.7, g: -3 } },
  dugout: { hp: 150, shape: { type: 'peaking', f: 420, q: 1.2, g: -3 } }, // a boxy concrete bench
  house: { hp: 90, shape: { type: 'highshelf', f: 6000, q: 0.7, g: -2 } },
};

/** the PA loudspeakers: band-limited and a little horny (150 Hz - 7 kHz) */
export const PA_BAND = { lo: 150, hi: 7000 };

/** one ballpark */
export class VenueGraph {
  readonly ctx: BaseAudioContext;
  readonly mics: MicDef[];
  readonly strips = new Map<MicId, Strip>();
  /** all mic strips and the reverb return sum here */
  readonly parkBus: GainNode;
  /** the master chain's input */
  readonly master: GainNode;
  readonly out: AudioNode;
  analyser: AnalyserNode | null = null;
  readonly reverbIn: GainNode;
  readonly reverbRet: GainNode;
  private conv: ConvolverNode | null = null;
  /** PA system input (the organ, music and PA voice buses connect here) and its processed output (the speakers' feed) */
  readonly paIn: GainNode;
  readonly paOut: GainNode;
  private slaps: { g: GainNode; base: number }[] = [];
  private paVerb: GainNode;
  /** booth chain: per-voice EQ nodes come in at `boothBus`; `boothFader` is after the dynamics (the announcer slider) */
  readonly boothBus: GainNode;
  readonly boothFader: GainNode;
  /** after the sidechain tap: the render tool mutes this to measure the duck on the park alone */
  readonly boothOut: GainNode;
  private boothVoices = new Map<string, AudioNode>();
  /** the umpire's voice: a source at the plate, picked up by the field mics */
  readonly umpireIn: GainNode;
  /** slow-motion replay effects: produced, not mic'd */
  readonly replayBus: GainNode;
  /** the duck: broadband gain and a 1-4 kHz dynamic cut on the park bus */
  readonly duckGain: GainNode;
  readonly duckEq: BiquadFilterNode;
  duckNode: AudioWorkletNode | null = null;
  duck: DuckParams = { ...DUCK_DEFAULTS };
  private duckScale = 1;
  private manualKey = 0;
  venue: VenuePreset;
  perspective: Perspective;
  readonly lowPower: boolean;
  /** resolves when the reverb's IR and the duck worklet are in place (or failed) */
  readonly ready: Promise<void>;
  /** per mic strip level meters (only with `meters`: ?audiodebug=1) */
  readonly meters: boolean;
  readonly stats = { worklet: 'none' as 'none' | 'loading' | 'on' | 'failed', irMs: 0, nodes: 0 };

  constructor(ctx: BaseAudioContext, o: { lowPower?: boolean; venue?: VenuePreset; perspective?: Perspective; meters?: boolean; profile?: { noConvolver?: boolean; noOversample?: boolean; noWorklet?: boolean; noComp?: boolean } } = {}) {
    this.ctx = ctx;
    this.lowPower = !!o.lowPower;
    this.venue = o.venue ?? 'normal';
    this.perspective = o.perspective ?? 'broadcast';
    this.meters = !!o.meters;
    this.mics = micsFor(this.lowPower);
    let n = 0;
    const count = <T extends AudioNode>(x: T): T => (n++, x);
    const gain = (v = 1) => {
      const g = count(ctx.createGain());
      g.gain.value = v;
      return g;
    };
    /** a mono input: a microphone, a horn, the reverb send (everything after it runs on one channel: half the work) */
    const monoIn = (v = 1) => {
      const g = gain(v);
      g.channelCount = 1;
      g.channelCountMode = 'explicit';
      g.channelInterpretation = 'speakers';
      return g;
    };
    const bq = (type: BiquadFilterType, f: number, q = Math.SQRT1_2, g = 0) => {
      const b = count(ctx.createBiquadFilter());
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      b.gain.value = g;
      return b;
    };

    // ---- master: HP 60 -> glue -> limiter -> soft clip (-1 dBFS) -> analyser -> destination
    this.master = gain(1);
    const hp = bq('highpass', 60, 0.7);
    const glue = count(ctx.createDynamicsCompressor());
    glue.threshold.value = -20;
    glue.knee.value = 10;
    glue.ratio.value = 2;
    glue.attack.value = 0.02;
    glue.release.value = 0.3;
    const lim = count(ctx.createDynamicsCompressor());
    lim.threshold.value = -4;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.1;
    const trim = gain(0.85);
    const clip = count(ctx.createWaveShaper());
    clip.curve = softClipCurve(0.891);
    // the limiter ahead (with its look-ahead) holds the peaks: the clipper is a last safety net, not oversampled (measured: true peak
    // stays under -1 dBTP, see the README)
    clip.oversample = 'none';
    this.master.connect(hp).connect(glue).connect(lim).connect(trim).connect(clip);
    let tail: AudioNode = clip;
    try {
      this.analyser = count(ctx.createAnalyser());
      this.analyser.fftSize = 2048;
      clip.connect(this.analyser);
      tail = this.analyser;
    } catch {
      /* no analyser */
    }
    tail.connect(ctx.destination);
    this.out = tail;

    // ---- park bus -> duck -> master
    this.parkBus = gain(1);
    this.duckGain = gain(1);
    this.duckEq = bq('peaking', 2200, 0.7, 0);
    this.parkBus.connect(this.duckGain).connect(this.duckEq).connect(this.master);

    // ---- reverb: one shared stereo convolver; the IR comes a moment later (generated off the gesture)
    this.reverbIn = monoIn(1);
    this.reverbRet = gain(VENUES[this.venue].wet);
    try {
      if (o.profile?.noConvolver) throw new Error('profiling');
      this.conv = count(ctx.createConvolver());
      this.conv.normalize = false;
      this.reverbIn.connect(this.conv).connect(this.reverbRet).connect(this.parkBus);
    } catch {
      this.conv = null;
    }

    // ---- mic strips
    for (const def of this.mics) {
      const t = TONE[def.tone];
      const near = monoIn(1);
      const far = monoIn(1);
      const air = bq('lowpass', 4200, 0.6);
      const hpf = bq('highpass', t.hp, 0.7);
      const shape = bq(t.shape.type, t.shape.f, t.shape.q, t.shape.g);
      const fader = gain(1);
      const pan = ctx.createStereoPanner ? count(ctx.createStereoPanner()) : null;
      const send = gain(0);
      far.connect(air).connect(hpf);
      near.connect(hpf);
      hpf.connect(shape).connect(fader);
      if (pan) {
        pan.pan.value = micPan(def);
        fader.connect(pan).connect(this.parkBus);
      } else fader.connect(this.parkBus);
      fader.connect(send).connect(this.reverbIn);
      let meter: AnalyserNode | null = null;
      if (this.meters) {
        meter = count(ctx.createAnalyser());
        meter.fftSize = 512;
        fader.connect(meter);
      }
      this.strips.set(def.id, { def, near, far, fader, send, meter });
    }

    // ---- PA system: band-limited horns with a little drive, a few clusters around the bowl
    this.paIn = monoIn(1);
    const pa1 = bq('highpass', PA_BAND.lo, 0.7);
    const pa2 = bq('highpass', PA_BAND.lo, 0.7);
    const pa3 = bq('lowpass', PA_BAND.hi, 0.7);
    const pa4 = bq('lowpass', PA_BAND.hi, 0.7);
    const horn = bq('peaking', 2200, 1.0, 3.5);
    const box = bq('peaking', 450, 1.0, -2.5);
    const drive = count(ctx.createWaveShaper());
    drive.curve = driveCurve(1.6);
    drive.oversample = o.profile?.noOversample ? 'none' : '2x';
    this.paOut = gain(1);
    this.paIn.connect(pa1).connect(pa2).connect(pa3).connect(pa4).connect(horn).connect(box).connect(drive).connect(this.paOut);
    // every cluster heard by the mics near it, with its electronic delay plus the flight time to each mic
    const paPairs: { sp: (typeof SPEAKERS)[0]; p: Pickup; abs: number }[] = [];
    for (const sp of SPEAKERS) {
      const ps = this.mics.map((m) => pickupOne(m, sp.pos)).sort((a, b) => b.gain - a.gain).slice(0, this.lowPower ? 2 : 3);
      for (const p of ps) paPairs.push({ sp, p, abs: sp.delay + p.delay });
    }
    const t0 = Math.min(...paPairs.map((x) => x.abs));
    for (const { sp, p, abs } of paPairs) this.wire(this.paOut, p, abs - t0, sp.gain * TRIM.pa, count);
    // slap-backs: the upper deck facade and the scoreboard throw the PA back at the field, late and dark
    const slap = (delay: number, lp: number, g: number, pan: number) => {
      const d = count(ctx.createDelay(1));
      d.delayTime.value = delay;
      const f = bq('lowpass', lp, 0.7);
      const gg = gain(g);
      this.paOut.connect(d).connect(f).connect(gg);
      if (ctx.createStereoPanner) {
        const p = count(ctx.createStereoPanner());
        p.pan.value = pan;
        gg.connect(p).connect(this.parkBus);
      } else gg.connect(this.parkBus);
      gg.connect(this.reverbIn);
      this.slaps.push({ g: gg, base: g });
    };
    slap(0.21, 2600, 0.2, -0.45);
    slap(0.29, 1900, 0.13, 0.6);
    // the heavy part of "in the park": the PA excites the whole bowl
    this.paVerb = gain(0.55);
    this.paOut.connect(this.paVerb).connect(this.reverbIn);

    // ---- umpire: at the plate, heard by the field mics
    this.umpireIn = monoIn(1);
    this.wireContinuous(this.umpireIn, PLACES.umpire, TRIM.ump, 3, count);

    // ---- replay: a produced path (slowed and dulled SFX), centred, a little room
    this.replayBus = monoIn(1);
    const rlp = bq('lowpass', 900, 0.7);
    const rsend = gain(0.25);
    this.replayBus.connect(rlp).connect(this.parkBus);
    rlp.connect(rsend).connect(this.reverbIn);

    // ---- booth: close-miked headsets, a broadcast voice chain, centred and dry
    this.boothBus = monoIn(1);
    const bhp = bq('highpass', 90, 0.7);
    const pres = bq('peaking', 3000, 0.9, 2.5);
    const tame = bq('highshelf', 7500, 0.7, -3);
    const comp = count(ctx.createDynamicsCompressor());
    comp.threshold.value = -26;
    comp.knee.value = 6;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.003;
    comp.release.value = 0.16;
    const makeup = gain(dbToGain(4));
    const blim = count(ctx.createDynamicsCompressor());
    blim.threshold.value = -5;
    blim.knee.value = 0;
    blim.ratio.value = 20;
    blim.attack.value = 0.001;
    blim.release.value = 0.06;
    this.boothFader = gain(1);
    this.boothOut = gain(1);
    this.boothBus.connect(bhp).connect(pres).connect(tame).connect(comp).connect(makeup).connect(blim).connect(this.boothFader).connect(this.boothOut).connect(this.master);

    this.stats.nodes = n;
    this.applyVenue();
    this.applyPerspective();
    this.ready = Promise.all([this.loadIr(), o.profile?.noWorklet ? Promise.resolve() : this.loadDuck()]).then(() => {});
  }

  // ---- wiring helpers -------------------------------------------------------------------------------------------------------

  private wire(from: AudioNode, p: Pickup, delay: number, g: number, count: <T extends AudioNode>(x: T) => T) {
    const s = this.strips.get(p.mic);
    if (!s) return;
    const gg = count(this.ctx.createGain());
    gg.gain.value = g * p.gain;
    if (delay > 0.0005) {
      const d = count(this.ctx.createDelay(1));
      d.delayTime.value = Math.min(0.99, delay);
      from.connect(d).connect(gg);
    } else from.connect(gg);
    gg.connect(p.far ? s.far : s.near);
  }

  /** a continuous source at a fixed place: its top `k` mics, each through a delay (relative flight time) and a gain */
  wireContinuous(from: AudioNode, pos: Vec3, g: number, k: number, count: <T extends AudioNode>(x: T) => T = (x) => x) {
    for (const p of pickups(pos, this.mics, k)) this.wire(from, p, p.delay, g, count);
  }

  /**
   * One-shot at a position: K buffer sources (the same buffer and rate: the copies are the same sound arriving at different mics), each
   * started at the trigger time + its pickup delay, each through one gain into its mic strip. Returns the sources and nodes to clean up.
   */
  playAt(buffer: AudioBuffer, pos: Vec3, gain: number, when: number, rate: number, k = this.lowPower ? 2 : 3): { srcs: AudioBufferSourceNode[]; nodes: AudioNode[] } {
    const srcs: AudioBufferSourceNode[] = [];
    const nodes: AudioNode[] = [];
    for (const p of pickups(pos, this.mics, k)) {
      const s = this.strips.get(p.mic);
      if (!s) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      const g = this.ctx.createGain();
      g.gain.value = Math.min(4, gain * p.gain);
      src.connect(g);
      let tail: AudioNode = g;
      if (p.proximityDb > 1) {
        const ls = this.ctx.createBiquadFilter();
        ls.type = 'lowshelf';
        ls.frequency.value = 200;
        ls.gain.value = p.proximityDb;
        g.connect(ls);
        tail = ls;
        nodes.push(ls);
      }
      tail.connect(p.far ? s.far : s.near);
      src.start(when + p.delay);
      srcs.push(src);
      nodes.push(g);
    }
    return { srcs, nodes };
  }

  /** a stadium-wide sound (a big roar, the whole crowd): into the house pair and the crowd mics, no single position */
  playDiffuse(buffer: AudioBuffer, gain: number, when: number, rate: number, wet = 0.3): { srcs: AudioBufferSourceNode[]; nodes: AudioNode[] } {
    const srcs: AudioBufferSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const targets = this.mics.filter((m) => m.group === 'house' || (!this.lowPower && (m.id === 'crowd_3b' || m.id === 'crowd_1b')));
    targets.forEach((m, i) => {
      const s = this.strips.get(m.id)!;
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      const g = this.ctx.createGain();
      g.gain.value = gain / Math.sqrt(targets.length);
      src.connect(g).connect(s.near);
      if (wet > 0 && i === 0) {
        const w = this.ctx.createGain();
        w.gain.value = gain * wet;
        src.connect(w).connect(this.reverbIn);
        nodes.push(w);
      }
      // the copies start a few ms apart (different mics, different seats): a wide, unfocused sound
      src.start(when + i * 0.011, i ? Math.min(0.05 * i, Math.max(0, buffer.duration - 0.1)) : 0);
      srcs.push(src);
      nodes.push(g);
    });
    return { srcs, nodes };
  }

  /** a per-speaker EQ in front of the booth chain (each announcer's voice and headset are a little different) */
  boothIn(role: string): AudioNode {
    const hit = this.boothVoices.get(role);
    if (hit) return hit;
    const b = this.ctx.createBiquadFilter();
    if (role === 'color') {
      // the analyst: warmer, a touch less bite
      b.type = 'lowshelf';
      b.frequency.value = 220;
      b.gain.value = 1.5;
    } else {
      // play-by-play: a little extra cut-through
      b.type = 'peaking';
      b.frequency.value = 3600;
      b.Q.value = 1;
      b.gain.value = 1.5;
    }
    b.connect(this.boothBus);
    this.boothVoices.set(role, b);
    return b;
  }

  // ---- settings ---------------------------------------------------------------------------------------------------------------

  setVenue(v: VenuePreset) {
    if (v === this.venue) return;
    this.venue = v;
    this.applyVenue();
    void this.loadIr();
  }

  private applyVenue() {
    const p = VENUES[this.venue];
    const t = this.ctx.currentTime;
    this.reverbRet.gain.setTargetAtTime(p.wet, t, 0.1);
    const slapScale = this.venue === 'dry' ? 0.4 : this.venue === 'big' ? 1.25 : 1;
    for (const s of this.slaps) s.g.gain.setTargetAtTime(s.base * slapScale, t, 0.1);
  }

  setPerspective(p: Perspective) {
    if (p === this.perspective) return;
    this.perspective = p;
    this.applyPerspective();
  }

  /** broadcast: the designed balance; close: the field mics up, crowd and house down, drier (an "on the field" feel) */
  private applyPerspective() {
    const close = this.perspective === 'close';
    const t = this.ctx.currentTime;
    for (const s of this.strips.values()) {
      const d = s.def;
      const off = close ? (d.group === 'field' ? 4 : d.group === 'house' ? -5 : -3) : 0;
      s.fader.gain.setTargetAtTime(dbToGain(off), t, 0.1); // the mic's own fader is in its pickup gains (`mics.ts`)
      s.send.gain.setTargetAtTime(d.reverb * (close ? 0.6 : 1), t, 0.1);
    }
  }

  private async loadIr() {
    const conv = this.conv;
    if (!conv) return;
    // generate after the gesture has returned (a few tens of ms of maths)
    await new Promise((r) => setTimeout(r, 0));
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    try {
      const ir = stadiumIR(this.ctx.sampleRate, this.venue);
      const b = this.ctx.createBuffer(2, ir.ch[0].length, this.ctx.sampleRate);
      b.copyToChannel(ir.ch[0] as Float32Array<ArrayBuffer>, 0);
      b.copyToChannel(ir.ch[1] as Float32Array<ArrayBuffer>, 1);
      conv.buffer = b;
    } catch {
      /* no reverb */
    }
    this.stats.irMs = typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : 0;
  }

  // ---- the duck ---------------------------------------------------------------------------------------------------------------

  private async loadDuck() {
    const ctx = this.ctx;
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') return;
    this.stats.worklet = 'loading';
    try {
      const url = URL.createObjectURL(new Blob([workletSource()], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      const split = ctx.createChannelSplitter(2);
      node.connect(split);
      split.connect(this.duckGain.gain, 0);
      split.connect(this.duckEq.gain, 1);
      this.boothFader.connect(node);
      // the worklet now drives both: the static values become 0 (the control signal is added to them)
      this.duckGain.gain.cancelScheduledValues(0);
      this.duckGain.gain.value = 0;
      this.duckEq.gain.cancelScheduledValues(0);
      this.duckEq.gain.value = 0;
      this.duckNode = node;
      this.stats.worklet = 'on';
      this.applyDuck();
    } catch {
      this.stats.worklet = 'failed';
    }
  }

  /** depth (dB), the presence cut (dB), attack / release (s) */
  setDuck(p: Partial<DuckParams>) {
    this.duck = { ...this.duck, ...p };
    this.applyDuck();
  }

  /** big crowd moments duck less (a home-run roar stays big under the call): 0.4..1 of the depth */
  setDuckScale(x: number) {
    if (Math.abs(x - this.duckScale) < 0.02) return;
    this.duckScale = x;
    this.applyDuck();
  }

  /** a voice that is not in Web Audio (browser speech) is talking: 0..1 */
  setKey(x: number) {
    if (x === this.manualKey) return;
    this.manualKey = x;
    this.applyDuck();
  }

  private applyDuck() {
    const t = this.ctx.currentTime;
    const depth = this.duck.depth * this.duckScale;
    const eq = this.duck.eqDepth * this.duckScale;
    const n = this.duckNode;
    if (n) {
      const set = (k: string, v: number) => n.parameters.get(k)?.setValueAtTime(v, t);
      set('depth', depth);
      set('eqDepth', eq);
      set('threshold', this.duck.threshold);
      set('range', this.duck.range);
      set('attack', this.duck.attack);
      set('release', this.duck.release);
      set('hold', this.duck.hold);
      set('ext', this.manualKey);
      return;
    }
    // no worklet (insecure origin, old Safari): the same duck from the key flag, with the same time constants
    const on = this.manualKey > 0;
    const tc = (on ? this.duck.attack : this.duck.release) / 3;
    this.duckGain.gain.setTargetAtTime(on ? dbToGain(-depth * this.manualKey) : 1, t, tc);
    this.duckEq.gain.setTargetAtTime(on ? -eq * this.manualKey : 0, t, tc);
  }

  /** the duck's current reduction, dB (asks the worklet; resolves to the manual value without one) */
  duckNow(): Promise<number> {
    const n = this.duckNode;
    if (!n) return Promise.resolve(20 * Math.log10(Math.max(1e-6, this.duckGain.gain.value)));
    return new Promise((res) => {
      const done = setTimeout(() => res(0), 200);
      n.port.onmessage = (e) => {
        clearTimeout(done);
        res((e.data as { red: number }).red);
      };
      n.port.postMessage(0);
    });
  }

  /** RMS (dBFS) of every mic strip right now (meters on only) */
  micLevels(): Record<string, number> {
    const out: Record<string, number> = {};
    const buf = new Float32Array(512);
    for (const [id, s] of this.strips) {
      if (!s.meter) continue;
      s.meter.getFloatTimeDomainData(buf);
      let acc = 0;
      for (const x of buf) acc += x * x;
      out[id] = +(10 * Math.log10(acc / buf.length + 1e-12)).toFixed(1);
    }
    return out;
  }
}

/** linear below `k * ceiling`, then a tanh knee that never passes `ceiling` */
export function softClipCurve(ceiling: number, k = 0.75, n = 4096): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const knee = ceiling * k;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** a horn driver pushed a little: tanh saturation, normalised to unity at full scale */
export function driveCurve(drive: number, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return c;
}

export { MICS };

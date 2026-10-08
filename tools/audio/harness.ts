/**
 * Browser side of the headless render (`tools/audio/render.ts` loads `harness.html` from a Vite dev server): builds the game's real
 * mixer graph on an OfflineAudioContext, plays a scripted scene through it (the organ, the PA voice, a pitch, a bat crack, a fly ball to
 * the fence, a home-run roar, booth lines over it), and hands the rendered PCM back. Booth / PA speech is a recording passed in by the
 * runner (the owner's own voice files when present, never committed) or a synthetic speech-like signal.
 *
 * The mixer, the organ, the ambience and the HD speech engine are the production classes; the harness only plays the controller's part
 * (event -> crowd model -> shots, speaking flags), stepping the offline context with `suspend()` every 100 ms.
 */
import { Mixer, DEFAULT_SETTINGS, type Settings } from '../../src/audio/mixer';
import { Ambience } from '../../src/audio/ambience';
import { Organ } from '../../src/audio/organ';
import { CrowdModel, type CrowdCtx, type CrowdShot } from '../../src/audio/crowd';
import { NeuralSpeechEngine, type Synth } from '../../src/audio/neural';
import { mulberry32 } from '../../src/audio/dsp';
import type { Cue, RawEvent } from '../../src/audio/types';
import { bench } from './bench';

type Sfx = Extract<Cue, { kind: 'sfx' }>;

export interface RenderOpts {
  seconds?: number;
  sr?: number;
  /** base64 of a WAV/OGG file used as the voice of the booth and PA lines */
  voice?: string | null;
  /** settings overrides (venue, volumes ...) */
  settings?: Partial<Settings> & Record<string, unknown>;
  /** which parts play: default all */
  parts?: { organ?: boolean; crowd?: boolean; sfx?: boolean; pa?: boolean; booth?: boolean };
  /** mute the booth into the master but keep its sidechain key (measure the duck on the park bus) */
  boothSilent?: boolean;
  /** extra hooks (the IR / mic stems) */
  probe?: 'ir' | null;
  /** the scene: 'game' (default), 'impulse' (one click at the plate, for the venue response), 'duck' (steady bed + booth line) */
  scene?: 'game' | 'impulse' | 'duck' | 'organ' | 'pa-noise' | 'montage';
  lowPower?: boolean;
  /** profiling: build without parts of the graph */
  debug?: { noConvolver?: boolean; noOversample?: boolean; noWorklet?: boolean; noBeds?: boolean; noShots?: boolean; linearShapers?: boolean };
}

export interface RenderOut {
  sr: number;
  channels: string[];
  renderMs: number;
  seconds: number;
  info: Record<string, unknown>;
}

const b64ToBuf = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
function f32ToB64(a: Float32Array): string {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** a speech-like stand-in: a glottal pulse train with jitter through moving formants, syllables at ~4.5 Hz */
function fakeSpeech(sr: number, seconds: number, f0 = 115): Float32Array {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  const r = mulberry32(77);
  const formants = [
    [700, 1220, 2600],
    [300, 2300, 3000],
    [500, 900, 2400],
    [400, 1900, 2550],
    [600, 1000, 2500],
  ];
  const state = [0, 0, 0].map(() => ({ y1: 0, y2: 0 }));
  let phase = 0;
  let syl = 0;
  let sylT = 0;
  let sylLen = 0.2;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if (t - sylT > sylLen) {
      sylT = t;
      sylLen = 0.15 + r() * 0.12;
      syl = Math.floor(r() * formants.length);
      if (r() < 0.12) sylLen += 0.25; // a pause
    }
    const x = (t - sylT) / sylLen;
    const env = x < 0.15 ? x / 0.15 : x > 0.7 ? Math.max(0, (1 - x) / 0.3) : 1;
    const pause = sylLen > 0.4 && x > 0.4 ? 0 : 1;
    const f = f0 * (1 + 0.08 * Math.sin(t * 2.1)) * (1 + (r() - 0.5) * 0.01);
    phase += f / sr;
    let src = 0;
    if (phase >= 1) {
      phase -= 1;
      src = 1;
    }
    src += (r() - 0.5) * 0.04; // breath
    if (syl === 1 && x < 0.25) src += (r() - 0.5) * 0.5; // a fricative onset
    let y = 0;
    formants[syl].forEach((fc, k) => {
      const w = (2 * Math.PI * fc) / sr;
      const rad = Math.exp((-Math.PI * (60 + 40 * k)) / sr);
      const s = state[k];
      const o = src * (1 - rad) * (k === 0 ? 1 : 0.5 / k) + 2 * rad * Math.cos(w) * s.y1 - rad * rad * s.y2;
      s.y2 = s.y1;
      s.y1 = o;
      y += o;
    });
    out[i] = y * env * pause * 2.5;
  }
  return out;
}

class FakeSynth implements Synth {
  constructor(private voice: Float32Array, private sr: number) {}
  async init() {}
  dispose() {}
  async generate(): Promise<{ samples: Float32Array; sr: number }> {
    return { samples: this.voice, sr: this.sr };
  }
}

const crowdCtx = (half: 'top' | 'bottom' = 'bottom'): CrowdCtx => ({ inning: 7, half, outs: 1, balls: 1, strikes: 1, score: { home: 3, away: 3 }, runners: [true, false, false] });

export async function render(o: RenderOpts = {}): Promise<RenderOut> {
  const sr = o.sr ?? 48000;
  const scene = o.scene ?? 'game';
  const seconds = o.seconds ?? (scene === 'impulse' ? 5 : scene === 'duck' ? 14 : scene === 'organ' ? 9 : scene === 'pa-noise' ? 6 : scene === 'montage' ? 46 : 34);
  const parts = { organ: true, crowd: true, sfx: true, pa: true, booth: true, ...(o.parts ?? {}) };
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(sr * seconds), sampleRate: sr });
  // the production code only plays into a running context; an offline one is 'suspended' between steps
  Object.defineProperty(ctx, 'state', { get: () => 'running' });
  const settings = { ...DEFAULT_SETTINGS, ...(o.settings ?? {}) } as Settings;
  const m = new Mixer(settings, () => ctx as unknown as AudioContext);
  m.lowPower = !!o.lowPower;
  const mx = m as unknown as Record<string, any>;
  if (typeof mx.setOffline === 'function') mx.setOffline(true);
  if (o.debug && typeof mx.setDebug === 'function') mx.setDebug(o.debug);
  await m.unlock();
  if (typeof mx.whenReady === 'function') await mx.whenReady();
  const t0 = performance.now();
  while (!m.ready && performance.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 10));
  if (o.boothSilent && typeof mx.setDebug === 'function') mx.setDebug({ boothSilent: true });

  let voice: Float32Array;
  let voiceSr = sr;
  if (o.voice) {
    const b = await ctx.decodeAudioData(b64ToBuf(o.voice));
    voice = b.getChannelData(0).slice();
    voiceSr = b.sampleRate;
    // trim to 4.5 s and normalise to -3 dBFS peak (a TTS line is normalised like this)
    voice = voice.subarray(0, Math.min(voice.length, Math.floor(voiceSr * 4.5)));
    let pk = 0;
    for (const v of voice) pk = Math.max(pk, Math.abs(v));
    if (pk > 0) voice = voice.map((v) => (v / pk) * 0.7);
  } else voice = fakeSpeech(sr, 3.5);
  const engine = new NeuralSpeechEngine(new FakeSynth(voice, voiceSr), m, null, 'gpu');
  await engine.init('gpu', () => {});

  const organ = new Organ(m);
  const ambience = new Ambience(m);
  const crowd = new CrowdModel({ rng: mulberry32(4242), lowPower: !!o.lowPower });
  crowd.setContext(crowdCtx());
  const info: Record<string, unknown> = { scene, voice: o.voice ? 'recording' : 'synthetic', events: [] as string[] };
  const log = (s: string) => (info.events as string[]).push(`${ctx.currentTime.toFixed(2)} ${s}`);

  const playShot = (s: CrowdShot) => {
    if (typeof mx.playCrowdShot === 'function') return mx.playCrowdShot(s);
    if (s.id === 'seat_thump') return m.playSfx({ kind: 'sfx', id: 'seat_thump', pos: { x: (s.pan ?? 0) * 70, y: 4, z: 40 }, gain: s.gain, imp: 0 });
    return m.playCrowd(s.id, s.gain, s.delay, { pan: s.pan, rate: s.rate, sweep: s.sweep });
  };
  const sfx = (c: Omit<Sfx, 'kind' | 'imp'> & { imp?: Sfx['imp'] }) => {
    if (!parts.sfx) return;
    m.playSfx({ kind: 'sfx', imp: 2, ...c } as Sfx);
    log(`sfx ${c.id}`);
  };
  let speaking = 0;
  const say = (role: 'pa' | 'pbp' | 'color', text: string) =>
    new Promise<void>((res) => {
      const done = setTimeout(res, 3000);
      engine.speak(text, {
        role,
        pitch: 1,
        rate: 1,
        volume: role === 'pa' ? 1 : 0.9,
        onstart: () => {
          speaking++;
          m.setMode({ speaking: true });
          if (role !== 'pa') m.setVoiceDuck(0.56, 1);
          clearTimeout(done);
          log(`say ${role}`);
          res();
        },
        onend: () => {
          speaking--;
          if (!speaking) {
            m.setMode({ speaking: false });
            m.setVoiceDuck(1, 1);
          }
        },
        onerror: () => res(),
      });
    });
  const observe = (ev: RawEvent, half: 'top' | 'bottom' = 'bottom') => {
    if (parts.crowd) crowd.observe(ev, crowdCtx(half));
  };

  // the script: [time, action]
  const plate = { x: 0, y: 1, z: 0 };
  const script: [number, () => unknown][] = [];
  if (scene === 'game') {
    script.push(
      [0.5, () => parts.organ && (organ.play('charge', 1), log('organ charge'))],
      [5.5, () => parts.pa && say('pa', 'Now batting, number twenty three.')],
      [11.0, () => sfx({ id: 'pitch_whoosh', pos: { x: 0, y: 1.8, z: 17.5 }, gain: 0.5 })],
      [11.42, () => sfx({ id: 'swing_whoosh', pos: { x: 0.8, y: 1, z: 0.3 }, gain: 0.5 })],
      [11.45, () => (sfx({ id: 'bat_crack', bucket: 2, pos: plate, gain: 1 }), observe({ type: 'contact', exitMph: 106, launchDeg: 29, sprayDeg: 18 }))],
      [16.2, () => sfx({ id: 'wall_thud', pos: { x: 32, y: 3, z: 98 }, gain: 0.9 })],
      [16.25, () => sfx({ id: 'fence_rattle', pos: { x: 32, y: 3, z: 98 }, gain: 0.6 })],
      [16.3, () => observe({ type: 'homeRun', batterId: 'b1' })],
      [19.0, () => parts.booth && say('pbp', 'And that ball is gone.')],
      [25.0, () => sfx({ id: 'glove_pop', bucket: 1, pos: { x: -19, y: 1.2, z: 19 }, gain: 0.6 })],
      [27.5, () => parts.booth && say('color', 'What a swing that was.')],
    );
  } else if (scene === 'impulse') {
    script.push([0.5, () => sfx({ id: 'bat_crack', bucket: 2, pos: plate, gain: 1 })]);
    parts.crowd = false;
  } else if (scene === 'duck') {
    script.push([5.0, () => parts.booth && say('pbp', 'And that ball is gone.')]);
  } else if (scene === 'montage') {
    // the foley through the mic array: every catch, the bat, the ball on things, the rituals (the crowd a quiet bed under it)
    const C = { x: 0, y: 0.8, z: -1.1 }; // the catcher's mitt
    const F1 = { x: -19.4, y: 1.1, z: 19.4 }, SS = { x: 9, y: 0.4, z: 32 }, CF = { x: 4, y: 2.2, z: 95 }, LF = { x: 40, y: 1.8, z: 80 };
    const at = (t: number, id: string, pos: { x: number; y: number; z: number }, o: Record<string, number> = {}) => script.push([t, () => sfx({ id: id as Sfx['id'], pos, gain: 0.8, ...o })]);
    let t = 0.6;
    // four pitches, slow to fast: the mitt pop grows; one in the dirt (blocked), one framed on the corner
    for (const [b, mph] of [[0, 76], [1, 85], [2, 92], [3, 99]]) {
      at(t, 'pitch_whoosh', { x: 0, y: 1, z: 1.2 }, { bucket: mph >= 88 ? 1 : 0, gain: 0.5 });
      at(t + 0.07, 'mitt_pop', C, { bucket: b, gain: 0.75 + 0.1 * b });
      t += 1.6;
    }
    at(t, 'mitt_block', C);
    t += 1.4;
    at(t, 'mitt_pop', C, { bucket: 2 });
    at(t + 0.12, 'mitt_creak', C, { gain: 0.5 });
    t += 1.8;
    // contact: sweet spot, solid, ordinary, jammed, off the end, foul tip, bunt; the bat dropped
    for (const [id, b] of [['bat_crack', 2], ['bat_crack', 1], ['bat_crack', 0], ['bat_thud', 0], ['bat_thud', 1], ['bat_tick', 0], ['bunt_tap', 0]] as [string, number][]) {
      at(t, id, { x: 0.3, y: 0.9, z: 0.3 }, { bucket: b, gain: 0.95 });
      t += 1.3;
    }
    at(t, 'bat_drop', { x: -0.6, y: 0.1, z: 0.5 }, { gain: 0.6 });
    t += 1.6;
    // a grounder to short: bounces on the grass and the dirt, the scoop, the transfer, the throw, the first baseman
    at(t, 'ground_bounce', { x: 4, y: 0.1, z: 14 }, { bucket: 1 });
    at(t + 0.45, 'dirt_thud', { x: 8, y: 0.1, z: 27 }, { bucket: 0 });
    at(t + 0.75, 'glove_pop', SS, { bucket: 4 });
    at(t + 1.0, 'glove_transfer', SS, { gain: 0.7 });
    at(t + 1.3, 'throw_whip', SS, { bucket: 2 });
    at(t + 1.95, 'glove_pop', F1, { bucket: 1 });
    at(t + 2.0, 'base_thud', { x: -19.4, y: 0.1, z: 19.4 }, { bucket: 0 });
    t += 3.4;
    // a line drive caught, a ball in the webbing, a bare-hand smack, a soft return to the pitcher
    at(t, 'glove_pop', { x: -10, y: 1.4, z: 30 }, { bucket: 2 });
    at(t + 1.3, 'glove_pop', { x: 12, y: 1.0, z: 28 }, { bucket: 5 });
    at(t + 2.4, 'bare_smack', { x: 17, y: 0.6, z: 20 });
    at(t + 3.4, 'throw_whip', C, { bucket: 0, gain: 0.5 });
    at(t + 4.1, 'glove_pop', { x: 0, y: 1.3, z: 17 }, { bucket: 0, gain: 0.6 });
    t += 5.2;
    // a fly to centre (the outfield thwup), off the left-field wall, the warning track, the top rail
    at(t, 'glove_pop', CF, { bucket: 3 });
    at(t + 1.4, 'dirt_thud', { x: 36, y: 0.1, z: 92 }, { bucket: 1 });
    at(t + 1.9, 'wall_thud', { x: 40, y: 1.2, z: 96 }, { bucket: 1 });
    at(t + 3.1, 'wall_thud', LF, { bucket: 0 });
    at(t + 4.2, 'fence_rattle', { x: 30, y: 2.3, z: 108 }, { gain: 0.6 });
    t += 5.4;
    // a tag on the slide at second, a missed tag, hit by pitch, a wild pitch to the backstop, a foul into the seats
    at(t, 'slide_scuff', { x: 0.5, y: 0.2, z: 37.5 }, { bucket: 0 });
    at(t + 0.35, 'tag_slap', { x: 0, y: 0.5, z: 38.5 });
    at(t + 1.6, 'tag_miss', { x: 19, y: 0.8, z: 19 });
    at(t + 2.6, 'body_thump', { x: 0.8, y: 1.1, z: 0.3 });
    at(t + 3.8, 'backstop_bang', { x: 1, y: 0.6, z: -20.3 });
    at(t + 5.0, 'seat_thump', { x: 40, y: 7, z: 10 });
    at(t + 5.2, 'seat_scramble', { x: 40, y: 7, z: 10 });
    t += 6.8;
    // rituals: Velcro, a helmet tap, the spikes, the rosin bag, the pouch, the umpire's gear
    at(t, 'velcro', { x: 0.9, y: 1.2, z: 0.3 });
    at(t + 0.9, 'helmet_tap', { x: 0.9, y: 1.75, z: 0.3 });
    at(t + 1.6, 'bat_tap', { x: 0.9, y: 0.2, z: 0.3 });
    at(t + 2.6, 'rosin_poof', { x: 0.6, y: 0.3, z: 17.5 });
    at(t + 3.5, 'pouch', { x: 0, y: 1, z: -1.6 });
    at(t + 4.2, 'ump_gear', { x: 0, y: 1.5, z: -1.6 });
    at(t + 5.0, 'rail_thump', { x: 18.7, y: 0.8, z: 2.5 });
  } else if (scene === 'pa-noise') {
    // the PA system's transfer: white noise into the PA voice input, the speakers' feed (before the air and the mics) to the output
    parts.crowd = false;
    const g = mx.graph as { out: AudioNode; paOut: AudioNode };
    g.out.disconnect();
    g.paOut.connect(ctx.destination);
    const n = ctx.createBuffer(1, sr * (seconds - 1), sr);
    const d = n.getChannelData(0);
    const rr = mulberry32(5);
    for (let i = 0; i < d.length; i++) d[i] = (rr() * 2 - 1) * 0.05;
    script.push([0.5, () => {
      const src = ctx.createBufferSource();
      src.buffer = n;
      src.connect(m.paBus);
      src.start();
    }]);
  } else if (scene === 'organ') {
    parts.crowd = false;
    script.push([0.3, () => organ.play('charge', 1)]);
  }
  script.sort((a, b) => a[0] - b[0]);

  // step the context every 100 ms: the crowd model and its bed, due script actions; a real-time pause now and then lets the organ's
  // look-ahead scheduler (setInterval, 150 ms) run, so its notes land at the same audio times on every run
  const step = 0.1;
  let si = 0;
  /** time the context sat suspended (the callbacks' JS work and real-time waits): not part of the graph's rendering cost */
  let suspendedMs = 0;
  const steps = Math.floor(seconds / step);
  for (let k = 1; k < steps; k++) {
    const at = k * step;
    void ctx.suspend(at).then(async () => {
      const c0 = performance.now();
      if (parts.crowd) {
        if (!ambience.started && !o.debug?.noBeds) ambience.start();
        const bed = crowd.update(step, true);
        ambience.apply(bed);
        for (const s of crowd.take()) if (!o.debug?.noShots) playShot(s);
      }
      while (si < script.length && script[si][0] <= at + 1e-6) await script[si++][1]();
      const om = organ as unknown as { pump?: () => void; playing: string | null };
      if (om.pump) om.pump();
      if (typeof mx.offlineTick === 'function') mx.offlineTick(step);
      if (!om.pump && om.playing && k % 5 === 0) await new Promise((r) => setTimeout(r, 170));
      suspendedMs += performance.now() - c0;
      await ctx.resume();
    });
  }
  const r0 = performance.now();
  const buf = await ctx.startRendering();
  const renderMs = performance.now() - r0 - suspendedMs;
  info.mixer = typeof mx.debugInfo === 'function' ? mx.debugInfo() : { voices: m.voiceCount, played: m.played };
  info.organ = organ.started;
  return { sr, channels: [f32ToB64(buf.getChannelData(0)), f32ToB64(buf.getChannelData(1))], renderMs, seconds, info };
}

/** the impulse response the venue would load (for its RT60), if the mixer exposes it */
export async function venueIr(o: { sr?: number; venue?: string } = {}): Promise<{ sr: number; channels: string[] } | null> {
  const irPath = '../../src/audio/venue/ir.ts';
  const mod = (await import(/* @vite-ignore */ irPath).catch(() => null)) as null | { stadiumIR: (sr: number, preset: string) => { sr: number; ch: Float32Array[] } };
  if (!mod) return null;
  const ir = mod.stadiumIR(o.sr ?? 48000, o.venue ?? 'normal');
  return { sr: ir.sr, channels: ir.ch.map(f32ToB64) };
}

(window as unknown as Record<string, unknown>).cbAudio = { render, venueIr, bench: (...a: Parameters<typeof bench>) => bench(...a) };

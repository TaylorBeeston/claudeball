/**
 * The promo capture runtime (`?promo&autostart&noaudio`): loaded lazily by the app like the benchmark, never part of the game's
 * main bundle. `tools/promo/render.ts` drives it over CDP as `window.__promo`:
 *
 *   await __promo.setup(shot)        seek the game to the shot (fast, unrendered), then the pre-roll at speed 1 under a virtual clock,
 *                                    with the game's own audio graph attached to an OfflineAudioContext
 *   await __promo.frame()            one output frame: camera, slow-motion ramp, timers, engine tick, HUD animations, audio
 *   await __promo.finishAudio()      the rendered audio of the shot (base64 float32 per channel) + what was said, when
 *
 * Everything that moves is driven by the virtual clock (`clock.ts`) and a seeded Math.random, so a re-shoot gives the same frames.
 */
import { Vector3 } from 'three';
import type { Engine } from '../engine/engine';
import { attachAudio, type AudioController } from '../audio';
import { hdManager } from '../audio/hd';
import { CameraPath, rampAt, type CamKey, type RampPoint, type V3 } from './cameraPath';
import { VirtualClock, realTimers, seedRandom } from './clock';

export interface ShotSetup {
  id: string;
  /** sim time of frame 0 */
  start: number;
  /** sim time the ramp and sim-keyed camera keys are relative to (the contact, the catch) */
  anchor: number;
  fps: number;
  frames: number;
  /** seconds of live game played (not drawn) before frame 0: the replay needs the history, the booth and crowd need a run-up */
  preroll: number;
  /** seconds before frame 0 that the audio graph starts (its buffers and beds settle) */
  audioPreroll: number;
  tod: 'day' | 'dusk' | 'night';
  camera: { mode: 'director'; replays?: boolean; broll?: boolean } | { mode: 'path'; keys: CamKey[]; keysIn?: 'out' | 'sim' };
  ramp?: RampPoint[];
  hud: boolean;
  audio: boolean;
  /** the sim's fixed step: 1/240 for ultra slow motion */
  simDt?: number;
  randomSeed: number;
  /** chatter level for the booth */
  chatter?: 'low' | 'normal' | 'high';
}

interface FrameInfo {
  i: number;
  sim: number;
  speed: number;
  shot: string;
  replay: boolean;
  events: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => realTimers.setTimeout(r, ms));

class PromoAudio {
  ctx!: OfflineAudioContext;
  audio: AudioController | null = null;
  private started = false;
  private rendering: Promise<AudioBuffer> | null = null;
  readonly speech: { t: number; ev: unknown }[] = [];
  /** ctx time of output frame 0 */
  t0 = 0;
  readonly sr = 48000;

  async attach(engine: Engine, seconds: number, chatter: string) {
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(this.sr * seconds), sampleRate: this.sr });
    Object.defineProperty(ctx, 'state', { get: () => 'running' });
    this.ctx = ctx;
    const W = window as unknown as { AudioContext: unknown };
    const Orig = W.AudioContext;
    W.AudioContext = function () {
      return ctx;
    };
    try {
      const a = attachAudio(engine as never, document.body, { ui: false });
      if (!a) throw new Error('audio did not attach');
      this.audio = a;
      Object.assign(a.settings, { muted: false, hd: true, chatter, commentary: true, pa: true, organ: true });
      a.mixer.setOffline(true);
      a.settingsChanged();
      console.log('[promo] audio: unlocking');
      await a.unlock();
      console.log('[promo] audio: unlocked, ctx ' + ctx.length / this.sr + ' s');
    } finally {
      W.AudioContext = Orig;
    }
    await this.audio.mixer.whenReady();
    console.log('[promo] audio: graph ready, hd engine ' + !!hdManager.engine);
    this.audio.onSpeech((ev) => this.speech.push({ t: ctx.currentTime, ev }));
    if (!hdManager.engine) throw new Error('HD voices are not active: browser speech cannot be captured');
  }

  /** busy: an HD line being generated (the frame waits for it in real time; the virtual clock does not move) */
  get busy(): boolean {
    const e = hdManager.engine as unknown as { inflight?: unknown; jobs?: unknown[] } | null;
    return !!e && (!!e.inflight || (e.jobs?.length ?? 0) > 0);
  }

  /** render the audio up to ctx time `t` (seconds) */
  async to(t: number) {
    const ctx = this.ctx;
    if (t <= ctx.currentTime + 1 / this.sr) return;
    this.audio?.mixer.offlineTick(t - ctx.currentTime);
    const reached = ctx.suspend(Math.min(t, ctx.length / this.sr - 0.01));
    if (!this.started) {
      this.started = true;
      this.rendering = ctx.startRendering();
    } else await ctx.resume();
    await reached;
  }

  async finish(): Promise<{ sr: number; channels: string[]; t0: number; speech: { t: number; ev: unknown }[] }> {
    if (!this.started) {
      this.started = true;
      this.rendering = this.ctx.startRendering();
    } else await this.ctx.resume();
    const buf = await this.rendering!;
    const channels: string[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const a = buf.getChannelData(c);
      const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      channels.push(btoa(s));
    }
    this.audio?.dispose();
    return { sr: buf.sampleRate, channels, t0: this.t0, speech: this.speech };
  }
}

export class PromoRuntime {
  readonly clock = new VirtualClock();
  private shot: ShotSetup | null = null;
  private path: CameraPath | null = null;
  private frameIndex = 0;
  private events: string[] = [];
  private anims = new Map<Animation, number>();
  private audio: PromoAudio | null = null;
  private v = { pos: new Vector3(), tgt: new Vector3() };
  private face = new Vector3();
  private firstCut = true;
  /** sim time of the first drawn frame (sim-keyed camera paths count from the anchor) */
  log: string[] = [];

  constructor(readonly e: Engine) {
    this.clock.install();
    e.stop();
    e.sim.on((te) => {
      const t = te.event.type;
      if (t !== 'broadcast') this.events.push(t);
    });
  }

  /** the HD voices (Kokoro) are downloaded / loaded once per browser profile, in real time, before any shot */
  async voices(): Promise<string> {
    if (!hdManager.engine) await hdManager.enable();
    return hdManager.engine ? 'ready' : `failed: ${hdManager.status().text ?? hdManager.status().state}`;
  }

  /** fast-forward the game to sim time `t` without drawing (replays and B-roll off, so nothing holds the sim) */
  private seek(t: number) {
    const e = this.e;
    const d = e.director as unknown as { replaysEnabled: boolean; brollEnabled: boolean };
    d.replaysEnabled = false;
    d.brollEnabled = false;
    e.sim.stepBudgetMs = 1e9;
    e.sim.speed = 60;
    while (e.liveState.time < t - 2) e.tick(1 / 60, false);
    e.sim.speed = 1;
    while (e.liveState.time < t) e.tick(1 / 60, false);
  }

  async setup(s: ShotSetup): Promise<{ sim: number; gpu: string }> {
    const e = this.e;
    this.shot = s;
    this.frameIndex = 0;
    seedRandom(s.randomSeed);
    e.setTimeOfDay(s.tod);
    e.adaptive.enabled = false;
    e.adaptive.scale = 1;
    e.resize();
    if (s.simDt) e.sim.stepDt = s.simDt;
    this.seek(Math.max(0, s.start - s.preroll));
    console.log(`[promo] seek done at ${e.liveState.time.toFixed(2)}`);
    // the live run-up, at speed 1 under the virtual clock
    const d = e.director as unknown as { replaysEnabled: boolean; brollEnabled: boolean };
    const director = s.camera.mode === 'director';
    d.replaysEnabled = s.camera.mode === 'director' ? s.camera.replays !== false : false;
    d.brollEnabled = director ? !!(s.camera as { broll?: boolean }).broll : false;
    this.path = s.camera.mode === 'path' ? new CameraPath(s.camera.keys) : null;
    e.director.bench = null;
    this.hud(s.hud);
    // whatever is still animating from the boot (the loading screen fading out) ends now, before the clock takes over
    for (const a of document.getAnimations()) {
      try {
        a.finish();
      } catch {
        a.cancel(); // an infinite one (the loading screen's lamps)
      }
    }
    document.querySelectorAll('#cb-boot, .cb-boot, #boot, .cb-loading').forEach((n) => ((n as HTMLElement).style.display = 'none'));
    // the audio graph is built on the real clock (its reverb, worklet and sound buffers are made with timers and workers), then the
    // offline context runs in step with the picture from the first frame of the pre-roll
    if (s.audio) {
      this.audio = new PromoAudio();
      await this.audio.attach(e, s.start - e.liveState.time + s.frames / s.fps + 2, s.chatter ?? 'normal');
      const m = this.audio.audio!.mixer;
      const t0 = realTimers.perfNow();
      while (!m.ready && realTimers.perfNow() - t0 < 30000) await sleep(20);
      console.log(`[promo] audio: ${m.prepared}/${m.totalToPrepare} sounds ready in ${(realTimers.perfNow() - t0).toFixed(0)} ms`);
    }
    this.clock.virtualize();
    const dt = 1 / s.fps;
    while (e.liveState.time < s.start - 1e-6) {
      const left = s.start - e.liveState.time;
      // the last second is drawn (autofocus, exposure, temporal AO settle); before that only updated
      this.clock.advance(dt * 1000);
      this.applyCamera(e.liveState.time);
      e.tick(dt, left < 1.2);
      if (this.audio) {
        await this.waitVoices();
        await this.audio.to(this.audio.ctx.currentTime + dt);
      }
    }
    console.log(`[promo] pre-roll done at ${e.liveState.time.toFixed(2)}`);
    if (this.audio) this.audio.t0 = this.audio.ctx.currentTime;
    this.syncAnimations();
    this.firstCut = true;
    const gl = e.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { sim: e.liveState.time, gpu: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown' };
  }

  /** wait (real time) for the HD voice lines being generated, so they start at the virtual time they were asked for */
  private async waitVoices() {
    const t0 = realTimers.perfNow();
    let warned = false;
    while (this.audio?.busy) {
      await sleep(5);
      if (!warned && realTimers.perfNow() - t0 > 5000) {
        warned = true;
        const en = hdManager.engine as unknown as { jobs?: { text: string }[]; inflight?: { text: string } | null };
        console.log(`[promo] waiting for voices: ${en?.inflight?.text ?? '-'} + ${en?.jobs?.length ?? 0} queued`);
      }
      if (realTimers.perfNow() - t0 > 60000) throw new Error('HD voice generation stalled');
    }
  }

  private hud(on: boolean) {
    const h = this.e.hud;
    if (!h) return;
    h.root.style.visibility = on ? '' : 'hidden';
  }

  private resolve = (subject: string): { p: V3; facing?: number } | null => {
    const st = this.e.liveState;
    if (subject === 'ball') {
      const b = this.e.ball.worldPos;
      return { p: [b.x, b.y, b.z] };
    }
    if (subject === 'bat') {
      const b = st.bat;
      return b.visible ? { p: [b.pos.x, b.pos.y, b.pos.z] } : null;
    }
    const [kind, who] = subject.includes(':') ? (subject.split(/:(.*)/s) as [string, string]) : ['', subject];
    const find = (w: string) => {
      if (w === 'fielder') {
        const b = st.ball.pos;
        let best = null as (typeof st.players)[number] | null;
        let bd = 1e9;
        for (const p of st.players)
          if (['pitcher', 'catcher', 'first', 'second', 'third', 'short', 'left', 'center', 'right'].includes(p.role)) {
            const dd = Math.hypot(p.pos.x - b.x, p.pos.z - b.z);
            if (dd < bd) (bd = dd), (best = p);
          }
        return best;
      }
      return st.players.find((p) => p.id === w || p.role === w) ?? null;
    };
    const p = find(kind === 'id' ? who : who);
    if (!p) return null;
    if (kind === 'face') {
      const f = this.e.players.faceOf(p.id, this.face);
      if (f) return { p: [f.x, f.y, f.z], facing: p.facing };
      return { p: [p.pos.x, p.pos.y + 1.7, p.pos.z], facing: p.facing };
    }
    if (kind === 'glove') {
      const g = p.gloveTarget;
      return g ? { p: [g.x, g.y, g.z], facing: p.facing } : { p: [p.pos.x, p.pos.y + 1.2, p.pos.z], facing: p.facing };
    }
    return { p: [p.pos.x, p.pos.y, p.pos.z], facing: p.facing };
  };

  private applyCamera(simNow: number) {
    const s = this.shot!;
    if (!this.path) {
      this.e.director.bench = null;
      return;
    }
    const keysIn = (s.camera as { keysIn?: string }).keysIn ?? 'out';
    const t = keysIn === 'sim' ? simNow - s.anchor : this.frameIndex / s.fps;
    const c = this.path.sample(t, 1 / s.fps, this.resolve);
    this.v.pos.set(...c.pos);
    this.v.tgt.set(...c.look);
    this.e.director.bench = { pos: this.v.pos, tgt: this.v.tgt, fov: c.fov, aperture: c.aperture, focus: c.focus, roll: (c.roll * Math.PI) / 180, cut: this.firstCut };
    this.firstCut = false;
  }

  /** CSS transitions / keyframes (cards sliding in, the replay wipe, the clock flash) follow the virtual clock, not the compositor's */
  private syncAnimations() {
    const now = this.clock.now;
    for (const a of document.getAnimations()) {
      if (!this.anims.has(a)) {
        this.anims.set(a, now);
        a.pause();
      }
      a.currentTime = (now - this.anims.get(a)!) * (a.playbackRate || 1);
    }
    if (this.anims.size > 400) for (const [a] of this.anims) if (a.playState === 'finished' || a.playState === 'idle') this.anims.delete(a);
  }

  /** `grab`: the drawn canvas as a JPEG / PNG data URL, read in the same task as the draw (the HUD is not in it: HUD shots use a page screenshot) */
  async frame(grab?: { type: 'image/jpeg' | 'image/png'; quality: number }): Promise<FrameInfo & { image?: string }> {
    const s = this.shot!;
    const e = this.e;
    const dt = 1 / s.fps;
    this.events = [];
    const speed = rampAt(s.ramp, e.liveState.time - s.anchor);
    e.sim.speed = speed;
    this.clock.advance(dt * 1000);
    this.applyCamera(e.liveState.time);
    e.tick(dt, true);
    const image = grab ? e.renderer.domElement.toDataURL(grab.type, grab.quality) : undefined;
    this.syncAnimations();
    if (this.audio) {
      await this.waitVoices();
      await this.audio.to(this.audio.t0 + (this.frameIndex + 1) * dt);
    }
    const d = e.director as unknown as { shot: string; hr?: { stage: string } | null };
    const info: FrameInfo & { image?: string } = { i: this.frameIndex, sim: +e.liveState.time.toFixed(4), speed, shot: d.shot + (d.hr ? '-' + d.hr.stage : ''), replay: d.shot === 'replay', events: this.events, image };
    this.frameIndex++;
    return info;
  }

  async finishAudio() {
    if (!this.audio) return null;
    return this.audio.finish();
  }
}

export function installPromo(e: Engine) {
  const r = new PromoRuntime(e);
  (window as unknown as { __promo: PromoRuntime }).__promo = r;
  return r;
}

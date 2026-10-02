/**
 * Audio layer entry point. `attachAudio(engine, root)` is the only thing `main.ts` calls: it listens to the game's events,
 * turns them into cues (`cues.ts`) and plays them (`mixer.ts`, `ambience.ts`, `organ.ts`, `speech.ts`). It reads the engine
 * through a small structural interface and never writes to it, so the sim and engine are unaffected.
 *
 * Event source: the raw sim event bus when it can be reached (richer: swing/look calls, error kinds, wall contacts, robbed
 * home runs ...), else the engine's reduced GameEvent stream (`?mock`). Never both, or every cue would play twice.
 */
import { CueMapper, PRI, allowedAtSpeed, engineToRaw } from './cues';
import { Mixer, type Settings } from './mixer';
import { Ambience } from './ambience';
import { Organ } from './organ';
import { SpeechQueue, SwitchEngine, browserSpeech } from './speech';
import { HD_MODES, hdSupported, pickMode } from './hdInfo';
import { AudioUi, loadSettings, saveSettings } from './ui';
import { Excitement, baseline } from './excitement';
import { Booth } from './broadcast/booth';
import { BoothSink } from './broadcast/channels';
import { SpeechGate } from './broadcast/gate';
import { ctxFromRaw, type BoothCtx } from './broadcast/ctx';

type Phase = 'prePitch' | 'betweenBatters' | 'break';
import { listenerFromMatrix } from './spatial';
import type { Cue, MapCtx, RawEvent, Vec3 } from './types';

interface PlayerLike {
  id: string;
  team: number;
  role: string;
  name?: string;
  number?: number;
  pos: Vec3;
  vel: Vec3;
  anim: string;
}
interface StateLike {
  players: PlayerLike[];
  ball: { pos: Vec3; vel: Vec3; visible: boolean };
  count: { balls: number; strikes: number };
  outs: number;
  inning: number;
  half: 'top' | 'bottom';
  score: { away: number; home: number };
  runners: [boolean, boolean, boolean];
  teams: { away: { name: string }; home: { name: string } };
}
/** The parts of `Engine` the audio layer reads. */
export interface AudioHost {
  camera: { matrixWorld: { elements: ArrayLike<number> } };
  sim: {
    state: unknown;
    speed: number;
    paused: boolean;
    skipping: boolean;
    game: unknown;
    on(cb: (te: { simTime: number; event: { type: string } & Record<string, unknown> }) => void): unknown;
  };
  director?: { shot: string };
}

interface RawBus {
  on(type: '*', cb: (e: RawEvent) => void): unknown;
  getState?(): Record<string, any>;
}

/** The engine's real-sim adapter exposes the sim's own game as `game` (its full event bus); older engines kept it private as `g`. */
export function rawBusOf(game: unknown): RawBus | null {
  const a = game as { game?: RawBus; g?: RawBus } | null;
  const g = [a?.game, a?.g].find((x): x is RawBus => !!x && typeof x.on === 'function');
  return g ?? null;
}

export interface HdStatus {
  state: 'off' | 'loading' | 'ready' | 'error' | 'unavailable';
  pct?: number;
  text?: string;
  cached?: boolean;
  mb?: number;
}

export interface AudioOptions {
  /** do not create any audio (URL `?noaudio`) */
  off?: boolean;
  /** false: no sound button / panel / "click to enable" prompt (the app's own menu drives `AudioController` instead) */
  ui?: boolean;
}

export interface DebugCue {
  t: number;
  simInning: string;
  kind: string;
  id: string;
  gain?: number;
  delay?: number;
  played: boolean;
  text?: string;
}

const WALL = (x: number, z: number) => {
  const phi = Math.atan2(x, z);
  const a = Math.min(1, Math.abs(phi) / (Math.PI / 4));
  return 100.6 + (121.9 - 100.6) * (1 - a * a);
};

export class AudioController {
  readonly settings: Settings;
  readonly mixer: Mixer;
  readonly ambience: Ambience;
  readonly organ: Organ;
  readonly speech: SpeechQueue;
  /** browser voices, or the optional neural voices when they are downloaded and switched on */
  readonly sw: SwitchEngine;
  /** HD voices state (the neural code is loaded lazily, only after the user opts in) */
  hd: { state: 'off' | 'loading' | 'ready' | 'error'; pct: number; message: string; engine: { stats: unknown; busyMs(): number; rtf: number; dispose(): void } | null } = { state: 'off', pct: 0, message: '', engine: null };
  readonly excitement = new Excitement();
  private ui: AudioUi | null = null;
  private mapper: CueMapper;
  private pending: { ev: RawEvent; at: number }[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private last = performance.now();
  private locked = true;
  private wasReplay = false;
  private wasSkipping = false;
  private lastSpeed = 1;
  private prevBall: { vy: number } | null = null;
  private prevAnim = new Map<string, string>();
  private stepPhase = new Map<string, number>();
  private levelTimer = 0;
  private rawState: Record<string, any> | null = null;
  private raw: RawBus | null;
  /** the broadcast booth (play-by-play + colour, a conversation grounded in the game) and the two independent speech channels */
  readonly booth: Booth;
  private sink: BoothSink;
  readonly gate: SpeechGate;
  private bctx: BoothCtx | null = null;
  private bctxAt = 0;
  private boothWasSuppressed = true;
  private phase: Phase | null = null;
  private lastPlayText = '';
  private offs: (() => void)[] = [];

  readonly debug = {
    cues: [] as DebugCue[],
    mapped: {} as Record<string, number>,
    played: {} as Record<string, number>,
    perHalf: {} as Record<string, Record<string, number>>,
    chat: {} as Record<string, number>,
    energy: [] as { t: number; rms: number; peak: number }[],
    events: 0,
  };

  constructor(private host: AudioHost, root: HTMLElement, withUi = true) {
    this.settings = loadSettings();
    this.mixer = new Mixer(this.settings);
    this.ambience = new Ambience(this.mixer);
    this.organ = new Organ(this.mixer);
    this.sw = new SwitchEngine(browserSpeech());
    // the stadium side (PA announcer, umpire) and the booth are separate channels: with the HD voices they overlap, with browser voices they take turns
    this.gate = new SpeechGate(this.sw);
    this.speech = new SpeechQueue(this.gate.view('field'));
    // browser voices have no PA bus: scale the utterance volume instead (the default slider is about 4-5 dB under the old fixed level)
    this.speech.paScale = () => (this.sw.usingNeural ? 1 : Math.pow(this.settings.paVolume / 0.55, 2) * 0.6);
    this.booth = new Booth({ rng: Math.random, level: this.settings.chatter });
    this.sink = new BoothSink(this.gate.view('booth'), { now: () => performance.now() / 1000, voiceEnded: (v, t) => this.booth.director.voiceEnded(v, t), volume: () => this.speech.volume });
    this.syncSpeech();
    this.raw = rawBusOf(host.sim.game);
    this.mapper = new CueMapper({ detailed: !!this.raw });
    if (this.raw) this.raw.on('*', (e) => this.push(e));
    else host.sim.on((te) => {
      const r = engineToRaw(te.event);
      if (r) this.push(r);
    });
    if (withUi)
      this.ui = new AudioUi(root, this.settings, {
        toggleMute: () => this.toggleMute(),
        changed: () => this.settingsChanged(),
        gesture: () => void this.unlock(),
        enable: () => void this.enable(),
        hdToggle: () => void this.hdToggle(),
        hdRemove: () => void this.removeHd(),
      });
    // any first interaction unlocks audio, except the sound controls themselves (they decide mute state) and the M key
    const gesture = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.cb-snd, .cb-snd-prompt') || (e as KeyboardEvent).key?.toLowerCase?.() === 'm') return;
      void this.unlock();
    };
    for (const t of ['pointerdown', 'keydown', 'touchend'] as const) {
      window.addEventListener(t, gesture, { passive: true });
      this.offs.push(() => window.removeEventListener(t, gesture));
    }
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() === 'm') this.toggleMute();
    };
    window.addEventListener('keydown', key);
    this.offs.push(() => window.removeEventListener('keydown', key));
    this.interval = setInterval(() => this.tick(), 1000 / 30);
    if (this.settings.hd) void this.autoHd();
  }

  // ---- HD (neural) voices: opt-in, lazily imported -------------------------------------------------------------------------

  private async autoHd() {
    if (!hdSupported()) {
      this.settings.hd = false;
      this.persist();
      return;
    }
    try {
      const { isCached } = await import('./neural');
      if (await isCached(pickMode())) await this.enableHd();
      else {
        this.settings.hd = false;
        this.persist();
        this.setHdUi({ state: 'off' });
      }
    } catch {
      this.setHdUi({ state: 'off' });
    }
  }

  hdToggle() {
    return this.hd.state === 'ready' ? this.disableHd() : this.enableHd();
  }

  /** called after the controller itself changes `settings` (HD voices on/off), so the app's copy can follow */
  onSettings: (() => void) | null = null;
  private hdListeners = new Set<(s: HdStatus) => void>();
  private lastHd: HdStatus = { state: 'off' };

  hdStatus(): HdStatus {
    if (!hdSupported() && this.lastHd.state !== 'ready') return { state: 'unavailable', mb: HD_MODES[pickMode()].mb, text: 'HD voices need WebGPU, which this browser does not offer: the CPU version is slower than real time, so it is not offered.' };
    return { ...this.lastHd, mb: HD_MODES[pickMode()].mb };
  }

  subscribeHd(cb: (s: HdStatus) => void): () => void {
    this.hdListeners.add(cb);
    return () => this.hdListeners.delete(cb);
  }

  private setHdUi(s: HdStatus) {
    this.lastHd = s;
    this.ui?.setHd(s.state === 'unavailable' ? { state: 'off' } : (s as Parameters<AudioUi['setHd']>[0]));
    for (const l of this.hdListeners) l(this.hdStatus());
  }

  private persist() {
    saveSettings(this.settings);
    this.onSettings?.();
  }

  async enableHd(): Promise<void> {
    if (this.hd.state === 'loading' || this.hd.state === 'ready' || !hdSupported()) return;
    const mode = pickMode();
    this.hd = { state: 'loading', pct: 0, message: '', engine: null };
    this.setHdUi({ state: 'loading', pct: 0 });
    void this.enable(); // the click is a user gesture: make sure audio is running too
    try {
      const { NeuralSpeechEngine, WorkerSynth } = await import('./neural');
      const engine = new NeuralSpeechEngine(new WorkerSynth(), this.mixer, browserSpeech(), mode);
      this.hd.engine = engine;
      await engine.init(mode, (l, t) => {
        this.hd.pct = t > 0 ? Math.min(99, Math.round((l / t) * 100)) : 0;
        this.setHdUi({ state: 'loading', pct: this.hd.pct });
      });
      this.sw.neural = engine;
      this.hd.state = 'ready';
      this.settings.hd = true;
      this.persist();
      this.setHdUi({ state: 'ready', text: `Kokoro HD voices on (${HD_MODES[mode].device}). Lines that cannot be generated in time use the browser voice.` });
    } catch (e) {
      this.hd.engine?.dispose();
      this.hd = { state: 'error', pct: 0, message: String((e as Error)?.message ?? e), engine: null };
      this.sw.neural = null;
      this.settings.hd = false;
      this.persist();
      this.setHdUi({ state: 'error', text: `HD voices could not start (${this.hd.message}). Using the browser voices.` });
    }
  }

  disableHd() {
    this.speech.clear();
    this.sw.neural = null;
    this.hd.engine?.dispose();
    this.hd = { state: 'off', pct: 0, message: '', engine: null };
    this.settings.hd = false;
    this.persist();
    void import('./neural').then(({ isCached }) => isCached(pickMode())).then((cached) => this.setHdUi({ state: 'off', cached }));
  }

  async removeHd() {
    this.disableHd();
    const { clearCache } = await import('./neural');
    await clearCache();
    this.setHdUi({ state: 'off', cached: false });
  }

  // ---- settings / unlock ---------------------------------------------------------------------------------------------

  async unlock(): Promise<boolean> {
    if (!this.locked) return true;
    const ok = await this.mixer.unlock();
    if (ok) {
      this.locked = false;
      this.ui?.setLocked(false);
      this.mixer.applySettings();
      this.syncSpeech();
    }
    return ok;
  }

  /** An explicit request for sound (prompt, 🔊, M while locked): unlock and make sure it is not muted. */
  async enable(): Promise<boolean> {
    if (this.settings.muted) {
      this.settings.muted = false;
      this.settingsChanged();
    }
    return this.unlock();
  }

  toggleMute() {
    if (this.locked) {
      void this.enable();
      return;
    }
    this.settings.muted = !this.settings.muted;
    this.settingsChanged();
  }

  /** true until the browser has let the AudioContext run (needs a click / key press) */
  get isLocked() {
    return this.locked;
  }

  /** Apply and save `settings` after a change made from outside (the app's menu). */
  settingsChanged() {
    saveSettings(this.settings);
    this.mixer.applySettings();
    this.syncSpeech();
    this.ui?.refresh();
  }

  private syncSpeech() {
    const s = this.settings;
    const wasOn = { ...this.speech.enabled };
    this.speech.enabled = { pa: s.pa && !s.muted, ump: s.pa && !s.muted, pbp: s.commentary && !s.muted, color: s.commentary && !s.muted };
    this.speech.volume = Math.min(1, s.announcer * s.master * 1.3);
    const off = (Object.keys(wasOn) as (keyof typeof wasOn)[]).filter((k) => wasOn[k] && !this.speech.enabled[k]);
    if (off.length) this.speech.clearRoles(off);
  }

  // ---- events --------------------------------------------------------------------------------------------------------

  /** where the booth is in the game flow: when a filler line fits (never during a pitch) */
  private trackPhase(ev: RawEvent) {
    switch (ev.type) {
      case 'halfInningEnd':
        this.phase = 'break';
        break;
      case 'gameStart':
      case 'plateAppearanceEnd':
      case 'playEnd':
        this.phase = this.phase === 'break' ? 'break' : 'betweenBatters';
        break;
      case 'batterUp':
      case 'ballReturn':
      case 'call':
      case 'umpireCall':
        if (this.phase !== 'break' || ev.type === 'batterUp') this.phase = 'prePitch';
        break;
      case 'windup':
      case 'pitchReleased':
      case 'contact':
        this.phase = null;
        break;
      default:
        break;
    }
    if (ev.type === 'playEnd') this.lastPlayText = String(ev.description ?? '');
  }

  /** Ballparks play organ in the gaps, never during a pitch: a soft bed in breaks, cut when the pitcher starts his windup. */
  private organDirector(ev: RawEvent) {
    switch (ev.type) {
      case 'halfInningEnd':
        this.bedWanted = true;
        break;
      case 'plateAppearanceEnd': {
        const st = this.host.sim.state as { inning?: number; half?: string } | undefined;
        const idx = ((st?.inning ?? 1) - 1) * 2 + (st?.half === 'bottom' ? 1 : 0);
        if (idx % 3 === 0) this.bedWanted = true; // a continuous organ bed between batters in every third half inning
        break;
      }
      case 'windup':
      case 'pitchReleased': {
        this.bedWanted = false;
        const cur = this.organ.playing;
        if (cur && cur !== 'stretch' && cur !== 'hr_fanfare' && cur !== 'rally') this.organ.stop(0.5);
        break;
      }
      default:
        break;
    }
  }


  /** organ bed wanted: during the break between half innings, and between batters in some half innings */
  private bedWanted = false;

  private push(ev: RawEvent) {
    this.debug.events++;
    if (this.host.sim.skipping) return;
    this.organDirector(ev);
    this.trackPhase(ev);
    this.pending.push({ ev, at: performance.now() });
    if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
  }

  private state(): StateLike {
    return this.host.sim.state as StateLike;
  }

  private buildCtx(st: StateLike): MapCtx {
    const byId = new Map<string, PlayerLike>();
    for (const p of st.players) byId.set(p.id, p);
    this.rawState = null;
    const rs = () => (this.rawState ??= (this.raw?.getState?.() ?? null));
    return {
      pos: (id) => {
        const p = byId.get(String(id));
        return p ? { x: p.pos.x, y: Math.max(0.3, p.pos.y + 1), z: p.pos.z } : undefined;
      },
      person: (id) => {
        const p = byId.get(String(id));
        return p ? { name: p.name ?? 'The player', number: p.number, team: p.team, role: p.role } : undefined;
      },
      inning: st.inning,
      half: st.half,
      outs: st.outs,
      balls: st.count.balls,
      strikes: st.count.strikes,
      score: { home: st.score.home, away: st.score.away },
      runners: st.runners,
      teams: { home: st.teams.home.name, away: st.teams.away.name },
      catcher: (() => {
        const c = st.players.find((p) => p.role === 'catcher');
        return c ? { x: c.pos.x, y: 0.9, z: c.pos.z - 0.6 } : undefined;
      })(),
      speed: this.host.sim.speed,
      batterLine: (id) => {
        const s = rs();
        return s?.batter && s.batter.info?.id === id ? s.batter.line : undefined;
      },
      pitcherLine: (id) => {
        const s = rs();
        return s?.pitcher && (!id || s.pitcher.info?.id === id) ? { ...s.pitcher.line, pitchCount: s.pitcher.pitchCount } : undefined;
      },
    };
  }

  /** the booth's view of the game: rebuilt from the sim state (at most every 250 ms unless an event just happened) */
  private boothCtx(force = false): BoothCtx | null {
    const now = performance.now();
    if (!force && this.bctx && now - this.bctxAt < 250) return this.bctx;
    const rs = this.raw?.getState?.();
    if (!rs) return null;
    this.bctx = ctxFromRaw(rs, { crowd: this.excitement.level, lastPlay: this.lastPlayText });
    this.bctxAt = now;
    return this.bctx;
  }

  private dispatch(c: Cue, st: StateLike, simSpeed: number) {
    const key = `${st.inning}${st.half === 'top' ? 't' : 'b'}`;
    const id = c.kind === 'speak' ? c.role : c.kind === 'excite' ? 'excite' : c.id;
    const tag = `${c.kind}:${id}`;
    this.debug.mapped[tag] = (this.debug.mapped[tag] ?? 0) + 1;
    const h = (this.debug.perHalf[key] ??= {});
    h[tag] = (h[tag] ?? 0) + 1;
    let played = false;
    const speech = c.kind === 'speak';
    const gated = !allowedAtSpeed(c.imp, simSpeed, this.host.sim.skipping) || (speech && simSpeed > 1.01) || (c.kind === 'organ' && simSpeed > 2.01);
    if (!gated) {
      const run = () => {
        played = this.play(c);
        this.record(c, key, played);
      };
      if ((c.kind === 'organ' || c.kind === 'excite' || c.kind === 'speak') && (c.delay ?? 0) > 0) {
        const t = setTimeout(() => {
          this.timers.delete(t);
          run();
        }, (c.delay ?? 0) * 1000);
        this.timers.add(t);
        return;
      }
      run();
      return;
    }
    this.record(c, key, false);
  }

  private record(c: Cue, key: string, played: boolean) {
    const id = c.kind === 'speak' ? c.role : c.kind === 'excite' ? 'excite' : c.id;
    if (played) {
      const tag = `${c.kind}:${id}`;
      this.debug.played[tag] = (this.debug.played[tag] ?? 0) + 1;
    }
    if (id !== 'footstep') this.debug.cues.push({ t: Math.round(performance.now()), simInning: key, kind: c.kind, id, gain: 'gain' in c ? c.gain : undefined, delay: 'delay' in c ? c.delay : undefined, played, text: c.kind === 'speak' ? c.text : undefined });
    if (this.debug.cues.length > 300) this.debug.cues.shift();
  }

  private play(c: Cue): boolean {
    const m = this.mixer;
    switch (c.kind) {
      case 'sfx':
        return m.playSfx(c);
      case 'crowd':
        return m.playCrowd(c.id, c.gain ?? 1, c.delay ?? 0);
      case 'excite':
        this.excitement.add(c.amount, c.hold);
        return true;
      case 'organ':
        return this.settings.muted || !this.settings.organ ? false : this.organ.play(c.id, c.gain ?? 1, 0);
      case 'speak': {
        if (this.locked || this.settings.muted) return false;
        if (!this.speech.enabled[c.role]) return false;
        if (!this.speech.available()) {
          // no voices in this browser: the umpire still gets a shout so the call is audible
          if (c.role === 'ump') return m.playSfx({ kind: 'sfx', id: 'ump_yell', gain: 0.7, imp: 2, pos: c.pos ? { x: c.pos.x, y: 1.7, z: c.pos.z } : undefined });
          return false;
        }
        this.speech.enqueue({ role: c.role, text: c.text, pri: c.pri, ttl: c.ttl });
        return true;
      }
    }
  }

  // ---- per-tick ------------------------------------------------------------------------------------------------------

  private tick() {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const sim = this.host.sim;
    const st = this.state();
    if (!st || !st.players) return;
    try {
      this.mixer.setListener(listenerFromMatrix(this.host.camera.matrixWorld.elements));
      // modes: pause, slow-motion replay, speed, fast-forward
      const replay = this.host.director?.shot === 'replay';
      if (replay !== this.wasReplay) {
        if (replay) {
          this.mixer.playSfx({ kind: 'sfx', id: 'replay_whoosh', gain: 0.5, imp: 1 });
          const cc = this.raw ? this.boothCtx(true) : null;
          if (cc) this.booth.replay(cc, performance.now() / 1000);
        }
        this.wasReplay = replay;
      }
      if (replay !== this.mixer.replay || sim.paused !== this.mixer.paused) this.mixer.setMode({ replay, paused: sim.paused });
      this.speech.setPaused(sim.paused);
      if (sim.skipping && !this.wasSkipping) {
        this.pending.length = 0;
        this.speech.clear();
        this.sink.stopAll();
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
      }
      this.wasSkipping = sim.skipping;
      // the organ: silent while paused / muted / skipping, a soft bed in the gaps, and the booth waits out the seventh-inning stretch
      if ((sim.paused || sim.skipping || this.settings.muted || !this.settings.organ || this.locked) && this.organ.playing) this.organ.stop(0.25);
      if (sim.skipping) this.bedWanted = false;
      const speaking = this.gate.busy.field + this.gate.busy.booth > 0;
      if (speaking !== this.mixer.speaking) this.mixer.setMode({ speaking });
      // PA and booth sit under each other (about -5 dB for the PA while the booth talks, -2 dB for the booth under the PA): neither is muted
      if (this.gate.concurrent) this.mixer.setVoiceDuck(this.gate.busy.booth > 0 ? 0.56 : 1, this.gate.busy.field > 0 ? 0.79 : 1);
      if (this.bedWanted && !sim.paused && !sim.skipping && sim.speed <= 1.01 && !this.settings.muted && this.settings.organ && !this.locked && this.organ.playing === null && !speaking) this.organ.play('bed', 0.9);
      const stretch = this.organ.playing === 'stretch';
      if (sim.speed > 1.01 && this.lastSpeed <= 1.01) this.speech.clear();
      this.lastSpeed = sim.speed;

      // events since the last tick (the state is current now, so names and positions are too)
      if (this.pending.length) {
        const ctx = this.buildCtx(st);
        const batch = this.pending;
        this.pending = [];
        const cc = this.raw ? this.boothCtx(true) : null;
        for (const { ev, at } of batch) {
          // a new batter may not be on the field yet: wait a moment for the name
          if (ev.type === 'batterUp' && !ctx.person(ev.batterId) && now - at < 1500) {
            this.pending.push({ ev, at });
            continue;
          }
          for (const c of this.mapper.map(ev, ctx)) this.dispatch(c, st, sim.speed);
          if (cc && !sim.skipping) this.booth.observe(ev, cc, performance.now() / 1000);
        }
      }

      if (!this.locked && !sim.paused && !sim.skipping && !replay) this.frameCues(st, sim.speed);

      // crowd
      if (!this.locked) {
        if (!this.ambience.started) this.ambience.start();
        this.excitement.setBaseline(baseline({ inning: st.inning, outs: st.outs, balls: st.count.balls, strikes: st.count.strikes, score: st.score, runners: st.runners }) * (sim.paused ? 0.6 : 1));
        this.ambience.update(this.excitement.update(dt), dt);
        this.levelTimer += dt;
        if (this.levelTimer > 0.1) {
          this.levelTimer = 0;
          const l = this.mixer.level();
          this.debug.energy.push({ t: Math.round(now), rms: +l.rms.toFixed(4), peak: +l.peak.toFixed(3) });
          if (this.debug.energy.length > 600) this.debug.energy.shift();
        }
      }
      // the booth: its director decides who speaks when; it is silent at 2x and above, while skipping, paused, muted or switched off, and during the stretch
      {
        const suppressed = sim.speed > 1.01 || sim.skipping || sim.paused || this.locked || this.settings.muted || !this.settings.commentary || this.organ.playing === 'stretch' || !this.raw;
        if (suppressed && !this.boothWasSuppressed) this.sink.stopAll();
        this.boothWasSuppressed = suppressed;
        const cc = this.raw ? this.boothCtx() : null;
        if (cc) {
          this.booth.setLevel(this.settings.chatter);
          this.booth.canTalk = this.phase !== null;
          this.sink.apply(this.booth.tick(now / 1000, cc, { suppressed }));
        }
      }
      this.speech.pump();
    } catch (e) {
      // audio must never break the game; report once in the console
      if (!(this as { warned?: boolean }).warned) {
        (this as { warned?: boolean }).warned = true;
        console.warn('[audio] tick failed', e);
      }
    }
  }

  /** Sounds with no sim event of their own, derived from the snapshot: bounces, slides, cleats. */
  private frameCues(st: StateLike, speed: number) {
    const b = st.ball;
    if (b.visible) {
      const vy = b.vel.y;
      const r = Math.hypot(b.pos.x, b.pos.z);
      if (this.prevBall && this.prevBall.vy < -1.5 && vy > 0.4 && b.pos.y < 0.6 && r < WALL(b.pos.x, b.pos.z) + 1) {
        const dirt = r < 18 || r > WALL(b.pos.x, b.pos.z) - 5;
        const g = 0.25 + 0.55 * Math.min(1, -this.prevBall.vy / 16);
        this.dispatch({ kind: 'sfx', id: dirt ? 'dirt_thud' : 'ground_bounce', pos: { x: b.pos.x, y: 0.1, z: b.pos.z }, gain: g, imp: 1 }, st, speed);
      }
      this.prevBall = { vy };
    } else this.prevBall = null;
    const cam = this.mixer.listener.pos;
    let steps = 0;
    for (const p of st.players) {
      const was = this.prevAnim.get(p.id);
      if (p.anim === 'slide' && was !== 'slide') this.dispatch({ kind: 'sfx', id: 'slide_scuff', pos: { x: p.pos.x, y: 0.2, z: p.pos.z }, gain: 0.55, imp: 1 }, st, speed);
      this.prevAnim.set(p.id, p.anim);
      const v = Math.hypot(p.vel.x, p.vel.z);
      if (speed <= 1.01 && v > 2.5 && steps < 3 && p.role !== 'umpire' && (p.anim === 'run' || p.anim === 'trot' || p.anim === 'run_turn')) {
        const d = Math.hypot(p.pos.x - cam.x, p.pos.z - cam.z);
        if (d < 40) {
          const ph = (this.stepPhase.get(p.id) ?? 0) + (v * 0.4) / 30; // ~one stride per (2.5 m / v) s at 30 Hz
          if (ph >= 1) {
            this.stepPhase.set(p.id, 0);
            steps++;
            this.dispatch({ kind: 'sfx', id: 'footstep', pos: { x: p.pos.x, y: 0.05, z: p.pos.z }, gain: 0.1 + 0.02 * Math.min(8, v), imp: 0 }, st, speed);
          } else this.stepPhase.set(p.id, ph);
        }
      }
    }
  }

  get phaseNow() {
    return this.phase;
  }

  dispose() {
    if (this.interval) clearInterval(this.interval);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const o of this.offs) o();
    this.speech.clear();
    this.ambience.stop();
    this.organ.stop();
    this.mixer.dispose();
    this.ui?.dispose();
  }
}

/** Attach sound to a running engine. Returns null (and does nothing) with `?noaudio`. */
export function attachAudio(host: AudioHost, root: HTMLElement, opts: AudioOptions = {}): AudioController | null {
  if (opts.off) return null;
  try {
    const a = new AudioController(host, root, opts.ui !== false);
    const dbg = {
      get cues() { return a.debug.cues; },
      get mapped() { return a.debug.mapped; },
      get played() { return a.debug.played; },
      get perHalf() { return a.debug.perHalf; },
      get energy() { return a.debug.energy; },
      get events() { return a.debug.events; },
      get state() { return { ctx: a.mixer.state, ready: a.mixer.ready, prepared: `${a.mixer.prepared}/${a.mixer.totalToPrepare}`, muted: a.settings.muted, voices: a.mixer.voiceCount, dropped: a.mixer.droppedVoices, level: a.excitement.level, ambience: a.ambience.gains, speech: { ...a.speech.stats, available: a.speech.available(), pending: a.speech.pending, hd: a.hd.state, hdStats: a.hd.engine?.stats }, chat: a.debug.chat, booth: { director: a.booth.director.stats, transcript: a.booth.transcript.slice(-12), field: a.gate.busy, gate: a.gate.stats, concurrent: a.gate.concurrent }, phase: a.phaseNow, idleMs: Math.round(a.speech.idleMs()), organ: a.organ.started, samples: a.mixer.samples, sfxPlayed: a.mixer.played }; },
      get speechLog() { return a.speech.log; },
      level: () => a.mixer.level(),
      controller: a,
    };
    (window as unknown as { __audioDebug: unknown }).__audioDebug = dbg;
    return a;
  } catch (e) {
    console.warn('[audio] disabled:', e);
    return null;
  }
}

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
import { hdManager, type HdStatus } from './hd';
import { hdSupported } from './hdInfo';
import { voiceManager } from './voiceManager';
import { loadVoiceSettings } from './voice/controller';
export type { HdStatus };
import { AudioUi, loadSettings, saveSettings } from './ui';
import { CrowdModel, type CrowdCtx, type CrowdShot } from './crowd';
import { isLowPower } from './perf';
import { ParkMusic, WebAudioMusic } from './park/player';
import { TRIGGERS, TRIGGER_IDS, type Trigger } from './park/manifest';
import { BroadcastFx, FX_EVENT_TYPES, type CameraEvent, type FxPlan } from './broadcastfx';
import { Booth } from './broadcast/booth';
import { BoothSink } from './broadcast/channels';
import { SpeechGate } from './broadcast/gate';
import type { SpeechEvent } from './captions';
export type { SpeechEvent, SpeechStartEvent, SpeechEndEvent, SpeechChannel, SpeechSpeaker } from './captions';
import { ctxFromRaw, type BoothCtx } from './broadcast/ctx';
import { factsFromGame } from './broadcast/facts';
import { CAST, speakerLabel, speakerName } from './broadcast/cast';
import { estimateDuration } from './broadcast/text';
import { paWelcome } from './cues';
import { teamInfo } from '../engine/realSimAdapter';

type Phase = 'prePitch' | 'betweenBatters' | 'break';
import { BASES } from './venue/mics';
import { surfaceAt, surfaceBounce, surfaceStep } from './field';
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
  /** the sky the renderer shows (the opening's weather follows it) */
  env?: { todName?: string; hdriActive?: boolean };
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

/** the park-music triggers an organ stinger stands in for */
const ORGAN_TRIGGERS: Record<string, Trigger[]> = { hr_fanfare: ['homeRun', 'finalWin'], walk_up: ['walkUp'], charge: ['runScored', 'rally'], rally: ['rally', 'runScored'], ditty: ['gameStart', 'inningBreak'], dirge: ['finalLoss'] };

/** events the crowd still reacts to at 2x-4x (everything else only at normal speed) */
const MAJOR = new Set(['homeRun', 'runScored', 'robbedHomeRun', 'gameEnd', 'gameStart']);

const crowdCtx = (st: StateLike): CrowdCtx => ({ inning: st.inning, half: st.half, outs: st.outs, balls: st.count.balls, strikes: st.count.strikes, score: { home: st.score.home, away: st.score.away }, runners: st.runners });

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
  /** the crowd: reaction model (pure) + the three-loop bed; `excitement` is its smoothed 0..1 level, for the speech delivery */
  readonly crowd: CrowdModel;
  get excitement(): { level: number } {
    return this.crowd;
  }
  /** phone-class device: lighter everywhere (slower tick, fewer crowd voices and incidental sounds, no footsteps) */
  readonly lowPower = isLowPower();
  private crowdAcc = 0;
  /** park music: optional tracks from `public/audio/music/`, the organ stingers otherwise */
  readonly music: ParkMusic;
  private musicTestList: string[] = [];
  /** camera / graphics stings (broadcastfx.ts) */
  readonly fx = new BroadcastFx();
  private lastShot = '';
  /** "My voice (custom announcer)": the owner's own trained voice, opt-in (see voice/); the manager outlives games */
  get voice() {
    return voiceManager.controller;
  }
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
  private prevBall: { vy: number; vz: number } | null = null;
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
  private debugPanel: { dispose(): void } | null = null;

  readonly debug = {
    cues: [] as DebugCue[],
    mapped: {} as Record<string, number>,
    played: {} as Record<string, number>,
    perHalf: {} as Record<string, Record<string, number>>,
    chat: {} as Record<string, number>,
    energy: [] as { t: number; rms: number; peak: number }[],
    events: 0,
    /** moving average of the time one tick takes, ms (the cost of the audio layer on the main thread) */
    tickMs: 0,
  };

  constructor(private host: AudioHost, root: HTMLElement, withUi = true) {
    this.settings = loadSettings();
    this.mixer = new Mixer(this.settings);
    this.mixer.lowPower = this.lowPower;
    let audioDebug = false;
    try {
      audioDebug = new URLSearchParams(location.search).get('audiodebug') === '1';
    } catch {
      /* no location */
    }
    // ?audiodebug=1: level meters on every mic strip and a live panel (meters, duck, zones, venue)
    this.mixer.meters = audioDebug;
    this.music = new ParkMusic({
      backend: new WebAudioMusic(this.mixer),
      base: `${import.meta.env?.BASE_URL ?? '/'}audio/music/`,
      lowPower: this.lowPower,
      onFallback: (trig) => this.musicFallback(trig),
    });
    void this.music.load();
    try {
      const q = new URLSearchParams(location.search).get('musictest');
      if (q) this.musicTestList = q === 'all' ? TRIGGER_IDS.flatMap((t) => Array(TRIGGERS[t].variants).fill(t)) : q.split(',').filter((t): t is Trigger => t in TRIGGERS);
    } catch {
      /* no location */
    }
    this.crowd = new CrowdModel({ rng: Math.random, lowPower: this.lowPower });
    this.ambience = new Ambience(this.mixer);
    if (audioDebug) void import('./debugPanel').then((d) => (this.debugPanel = new d.AudioDebugPanel(this.mixer, this.ambience, root)));
    this.organ = new Organ(this.mixer);
    this.sw = new SwitchEngine(browserSpeech());
    // the stadium side (PA announcer, umpire) and the booth are separate channels: with the HD voices they overlap, with browser voices they take turns
    this.gate = new SpeechGate(this.sw, undefined, () => this.clockMs());
    this.speech = new SpeechQueue(this.gate.view('field'));
    // browser voices have no PA bus: scale the utterance volume instead (the default slider is about 4-5 dB under the old fixed level)
    this.speech.paScale = () => (this.sw.usingNeural ? 1 : Math.pow(this.settings.paVolume / 0.55, 2) * 0.6);
    this.booth = new Booth({ rng: Math.random, level: this.settings.chatter });
    // EXPERIMENT (off by default, URL flag only): a tiny in-browser language model for colour lines, validated; see src/audio/README.md
    if (new URLSearchParams(location.search).get('lm') === '1' && hdSupported()) void import('./broadcast/lmClient').then((m) => m.startLm()).then((lm) => (this.booth.lm = lm)).catch(() => {});
    this.sink = new BoothSink(this.gate.view('booth'), { now: () => performance.now() / 1000, voiceEnded: (v, t) => this.booth.director.voiceEnded(v, t), volume: () => this.speech.volume });
    this.syncSpeech();
    this.raw = rawBusOf(host.sim.game);
    this.mapper = new CueMapper({ detailed: !!this.raw, crowdCues: false }); // the crowd model makes the crowd sounds
    this.initFacts();
    // the engine's camera / graphics events come through the engine's own stream, whichever source the game events use
    host.sim.on((te) => {
      if (FX_EVENT_TYPES.has(te.event.type)) this.cameraEvent(te.event as CameraEvent);
    });
    if (this.raw) this.raw.on('*', (e) => this.push(e));
    else host.sim.on((te) => {
      const r = engineToRaw(te.event);
      if (r) this.push(r);
    });
    if (withUi)
      this.ui = new AudioUi(root, this.settings, {
        voice: {
          initialUrl: loadVoiceSettings().url,
          url: (u) => void this.beforeVoice().then(() => this.voice.enableFromUrl(u)),
          files: (f) => void this.beforeVoice().then(() => this.voice.enableFromFiles(f)),
          off: () => this.voice.disable(),
          forget: () => void this.voice.forget(),
        },
        toggleMute: () => this.toggleMute(),
        changed: () => this.settingsChanged(),
        gesture: () => void this.unlock(),
        enable: () => void this.enable(),
        hdToggle: () => void this.hdToggle(),
        hdRemove: () => void this.removeHd(),
        hdPreview: () => void hdManager.preview(),
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
    // the HD and custom-voice managers outlive games; this game plays through its mixer and follows whichever engine is on
    hdManager.bindMixer(this.mixer);
    voiceManager.bindMixer(this.mixer, () => this.excitement.level);
    const follow = () => {
      this.sw.neural = voiceManager.engine ?? hdManager.engine;
      this.speech.clear();
      this.sink.stopAll();
      this.settings.hd = !!hdManager.engine;
      this.onSettings?.();
    };
    this.sw.neural = voiceManager.engine ?? hdManager.engine;
    hdManager.onEngine = follow;
    voiceManager.onEngine = follow;
    this.offs.push(hdManager.subscribe((st) => this.ui?.setHd(st.state === 'unavailable' ? { state: 'off', text: st.text } : (st as Parameters<AudioUi['setHd']>[0]))));
    this.offs.push(voiceManager.subscribe((s) => this.ui?.voicePanel?.set(s)));
    this.ui?.setHd(hdManager.status().state === 'unavailable' ? { state: 'off' } : (hdManager.status() as Parameters<AudioUi['setHd']>[0]));
    this.ui?.voicePanel?.set(voiceManager.status());
    this.interval = setInterval(() => this.tick(), this.lowPower ? 1000 / 15 : 1000 / 30);
  }

  /** the game's who-and-where for the booth's opening and the PA's welcome (from the sim's teams and `game.info`, and the renderer's sky) */
  private venueName: string | undefined;
  private todName(): 'day' | 'dusk' | 'night' {
    const t = this.host.env?.todName;
    return t === 'dusk' || t === 'night' ? t : 'day';
  }
  private initFacts() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const game = (this.host.sim.game as any)?.game ?? null;
      if (!game || !this.raw) return;
      const tod = this.todName();
      const teams = game.getTeams?.();
      const colors = (side: 'home' | 'away') => (teams?.[side] ? teamInfo({ name: teams[side].name, abbrev: teams[side].abbrev }, side === 'home' ? 1 : 0) : undefined);
      const seed = String(game._world?.cfg?.seed ?? `${teams?.away?.abbrev}-${teams?.home?.abbrev}`);
      const f = factsFromGame(game, seed, tod, tod === 'day' && !!this.host.env?.hdriActive, colors);
      if (!f) return;
      this.venueName = f.venue?.name;
      // the PA's welcome (0.5 s after gameStart, about 8 % slower than the estimate) plays first
      const pa = paWelcome({ teams: { home: f.home.name, away: f.away.name }, venue: this.venueName, tod });
      this.booth.setFacts(f, 0.5 + estimateDuration(pa, 0.92) + 0.8);
    } catch (e) {
      console.warn('[audio] no opening facts', e);
    }
  }

  /** The cast (names, roles, voices) and the caption label / display name of a speaker role ('pbp' -> 'LYLE' / 'Lyle Pemberton'). */
  readonly cast = CAST;
  speakerLabel(speaker: string): string | undefined {
    return speakerLabel(speaker);
  }
  speakerName(speaker: string): string | undefined {
    return speakerName(speaker);
  }

  // ---- HD (neural) voices: the manager (`hd.ts`) owns the download and the engine; a game only plugs its mixer in -------------

  /** called after the controller itself changes `settings`, so the app's copy can follow */
  onSettings: (() => void) | null = null;

  /** the click that starts the custom voice is a user gesture: make sure audio is running too */
  private async beforeVoice() {
    await this.enable();
  }

  voiceStatus() {
    return voiceManager.status();
  }
  subscribeVoice(cb: Parameters<typeof voiceManager.subscribe>[0]) {
    return voiceManager.subscribe(cb);
  }

  get hd() {
    return { state: hdManager.state === 'unavailable' ? 'off' : hdManager.state, pct: hdManager.pct, message: hdManager.message, engine: hdManager.engine };
  }
  hdStatus(): HdStatus {
    return hdManager.status();
  }
  subscribeHd(cb: (s: HdStatus) => void): () => void {
    return hdManager.subscribe(cb);
  }
  hdToggle() {
    void this.enable(); // the click is a user gesture: make sure audio is running too
    return hdManager.toggle();
  }
  enableHd() {
    return hdManager.enable();
  }
  disableHd() {
    return hdManager.disable();
  }
  removeHd() {
    return hdManager.remove();
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
      if (this.musicTestList.length) this.runMusicTest();
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

  // ---- captions API (for the UI) ---------------------------------------------------------------------------------------------

  /**
   * Subscribe to what the booth, the PA and the umpire say (captions). `speechStart` is sent when a line really starts to sound,
   * with the exact text given to the voice; `speechEnd` when it ends, with `truncatedAt` (characters spoken) for a line that was cut
   * or cancelled. Lines that never sound (dropped, muted) produce no events. Returns the unsubscribe function. See captions.ts.
   */
  onSpeech(cb: (e: SpeechEvent) => void): () => void {
    return this.gate.onSpeech(cb);
  }
  /** the lines sounding right now (a caption UI that subscribes late, or after a pause) */
  speakingNow() {
    return this.gate.speakingNow();
  }
  /** the clock of `startMs` / `endMs` in speech events, in ms: the AudioContext time (performance.now() before audio exists) */
  clockMs(): number {
    const c = this.mixer.ctx;
    return c ? c.currentTime * 1000 : performance.now();
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

  /** the engine's camera and graphics events (`cameraCut`, `replayStart`, `replayEnd`, `graphicShown`): they also arrive through the event streams */
  cameraEvent(ev: CameraEvent) {
    if (!FX_EVENT_TYPES.has(ev.type)) return;
    this.playFx(this.fx.event(ev, performance.now() / 1000));
  }

  private playFx(p: FxPlan | null) {
    const sim = this.host.sim;
    if (!p || this.locked || this.settings.muted || sim.paused || sim.skipping || sim.speed > 2.01 || this.settings.fxVolume <= 0.01) return;
    this.mixer.playSfx({ kind: 'sfx', id: p.id, gain: p.gain, imp: 1 });
  }

  private push(ev: RawEvent) {
    this.debug.events++;
    if (FX_EVENT_TYPES.has(ev.type)) {
      this.cameraEvent(ev as CameraEvent);
      return;
    }
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
      venue: this.venueName,
      tod: this.todName(),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.bctx = ctxFromRaw(rs, { crowd: this.excitement.level, lastPlay: this.lastPlayText, game: (this.host.sim.game as any)?.game });
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
        return true; // the crowd model (crowd.ts) owns the crowd; the mapper's excite cues are switched off in the running game
      case 'organ': {
        if (this.settings.muted || !this.settings.organ) return false;
        // park music (a file) takes the moment; the organ stinger is the fallback when there is none, and never plays over a track
        if (c.id !== 'stretch' && (this.music.active || this.music.covered(ORGAN_TRIGGERS[c.id] ?? [], performance.now() / 1000, 4))) return false;
        return this.organ.play(c.id, c.gain ?? 1, 0);
      }
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
    try {
      this.tickInner(now);
    } finally {
      this.debug.tickMs += (performance.now() - now - this.debug.tickMs) * 0.05;
    }
  }

  private tickInner(now: number) {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const sim = this.host.sim;
    const st = this.state();
    if (!st || !st.players) return;
    try {
      // modes: pause, slow-motion replay, speed, fast-forward
      const replay = this.host.director?.shot === 'replay';
      const shotName = this.host.director?.shot ?? '';
      if (shotName !== this.lastShot) {
        this.lastShot = shotName;
        this.playFx(this.fx.shot(shotName, now / 1000));
      }
      if (replay !== this.wasReplay) {
        if (replay) {
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
      // the park (PA included) ducks under the booth through the sidechain: keyed by the booth's real signal when the voices play
      // through Web Audio, by the gate's flag for browser speech; the booth sits about 2 dB under the PA announcer
      this.mixer.setVoices({ pa: this.gate.busy.field > 0, booth: this.gate.busy.booth > 0, routed: this.sw.usingNeural });
      if (this.gate.concurrent) this.mixer.setVoiceDuck(1, this.gate.busy.field > 0 ? 0.79 : 1);
      if (this.bedWanted && !this.music.active && !sim.paused && !sim.skipping && sim.speed <= 1.01 && !this.settings.muted && this.settings.organ && !this.locked && this.organ.playing === null && !speaking) this.organ.play('bed', 0.9);
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
          if (!this.locked && (sim.speed <= 2.01 || MAJOR.has(ev.type))) this.crowd.observe(ev, crowdCtx(st));
          if (!this.locked && sim.speed <= 1.01 && !sim.skipping) this.music.observe(ev, { inning: st.inning, half: st.half, score: st.score }, now / 1000);
          if (cc && !sim.skipping) this.booth.observe(ev, cc, performance.now() / 1000);
        }
      }

      if (!this.locked && !sim.paused && !sim.skipping && !replay) this.frameCues(st, sim.speed);

      // crowd: the reaction model advances ~10 times a second (5 on a phone), the bed loops follow it, its one-shots play on the audio clock
      if (!this.locked) {
        if (!this.ambience.started) this.ambience.start();
        this.crowdAcc += dt;
        if (this.crowdAcc >= (this.lowPower ? 0.2 : 0.1)) {
          const step = this.crowdAcc;
          this.crowdAcc = 0;
          this.crowd.setContext(crowdCtx(st));
          const bed = this.crowd.update(step, !sim.paused && sim.speed <= 1.51 && !this.settings.muted);
          this.ambience.apply(sim.paused ? { ...bed, murmur: bed.murmur * 0.6, roar: bed.roar * 0.6, clap: bed.clap * 0.5 } : bed);
          this.mixer.setCrowdEnergy(this.crowd.energy);
          // park music: silent while paused / skipping / fast / muted / off / the stretch; under the booth and the PA, and under big crowd moments
          const musicOff = sim.paused || sim.skipping || sim.speed > 1.01 || this.settings.muted || !this.settings.music || this.organ.playing === 'stretch';
          this.music.tick(now / 1000, musicOff);
          // (the booth's duck is the sidechain's; the PA announcer and the music share the PA, the music sits under it)
          const speech = this.gate.busy.field > 0 ? 0.62 : 1;
          this.mixer.setMusicDuck(speech * (1 - 0.4 * Math.min(1, Math.max(0, (this.crowd.energy - 0.5) / 0.5))));
          for (const shot of this.crowd.take()) if (!this.settings.muted && (sim.speed <= 1.01 || shot.gain >= 0.3)) this.playShot(shot);
        }
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
          // calls only while the break music plays (a scripted segment still runs: the music ducks under the booth)
          this.booth.setUserLevel(this.settings.chatter);
          this.booth.setLevel(this.music.breakPlaying && !this.booth.director.segmentActive ? 'low' : this.settings.chatter);
          this.booth.canTalk = this.phase !== null;
          // browser voices cannot overlap: a segment's next turn waits while the PA / umpire speak
          this.sink.apply(this.booth.tick(now / 1000, cc, { suppressed, fieldHold: !this.gate.concurrent && this.gate.busy.field > 0 }));
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

  /** a park-music file could not be played: the organ stinger of that trigger takes its place */
  private musicFallback(trig: Trigger) {
    const id = TRIGGERS[trig].organ;
    if (!id || this.locked || this.settings.muted || !this.settings.organ || this.host.sim.paused || this.host.sim.skipping) return;
    this.organ.play(id as never, 0.9, 0);
  }

  /** `?musictest=homeRun` (or `a,b`, or `all`): play the triggers in turn, every variant, and say what played */
  private runMusicTest() {
    const list = [...this.musicTestList];
    this.musicTestList = [];
    const next = () => {
      const trig = list.shift();
      if (!trig) return;
      const t = this.music.force(trig as Trigger, performance.now() / 1000);
      console.info(`[music-test] ${trig}: ${t ? `${t.file} (${(t.durationMs / 1000).toFixed(1)} s)` : 'no file, the organ stinger plays'}`);
      if (!t) this.musicFallback(trig as Trigger);
      setTimeout(next, Math.min(100000, (t?.durationMs ?? 6000) + 2500));
    };
    void this.music.load().then(next);
  }

  /** a crowd reaction in its section of the stands (or the whole bowl), heard through the mic array */
  private playShot(s: CrowdShot) {
    this.mixer.playCrowdShot(s);
  }

  /** Sounds with no sim event of their own, derived from the snapshot: bounces, slides, cleats. */
  private frameCues(st: StateLike, speed: number) {
    const b = st.ball;
    if (b.visible) {
      const vy = b.vel.y;
      const r = Math.hypot(b.pos.x, b.pos.z);
      if (this.prevBall && this.prevBall.vy < -1.5 && vy > 0.4 && b.pos.y < 0.6 && r < WALL(b.pos.x, b.pos.z) + 1) {
        // the bounce by what it lands on: grass, infield dirt, the warning track, the plate or the mound
        const hit = -this.prevBall.vy;
        const sb = surfaceBounce(surfaceAt(b.pos.x, b.pos.z));
        const g = 0.3 + 0.6 * Math.min(1, hit / 16);
        this.dispatch({ kind: 'sfx', id: sb.id, bucket: sb.id === 'ground_bounce' ? (hit > 8 ? 1 : 0) : sb.bucket, pos: { x: b.pos.x, y: 0.1, z: b.pos.z }, gain: g, imp: 1 }, st, speed);
      }
      // a ball reaching the backstop (a wild pitch, a passed ball): it bounces back off the padding
      if (this.prevBall && b.pos.z < -18.5 && this.prevBall.vz < -3 && b.vel.z > 0.5) this.dispatch({ kind: 'sfx', id: 'backstop_bang', pos: { x: b.pos.x, y: Math.max(0.5, b.pos.y), z: -20.3 }, gain: 0.4 + 0.5 * Math.min(1, -this.prevBall.vz / 25), imp: 1 }, st, speed);
      this.prevBall = { vy, vz: b.vel.z };
    } else this.prevBall = null;
    let steps = 0;
    for (const p of st.players) {
      const was = this.prevAnim.get(p.id);
      if (p.anim === 'slide' && was !== 'slide') this.dispatch({ kind: 'sfx', id: 'slide_scuff', bucket: 0, pos: { x: p.pos.x, y: 0.2, z: p.pos.z }, gain: 0.6, imp: 1 }, st, speed);
      // the ball from the glove into the throwing hand (after a catch, an out, a pitch)
      if (p.anim === 'transfer' && was !== 'transfer' && speed <= 1.01) this.dispatch({ kind: 'sfx', id: 'glove_transfer', pos: { x: p.pos.x, y: 1.2, z: p.pos.z }, gain: 0.6, imp: 0 }, st, speed);
      this.prevAnim.set(p.id, p.anim);
      const v = Math.hypot(p.vel.x, p.vel.z);
      if (!this.lowPower && speed <= 1.01 && v > 2.5 && steps < 3 && p.role !== 'umpire' && (p.anim === 'run' || p.anim === 'trot' || p.anim === 'run_turn')) {
        // only near a field mic (the plate's dish and the base shotguns hear cleats; nothing else does)
        const d = Math.min(Math.hypot(p.pos.x, p.pos.z), Math.hypot(p.pos.x - BASES.first.x, p.pos.z - BASES.first.z), Math.hypot(p.pos.x - BASES.third.x, p.pos.z - BASES.third.z));
        if (d < 12) {
          const ph = (this.stepPhase.get(p.id) ?? 0) + (v * 0.4) / 30; // ~one stride per (2.5 m / v) s at 30 Hz
          if (ph >= 1) {
            this.stepPhase.set(p.id, 0);
            steps++;
            this.dispatch({ kind: 'sfx', id: 'footstep', bucket: surfaceStep(surfaceAt(p.pos.x, p.pos.z)), pos: { x: p.pos.x, y: 0.05, z: p.pos.z }, gain: 0.35 + 0.06 * Math.min(8, v), imp: 0 }, st, speed);
          } else this.stepPhase.set(p.id, ph);
        }
      }
    }
  }

  get phaseNow() {
    return this.phase;
  }

  dispose() {
    hdManager.onEngine = null;
    hdManager.bindMixer(null);
    voiceManager.onEngine = null;
    voiceManager.bindMixer(null);
    this.sw.neural = null;
    if (this.interval) clearInterval(this.interval);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const o of this.offs) o();
    this.debugPanel?.dispose();
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
      get state() { return { music: { playing: a.music.playingNow, tracks: a.music.manifest.tracks.length, stats: a.music.stats, log: a.music.director.log.slice(-8) }, fx: a.fx.played.slice(-5), tickMs: +a.debug.tickMs.toFixed(3), ctx: a.mixer.state, ready: a.mixer.ready, prepared: `${a.mixer.prepared}/${a.mixer.totalToPrepare}`, muted: a.settings.muted, voices: a.mixer.voiceCount, dropped: a.mixer.droppedVoices, level: a.excitement.level, ambience: a.ambience.gains, speech: { ...a.speech.stats, available: a.speech.available(), pending: a.speech.pending, hd: a.hd.state, hdStats: a.hd.engine?.stats, voice: voiceManager.state, voiceStats: (voiceManager.controller.engine as { stats?: unknown } | null)?.stats }, chat: a.debug.chat, booth: { director: a.booth.director.stats, transcript: a.booth.transcript.slice(-12), field: a.gate.busy, gate: a.gate.stats, concurrent: a.gate.concurrent }, phase: a.phaseNow, idleMs: Math.round(a.speech.idleMs()), organ: a.organ.started, samples: a.mixer.samples, sfxPlayed: a.mixer.played }; },
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

/**
 * App shell: boot (loading screen + engine preparation), the menus, and the play / pause / game-over flow.
 *
 *   boot ──► menu ──Start──► playing ⇄ paused ──► (restart | quit to menu)
 *                               └─► game over ──► (play again | menu)
 *
 * The engine is created once. While a menu is up it runs in "attract" mode (frozen sim, slow fly-around, HUD hidden, hot keys off);
 * Start flips it to play. A new game is `Engine.newGame(seed, config)`; audio is attached inside the click that starts the game
 * (the browser's gesture requirement, so the old "Click to enable sound" prompt is not needed) and replaced on every new game.
 *
 * `?autostart` / `?menu=0` (or any automated browser: `navigator.webdriver`) skip the menu; `?menu=1` forces it.
 */
import './ui.css';
import { Engine } from '../engine/engine';
import { attachAudio, type AudioController } from '../audio';
import { hdManager } from '../audio/hd';
import { voiceManager } from '../audio/voiceManager';
import { DEFAULT_SETTINGS as AUDIO_DEFAULTS, type Settings as AudioSettings } from '../audio/mixer';
import { loadSettings as loadAudio, saveSettings as saveAudio } from '../audio/ui';
import type { QualityName } from '../engine/quality';
import { Boot } from './boot';
import { CLUB_ABBRS, simTeams } from './clubs';
import { deviceQuality, readDevice } from './device';
import { nextFrame, safeStorage } from './dom';
import { settingsScreen, titleScreen, setupScreen, type AppCtx, type AudioBridge } from './menu';
import { Layer, RotateHint, Toast, gameOverScreen, pauseScreen } from './overlays';
import { DEFAULT_SETTINGS, clearSaved, resolve, saveSettings, shareQuery, type GameSettings, type MatchSetup, type Resolved } from './settings';
import { TouchControls } from './touch';
import { Captions } from './captions';

type Mode = 'boot' | 'menu' | 'playing' | 'paused' | 'over';

export interface BootReport {
  /** resolves when the engine is prepared and the first screen (menu or game) is on display */
  ready: Promise<BootReport>;
  /** milliseconds from navigation start to the menu (or game) being interactive */
  tti: number;
  /** milliseconds per preparation step */
  steps: Record<string, number>;
  /** progress log: [t ms, fraction, stage] */
  stages: { t: number; frac: number; stage: string }[];
  /** asset files that failed to load */
  missing: string[];
  mode: Mode;
  autostart: boolean;
}

export async function startApp(root: HTMLElement): Promise<void> {
  const boot = new Boot();
  const report = { tti: 0, steps: {}, stages: boot.log, missing: [], mode: 'boot', autostart: false } as unknown as BootReport;
  let resolveReady!: (r: BootReport) => void;
  report.ready = new Promise<BootReport>((r) => (resolveReady = r));
  (window as unknown as { __boot: BootReport }).__boot = report;
  const run = async () => {
    try {
      await new App(root, boot, report).boot();
      resolveReady(report);
    } catch (e) {
      console.error('[boot] failed', e);
      boot.fail('Could not start the 3D view. Your browser needs WebGL 2.', () => location.reload());
      resolveReady(report);
    }
  };
  await nextFrame(); // let the loading screen paint before the first long task
  await run();
}

class App {
  private res: Resolved;
  private settings: GameSettings;
  private match: MatchSetup;
  private engine!: Engine;
  private audio: AudioController | null = null;
  private audioLocal: AudioSettings;
  private mode: Mode = 'boot';
  private menu = new Layer('Claudeball menu', false);
  private modal = new Layer('Game menu', true);
  private toastUi = new Toast();
  private rotate = new RotateHint();
  private storage = safeStorage();
  private device = readDevice();
  private autoQuality: QualityName;
  private missing: string[] = [];
  private matchTimer = 0;
  private warm: Promise<void> | null = null;
  private warmTimer = 0;
  private overTimer = 0;
  private touch!: TouchControls;
  private captions = new Captions();

  constructor(private root: HTMLElement, private boot_: Boot, private report: BootReport) {
    this.res = resolve(location.search, this.storage, !!navigator.webdriver, CLUB_ABBRS);
    this.settings = { ...this.res.settings };
    this.match = { ...this.res.match };
    this.autoQuality = deviceQuality(this.device);
    this.audioLocal = this.res.flags.noaudio ? { ...AUDIO_DEFAULTS } : loadAudio();
    // HD voices: switch on silently when the player had them on and the model is still cached; works from the menu, before any game
    if (!this.res.flags.noaudio) {
      void hdManager.autoStart();
      void voiceManager.autoStart();
    }
    report.autostart = this.res.autostart;
  }

  private get quality(): QualityName {
    return this.settings.quality === 'auto' ? this.autoQuality : this.settings.quality;
  }

  private simConfig() {
    return { innings: this.settings.innings, tempo: this.settings.tempo, ...simTeams(this.match) };
  }

  // ---- boot --------------------------------------------------------------------------------------------------------------

  async boot() {
    const { flags } = this.res;
    const boot = this.boot_;
    this.root.classList.add('cb-veil');
    document.body.append(this.menu.el, this.modal.el);
    boot.progress(0.01, 'Starting…');
    await nextFrame();
    this.engine = new Engine(this.root, {
      seed: this.match.seed,
      quality: this.quality,
      timeOfDay: this.settings.tod,
      forceMock: flags.mock,
      simConfig: this.simConfig(),
    });
    (window as unknown as { engine: Engine }).engine = this.engine;
    const e = this.engine;
    e.attract = true;
    e.keysEnabled = false;
    e.sim.paused = true;
    e.hud?.setActive(false);
    this.touch = new TouchControls(this.root, e, { onMenu: () => this.pause() });
    this.wireHud();
    this.captions.mount(e.hud?.root ?? this.root);
    this.captions.apply(this.settings);
    // demo / test hook: window.__captionsFeed({ id: 1, speaker: 'play-by-play', text: '…' }) then { type: 'speechEnd', id: 1 }
    (window as unknown as { __captionsFeed: (ev: unknown) => void }).__captionsFeed = (ev) => this.captions.feed(ev);

    const audioWarm = preloadAudioFiles();
    const prepared = await e.prepare({ assets: !flags.noassets, onProgress: (p) => boot.progress(p.frac, p.stage) });
    await audioWarm;
    this.missing = prepared.missing;
    this.report.missing = prepared.missing;
    this.report.steps = prepared.ms;
    if (prepared.missing.length) boot.note(flags.noassets ? '' : 'Some 3D assets did not load: using simple stand-ins.');
    console.info('[boot]', JSON.stringify(prepared.ms), prepared.missing.length ? `missing: ${prepared.missing.join(', ')}` : 'assets ok');

    e.newGame(this.match.seed, this.simConfig());
    await e.rewarm(); // the new game's puppets and their textures, drawn once while hidden
    e.start();
    window.addEventListener('keydown', (ev) => this.onKey(ev));
    document.addEventListener('visibilitychange', () => document.hidden && this.mode === 'playing' && this.pause());
    // two real frames of the new game, drawn while still hidden, then reveal
    await nextFrame();
    await nextFrame();
    if (this.res.autostart) this.beginPlay(true);
    else this.showTitle();
    this.root.classList.remove('cb-veil');
    boot.progress(1, 'Ready');
    await boot.hide();
    this.report.tti = Math.round(performance.now());
    this.report.mode = this.mode;
    console.info(`[boot] interactive in ${this.report.tti} ms (${this.res.autostart ? 'autostart' : 'menu'})`);
    // the sky for the other times of day, downloaded while the menu is up so changing it later does not stall
    void e.env.preloadSky(['day', 'dusk']);
  }

  // ---- context for the menu screens ----------------------------------------------------------------------------------------

  private audioBridge: AudioBridge = {
    get: () => this.audio?.settings ?? this.audioLocal,
    set: (patch) => {
      Object.assign(this.audioLocal, patch);
      if (this.audio) {
        Object.assign(this.audio.settings, patch);
        this.audio.settingsChanged();
      } else if (!this.res.flags.noaudio) saveAudio({ ...this.audioLocal });
    },
    reset: () => this.audioBridge.set({ ...AUDIO_DEFAULTS }),
    hd: {
      status: () => hdManager.status(),
      subscribe: (cb) => hdManager.subscribe(cb),
      toggle: () => void hdManager.toggle(),
      remove: () => void hdManager.remove(),
      preview: () => void hdManager.preview(),
    },
    voice: {
      status: () => ({ ...voiceManager.status(), available: true as const }),
      subscribe: (cb) => voiceManager.subscribe((st) => cb({ ...st, available: true })),
      loadUrl: (url) => void voiceManager.controller.enableFromUrl(url),
      loadFiles: (files) => void voiceManager.controller.enableFromFiles(files),
      off: () => voiceManager.controller.disable(),
      forget: () => void voiceManager.controller.forget(),
      preview: () => void voiceManager.preview(),
    },
  };

  private ctx: AppCtx = {
    settings: undefined as unknown as GameSettings,
    match: undefined as unknown as MatchSetup,
    device: undefined as never,
    autoQuality: 'high',
    fromUrl: new Set(),
    missing: [],
    audio: this.audioBridge,
    update: (p) => this.update(p),
    updateMatch: (p) => this.updateMatch(p),
    resetDefaults: () => this.resetDefaults(),
    start: () => void this.start(),
    link: () => `${location.origin}${location.pathname}?${shareQuery(this.match, this.settings, CLUB_ABBRS)}`,
    toast: (m) => this.toastUi.show(m),
  };

  /** The context object always reflects the live settings (screens are rebuilt from it). */
  private context(): AppCtx {
    Object.assign(this.ctx, { settings: this.settings, match: this.match, device: this.device, autoQuality: this.autoQuality, fromUrl: this.res.fromUrl, missing: this.missing });
    return this.ctx;
  }

  // ---- settings ----------------------------------------------------------------------------------------------------------

  private update(patch: Partial<GameSettings>) {
    const prev = this.settings;
    this.settings = { ...prev, ...patch };
    this.ctx.settings = this.settings;
    saveSettings(this.storage, this.settings);
    this.applySettings(prev);
  }

  private applySettings(prev: GameSettings) {
    const s = this.settings, e = this.engine;
    if (s.quality !== prev.quality) {
      e.setQuality(this.quality);
      this.scheduleWarm();
    }
    if (s.tod !== prev.tod) {
      void e.setTimeOfDay(s.tod);
      this.scheduleWarm();
    }
    if (s.innings !== prev.innings || s.tempo !== prev.tempo) {
      // in the menu the frozen game behind it is rebuilt; during a game the change waits for the next one (never a silent restart)
      if (this.mode === 'menu') this.scheduleNewGame();
      else this.toastUi.show('Applies to the next game');
    }
    if (s.replays !== prev.replays) e.director.replaysEnabled = s.replays;
    if (s.camera !== prev.camera && this.mode !== 'menu') e.director.setAuto(s.camera === 'auto');
    if (s.speed !== prev.speed && this.mode !== 'menu') e.sim.speed = s.speed;
    if (s.hud !== prev.hud) e.hud?.setBroadcast(s.hud);
    if (s.box !== prev.box && this.mode !== 'menu') e.hud?.setBox(s.box);
    if (s.chatter !== prev.chatter) this.audioBridge.set({ chatter: s.chatter });
    this.captions.apply(s);
  }

  private resetDefaults() {
    clearSaved(this.storage);
    const prev = this.settings;
    this.settings = { ...DEFAULT_SETTINGS };
    this.ctx.settings = this.settings;
    this.audioBridge.reset();
    this.applySettings(prev);
  }

  private updateMatch(p: Partial<MatchSetup>) {
    Object.assign(this.match, p);
    this.scheduleNewGame();
  }

  /** After a quality / time-of-day / new-game change: compile and draw everything again (debounced; the sky must be applied first). */
  private scheduleWarm() {
    clearTimeout(this.warmTimer);
    this.warmTimer = window.setTimeout(() => void this.runWarm(), 350);
  }

  private runWarm(): Promise<void> {
    clearTimeout(this.warmTimer);
    this.warmTimer = 0;
    const prev = this.warm ?? Promise.resolve();
    const p: Promise<void> = (this.warm = prev
      .then(async () => {
        await this.engine.env.skyReady;
        await this.engine.rewarm();
      })
      .catch((e) => console.warn('[warm] failed', e))
      .finally(() => {
        if (this.warm === p) this.warm = null;
      }));
    return p;
  }

  /** Teams, seed or length changed in the menu: rebuild the (frozen) game behind it so its players are visible, debounced. */
  private scheduleNewGame() {
    clearTimeout(this.matchTimer);
    this.matchTimer = window.setTimeout(() => this.flushMatch(), 280);
  }

  private flushMatch() {
    if (!this.matchTimer) return;
    clearTimeout(this.matchTimer);
    this.matchTimer = 0;
    this.engine.newGame(this.match.seed, this.simConfig());
    this.scheduleWarm();
    this.syncUrl();
  }

  /** Keep `?seed=&away=&home=` in the address bar so reloading or copying it reproduces this match. */
  private syncUrl() {
    try {
      const q = new URLSearchParams(location.search);
      for (const k of ['seed', 'away', 'home']) q.delete(k);
      const share = new URLSearchParams(shareQuery(this.match, this.settings, CLUB_ABBRS));
      for (const k of ['seed', 'away', 'home']) if (share.has(k)) q.set(k, share.get(k)!);
      history.replaceState(null, '', `${location.pathname}?${q.toString()}${location.hash}`.replace(/\?$/, ''));
    } catch {
      /* sandboxed frames */
    }
  }

  // ---- screens -----------------------------------------------------------------------------------------------------------

  private showTitle() {
    this.mode = 'menu';
    const e = this.engine;
    e.attract = true;
    e.keysEnabled = false;
    e.sim.paused = true;
    e.hud?.setActive(false);
    this.rotate.setEnabled(false);
    this.touch.setPlaying(false);
    this.menu.onEscape = null;
    this.menu.show(titleScreen(this.context(), (s) => this.showMenuScreen(s)));
  }

  private showMenuScreen(s: 'setup' | 'settings') {
    const ctx = this.context();
    const back = () => this.showTitle();
    this.menu.onEscape = back;
    this.menu.show(s === 'setup' ? setupScreen(ctx, back) : settingsScreen(ctx, back));
  }

  /** Start Game (click or Enter): runs inside the user's gesture, so audio can be unlocked here. */
  private async start() {
    if (this.mode !== 'menu') return;
    this.flushMatch();
    this.attachSound();
    if (this.warmTimer) void this.runWarm();
    if (this.warm) {
      // a quality / sky / team change is still compiling: hold the first pitch behind the curtain until it is done
      this.mode = 'boot';
      this.boot_.show('Preparing the match…');
      await this.warm;
      await nextFrame();
      this.mode = 'menu';
      this.beginPlay(false);
      await this.boot_.hide();
    } else this.beginPlay(false);
  }

  private attachSound() {
    this.audio?.dispose();
    this.audio = null;
    this.captions.detach();
    if (this.res.flags.noaudio) return;
    this.audio = attachAudio(this.engine, this.root, { ui: false });
    if (!this.audio) return;
    // captions follow the speech events of this audio controller (a new one is made for every game); no-op until the audio layer has `onSpeech`
    this.captions.attach(this.audio as unknown as Parameters<Captions['attach']>[0]);
    Object.assign(this.audio.settings, this.audioLocal);
    this.audio.onSettings = () => Object.assign(this.audioLocal, this.audio?.settings);
    this.audio.settingsChanged();
    void this.audio.unlock(); // unlocks without un-muting: a muted player stays muted
  }

  /** Switch from menu / curtain to live play. `locked`: autostart, there was no click to unlock audio with (the first tap or key does). */
  private beginPlay(autostart: boolean) {
    const e = this.engine, s = this.settings;
    this.menu.hide();
    this.modal.hide(true);
    this.mode = 'playing';
    e.attract = false;
    e.keysEnabled = true;
    e.sim.paused = false;
    e.sim.speed = s.speed;
    e.director.replaysEnabled = s.replays;
    e.director.setAuto(s.camera === 'auto');
    e.hud?.setActive(true);
    e.hud?.setBroadcast(s.hud);
    e.hud?.setBox(s.box);
    this.rotate.setEnabled(true);
    this.touch.setPlaying(true);
    if (autostart) this.attachSound();
    clearTimeout(this.overTimer);
    const token = ++this.gameToken;
    const off = e.sim.on((te) => {
      if (te.event.type !== 'game_end' || token !== this.gameToken) return;
      off();
      // let the last play, the celebration and the HUD's FINAL banner breathe before the summary
      this.overTimer = window.setTimeout(() => this.showGameOver(), 4500);
    });
  }

  private gameToken = 0;

  private pause() {
    if (this.mode !== 'playing') return;
    this.mode = 'paused';
    this.engine.sim.paused = true;
    this.engine.keysEnabled = false;
    this.touch.setPlaying(false);
    this.rotate.setEnabled(false); // the hint would sit on top of the panel
    this.showPauseScreen();
  }

  private showPauseScreen() {
    this.modal.onEscape = () => this.resume();
    this.modal.show(
      pauseScreen({
        resume: () => this.resume(),
        settings: () => {
          const back = () => this.showPauseScreen();
          this.modal.onEscape = back;
          this.modal.show(settingsScreen(this.context(), back, true));
        },
        restart: () => void this.restart(false),
        quit: () => void this.quit(),
      }),
    );
  }

  private resume() {
    if (this.mode !== 'paused') return;
    this.modal.hide();
    this.mode = 'playing';
    this.engine.sim.paused = false;
    this.engine.keysEnabled = true;
    this.touch.setPlaying(true);
    this.rotate.setEnabled(true);
  }

  private showGameOver() {
    if (this.mode !== 'playing') return;
    this.mode = 'over';
    this.rotate.setEnabled(false);
    this.engine.keysEnabled = false;
    this.touch.setPlaying(false);
    this.modal.onEscape = null;
    this.modal.show(gameOverScreen(this.engine.liveState, { again: () => void this.restart(true), menu: () => void this.quit() }));
  }

  /** A new game behind the curtain. `fresh`: a new random seed (Play again); otherwise the same game from the first pitch (Restart). */
  private async restart(fresh: boolean) {
    this.attachSoundLater();
    await this.curtain('Setting up the game…', async () => {
      if (fresh) this.match.seed = 1 + Math.floor(Math.random() * 999_999);
      this.engine.newGame(this.match.seed, this.simConfig());
      await this.engine.rewarm();
      this.syncUrl();
    });
    this.attachSound();
    this.beginPlay(false);
  }

  private attachSoundLater() {
    this.captions.detach();
    this.audio?.dispose();
    this.audio = null;
  }

  private async quit() {
    this.attachSoundLater();
    await this.curtain('Back to the menu…', async () => {
      this.engine.newGame(this.match.seed, this.simConfig());
      await this.engine.rewarm();
      this.showTitle();
      this.modal.hide(true);
    });
  }

  /** Cover the screen, run `work` (which may stall), draw two frames, uncover. */
  private async curtain(stage: string, work: () => void | Promise<void>) {
    this.boot_.show(stage);
    this.engine.keysEnabled = false;
    await nextFrame();
    await nextFrame();
    await work();
    await nextFrame();
    await nextFrame();
    await this.boot_.hide();
  }

  // ---- keyboard ----------------------------------------------------------------------------------------------------------

  private onKey(ev: KeyboardEvent) {
    if (ev.key !== 'Escape' && !(ev.key.toLowerCase() === 'p' && this.mode === 'playing' && !isTyping(ev))) return;
    if (this.modal.visible) return void this.modal.onEscape?.();
    if (this.mode === 'playing') return this.pause();
    if (this.mode === 'menu') this.menu.onEscape?.();
  }

  // ---- HUD ---------------------------------------------------------------------------------------------------------------

  private wireHud() {
    const hud = this.engine.hud;
    if (!hud) return;
    hud.act.onMenu = () => this.pause();
    hud.act.onControls = (open) => this.rotate.setSuppressed(open);
    hud.act.isPaused = () => this.engine.sim.paused;
    hud.act.getState = () => ({ auto: this.engine.director.auto, replays: this.engine.director.replaysEnabled, speed: this.engine.sim.speed });
    hud.act.toggleMute = () => {
      if (!this.audio) return this.toastUi.show('Sound is off for this session');
      void this.audio.toggleMute();
      return this.audio.settings.muted || this.audio.isLocked;
    };
    hud.act.soundState = () => (!this.audio ? 'off' : this.audio.isLocked ? 'locked' : this.audio.settings.muted ? 'muted' : 'on');
    hud.act.fullscreen = () => this.touch.toggleFullscreen();
    hud.act.initial = { quality: this.quality, tod: this.settings.tod };
    hud.syncControls();
  }
}

const isTyping = (ev: KeyboardEvent) => ['INPUT', 'TEXTAREA', 'SELECT'].includes((ev.target as HTMLElement)?.tagName);

/** Fetch the audio files the manifest lists, so the sound is in the HTTP cache when the game starts (failures are ignored). */
async function preloadAudioFiles() {
  try {
    const base = `${import.meta.env.BASE_URL}audio/`;
    const r = await fetch(`${base}manifest.json`);
    if (!r.ok) return;
    const m = (await r.json()) as Record<string, unknown>;
    const files = new Set<string>();
    const walk = (v: unknown) => {
      if (typeof v === 'string' && /\.(ogg|mp3|wav|m4a)$/i.test(v)) files.add(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(m);
    await Promise.all([...files].map((f) => fetch(f.startsWith('http') ? f : base + f).then((x) => x.arrayBuffer()).catch(() => undefined)));
  } catch {
    /* sound still works: the mixer fetches them itself */
  }
}


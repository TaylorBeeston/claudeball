/**
 * Audio layer entry point. `attachAudio(engine, root)` is the only thing `main.ts` calls: it listens to the game's events,
 * turns them into cues (`cues.ts`) and plays them (`mixer.ts`, `ambience.ts`, `organ.ts`, `speech.ts`). It reads the engine
 * through a small structural interface and never writes to it, so the sim and engine are unaffected.
 *
 * Event source: the raw sim event bus when it can be reached (richer: swing/look calls, error kinds, wall contacts, robbed
 * home runs ...), else the engine's reduced GameEvent stream (`?mock`). Never both, or every cue would play twice.
 */
import { CueMapper, allowedAtSpeed, engineToRaw } from './cues';
import { Mixer, type Settings } from './mixer';
import { Ambience } from './ambience';
import { Organ } from './organ';
import { SpeechQueue, browserSpeech } from './speech';
import { AudioUi, loadSettings, saveSettings } from './ui';
import { Excitement, baseline } from './excitement';
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

/** The engine's real-sim adapter keeps the sim's own game as `g`; use its full event bus when present. */
export function rawBusOf(game: unknown): RawBus | null {
  const g = (game as { g?: RawBus } | null)?.g;
  return g && typeof g.on === 'function' ? g : null;
}

export interface AudioOptions {
  /** do not create any audio (URL `?noaudio`) */
  off?: boolean;
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
  readonly excitement = new Excitement();
  private ui: AudioUi | null = null;
  private mapper = new CueMapper();
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
  private offs: (() => void)[] = [];

  readonly debug = {
    cues: [] as DebugCue[],
    mapped: {} as Record<string, number>,
    played: {} as Record<string, number>,
    perHalf: {} as Record<string, Record<string, number>>,
    energy: [] as { t: number; rms: number; peak: number }[],
    events: 0,
  };

  constructor(private host: AudioHost, root: HTMLElement) {
    this.settings = loadSettings();
    this.mixer = new Mixer(this.settings);
    this.ambience = new Ambience(this.mixer);
    this.organ = new Organ(this.mixer);
    this.speech = new SpeechQueue(browserSpeech());
    this.syncSpeech();
    this.raw = rawBusOf(host.sim.game);
    if (this.raw) this.raw.on('*', (e) => this.push(e));
    else host.sim.on((te) => {
      const r = engineToRaw(te.event);
      if (r) this.push(r);
    });
    this.ui = new AudioUi(root, this.settings, {
      toggleMute: () => this.toggleMute(),
      changed: () => this.settingsChanged(),
      gesture: () => void this.unlock(),
      enable: () => void this.enable(),
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

  private settingsChanged() {
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

  private push(ev: RawEvent) {
    this.debug.events++;
    if (this.host.sim.skipping) return;
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

  private dispatch(c: Cue, st: StateLike, simSpeed: number) {
    const key = `${st.inning}${st.half === 'top' ? 't' : 'b'}`;
    const id = c.kind === 'speak' ? c.role : c.kind === 'excite' ? 'excite' : c.id;
    const tag = `${c.kind}:${id}`;
    this.debug.mapped[tag] = (this.debug.mapped[tag] ?? 0) + 1;
    const h = (this.debug.perHalf[key] ??= {});
    h[tag] = (h[tag] ?? 0) + 1;
    let played = false;
    const speech = c.kind === 'speak';
    const gated = !allowedAtSpeed(c.imp, simSpeed, this.host.sim.skipping) || (speech && simSpeed > 1.01);
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
        return this.settings.muted ? false : this.organ.play(c.id, c.gain ?? 1, 0);
      case 'speak': {
        if (this.locked || this.settings.muted) return false;
        if (!this.speech.enabled[c.role]) return false;
        if (!this.speech.available()) {
          // no voices in this browser: the umpire still gets a shout so the call is audible
          if (c.role === 'ump') return m.playSfx({ kind: 'sfx', id: 'ump_yell', gain: 0.7, imp: 2 });
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
        if (replay) this.mixer.playSfx({ kind: 'sfx', id: 'replay_whoosh', gain: 0.5, imp: 1 });
        this.wasReplay = replay;
      }
      if (replay !== this.mixer.replay || sim.paused !== this.mixer.paused) this.mixer.setMode({ replay, paused: sim.paused });
      this.speech.setPaused(sim.paused);
      if (sim.skipping && !this.wasSkipping) {
        this.pending.length = 0;
        this.speech.clear();
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
      }
      this.wasSkipping = sim.skipping;
      if (sim.speed > 1.01 && this.lastSpeed <= 1.01) this.speech.clear();
      this.lastSpeed = sim.speed;

      // events since the last tick (the state is current now, so names and positions are too)
      if (this.pending.length) {
        const ctx = this.buildCtx(st);
        const batch = this.pending;
        this.pending = [];
        for (const { ev, at } of batch) {
          // a new batter may not be on the field yet: wait a moment for the name
          if (ev.type === 'batterUp' && !ctx.person(ev.batterId) && now - at < 1500) {
            this.pending.push({ ev, at });
            continue;
          }
          for (const c of this.mapper.map(ev, ctx)) this.dispatch(c, st, sim.speed);
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
    const a = new AudioController(host, root);
    const dbg = {
      get cues() { return a.debug.cues; },
      get mapped() { return a.debug.mapped; },
      get played() { return a.debug.played; },
      get perHalf() { return a.debug.perHalf; },
      get energy() { return a.debug.energy; },
      get events() { return a.debug.events; },
      get state() { return { ctx: a.mixer.state, ready: a.mixer.ready, prepared: `${a.mixer.prepared}/${a.mixer.totalToPrepare}`, muted: a.settings.muted, voices: a.mixer.voiceCount, dropped: a.mixer.droppedVoices, level: a.excitement.level, ambience: a.ambience.gains, speech: { ...a.speech.stats, available: a.speech.available(), pending: a.speech.pending }, organ: a.organ.started, samples: a.mixer.samples, sfxPlayed: a.mixer.played }; },
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

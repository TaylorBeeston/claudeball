/**
 * Park music playback: loads the manifest, follows the director's decisions and plays the files, lazily and light on memory (a track is
 * *streamed* through a media element, never decoded whole; only the next likely tracks are fetched ahead, and not on a metered connection).
 * No manifest, no file, a file that fails: nothing plays here and the organ stinger of the same moment plays instead (`onFallback`).
 */
import type { Mixer } from '../mixer';
import { MusicDirector, type MusicCtx, type MusicDecision, type MusicRaw } from './director';
import { EMPTY_MANIFEST, TRIGGERS, TRIGGER_IDS, parseManifest, type MusicManifest, type Trigger, type TrackInfo } from './manifest';

export interface MusicHandle {
  stop(fadeMs: number): void;
}

export interface MusicBackend {
  /** can sound be made right now (the AudioContext runs)? */
  ready(): boolean;
  start(url: string, o: { loop: boolean; gain: number; fadeInMs: number; onEnded: () => void; onError: () => void }): MusicHandle;
}

export interface ParkMusicOptions {
  backend: MusicBackend;
  rng?: () => number;
  /** the folder the files and the manifest live in, with a trailing slash */
  base: string;
  /** phones: fetch fewer files ahead */
  lowPower?: boolean;
  /** a file could not be played: the caller plays the organ stinger of that trigger */
  onFallback?: (trigger: Trigger) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  fetcher?: typeof fetch;
}

const manifests = new Map<string, Promise<MusicManifest>>();

/** fetch the manifest of a folder once per page (the app starts it at boot, so it is there when the game starts) */
export function fetchParkManifest(base: string, fetcher?: typeof fetch): Promise<MusicManifest> {
  let p = manifests.get(base);
  if (!p) {
    p = (async () => {
      try {
        const f = fetcher ?? (typeof fetch !== 'undefined' ? fetch : null);
        if (!f) return EMPTY_MANIFEST;
        const res = await f(`${base}manifest.json`);
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return EMPTY_MANIFEST;
        return parseManifest(await res.json());
      } catch {
        return EMPTY_MANIFEST; // no manifest: the organ plays
      }
    })();
    if (!fetcher) manifests.set(base, p);
  }
  return p;
}

export class ParkMusic {
  readonly director: MusicDirector;
  manifest: MusicManifest = EMPTY_MANIFEST;
  /** the manifest has been read and has tracks */
  loaded = false;
  private loading: Promise<void> | null = null;
  /** the manifest has been read (with or without tracks) */
  ready = false;
  private waiting: { ev: MusicRaw; c: MusicCtx; t: number; at: number }[] = [];
  private handle: MusicHandle | null = null;
  private pending: unknown = null;
  private maxTimer: unknown = null;
  private bad = new Set<string>();
  private warmed = new Set<string>();
  private silent = false;
  /** what is playing now (debug) */
  current: { trigger: Trigger; track: TrackInfo } | null = null;
  readonly stats = { started: 0, failed: 0, prefetched: 0 };

  constructor(private o: ParkMusicOptions) {
    this.director = new MusicDirector({ rng: o.rng ?? Math.random, tracks: () => this.manifest.tracks.filter((t) => !this.bad.has(t.id)) });
  }

  private timer(fn: () => void, ms: number) {
    return (this.o.setTimer ?? ((f: () => void, m: number) => setTimeout(f, m)))(fn, ms);
  }
  private untimer(h: unknown) {
    (this.o.clearTimer ?? ((x: unknown) => clearTimeout(x as never)))(h);
  }

  /** fetch `manifest.json` once; anything wrong (no file, a page instead of JSON) means "no tracks" */
  load(): Promise<void> {
    return (this.loading ??= this.fetchManifest());
  }

  private async fetchManifest(): Promise<void> {
    this.manifest = await fetchParkManifest(this.o.base, this.o.fetcher);
    this.loaded = this.manifest.tracks.length > 0;
    this.director.resetPlans();
    this.ready = true;
    if (this.loaded) this.prefetch();
    // events that came while the manifest was still on its way (the opening of a game): decide them now, if they are still fresh
    const late = this.waiting.splice(0);
    for (const w of late) if (performance.now() - w.at < 4000) this.observe(w.ev, w.c, w.t + (performance.now() - w.at) / 1000);
  }

  private url(t: TrackInfo) {
    return `${this.o.base}${t.file}`;
  }

  /** fetch the next likely tracks into the HTTP cache (not into memory): the break, the walk-up and the next run's stinger */
  prefetch() {
    const nav = (typeof navigator !== 'undefined' ? navigator : null) as (Navigator & { connection?: { saveData?: boolean } }) | null;
    if (nav?.connection?.saveData) return;
    const f = this.o.fetcher ?? (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) return;
    const order: Trigger[] = ['gameStart', 'walkUp', 'inningBreak', 'runScored', 'homeRun'];
    const limit = this.o.lowPower ? 2 : 4;
    for (const trig of order) {
      if (this.warmed.size >= limit && !this.warmed.has(this.director.peek(trig)?.file ?? '')) continue;
      const t = this.director.peek(trig);
      if (!t || this.warmed.has(t.file)) continue;
      this.warmed.add(t.file);
      this.stats.prefetched++;
      void f(this.url(t)).then((r) => r.arrayBuffer()).catch(() => this.warmed.delete(t.file));
    }
  }

  /** an event of the game: run what the director decides */
  observe(ev: MusicRaw, c: MusicCtx, t: number) {
    if (this.silent) return;
    if (!this.ready) {
      if (this.waiting.length < 20) this.waiting.push({ ev, c, t, at: performance.now() });
      void this.load();
      return;
    }
    this.run(this.director.observe(ev, c, t), t);
  }

  /** a few times a second: `silent` = pause, skip, fast-forward, mute, music off, audio locked */
  tick(t: number, silent: boolean) {
    if (silent !== this.silent) {
      this.silent = silent;
      if (silent) this.run(this.director.silence(t, 'silenced'), t);
    }
    if (!silent) this.run(this.director.tick(t), t);
  }

  /** debug (`?musictest=`): play a trigger now */
  force(trigger: Trigger, t: number): TrackInfo | null {
    this.silent = false;
    const ds = this.director.force(trigger, t);
    this.run(ds, t);
    return ds.find((d): d is Extract<MusicDecision, { kind: 'play' }> => d.kind === 'play')?.track ?? null;
  }

  private run(ds: MusicDecision[], t: number) {
    void t;
    for (const d of ds) {
      if (d.kind === 'stop') this.stopNow(d.fadeMs);
      else this.start(d);
    }
  }

  private stopNow(fadeMs: number) {
    if (this.pending) this.untimer(this.pending);
    this.pending = null;
    if (this.maxTimer) this.untimer(this.maxTimer);
    this.maxTimer = null;
    this.handle?.stop(fadeMs);
    this.handle = null;
    this.current = null;
  }

  private start(d: Extract<MusicDecision, { kind: 'play' }>) {
    const track = d.track;
    if (!track) return; // no file: the organ stinger of this moment plays
    const go = () => {
      this.pending = null;
      if (this.silent || !this.o.backend.ready()) {
        this.director.ended(0);
        return;
      }
      const fail = () => {
        this.stats.failed++;
        this.bad.add(track.id);
        this.director.resetPlans();
        if (this.current?.track === track) {
          this.current = null;
          this.handle = null;
          this.director.ended(0);
        }
        this.o.onFallback?.(d.trigger);
      };
      this.current = { trigger: d.trigger, track };
      this.stats.started++;
      this.handle = this.o.backend.start(this.url(track), {
        loop: track.loop && TRIGGERS[d.trigger].loop,
        gain: track.gain * d.level,
        fadeInMs: d.fadeInMs,
        onEnded: () => {
          if (this.current?.track !== track) return;
          this.current = null;
          this.handle = null;
          if (this.maxTimer) this.untimer(this.maxTimer);
          this.maxTimer = null;
          this.director.ended(0);
        },
        onError: fail,
      });
      if (d.maxMs > 0) this.maxTimer = this.timer(() => this.stopNow(1500), d.maxMs);
      this.prefetch();
    };
    if (this.pending) this.untimer(this.pending);
    if (d.delayMs > 0) this.pending = this.timer(go, d.delayMs);
    else go();
  }

  /** is the break music playing (the booth then keeps quiet)? */
  get breakPlaying(): boolean {
    return this.current?.trigger === 'inningBreak';
  }

  get playingNow(): Trigger | null {
    return this.current?.trigger ?? null;
  }

  /** a track is playing or about to start: the organ stays quiet (no overlap) */
  get active(): boolean {
    return !!this.current || !!this.pending;
  }

  /** the organ stinger of a trigger is not needed when a file has just started for it */
  covered(triggers: Trigger[], t: number, within = 4): boolean {
    return this.director.covered(triggers, t, within);
  }

  get triggers() {
    return TRIGGER_IDS;
  }
}

/** The real backend: a streaming `<audio>` element per track, through a gain node into the mixer's music bus. */
export class WebAudioMusic implements MusicBackend {
  constructor(private mixer: Mixer) {}

  ready(): boolean {
    return !!this.mixer.ctx && this.mixer.ctx.state === 'running' && !!this.mixer.musicBus && typeof Audio !== 'undefined';
  }

  start(url: string, o: { loop: boolean; gain: number; fadeInMs: number; onEnded: () => void; onError: () => void }): MusicHandle {
    const ctx = this.mixer.ctx!;
    const el = new Audio();
    el.preload = 'auto';
    el.loop = o.loop;
    el.src = url;
    let node: MediaElementAudioSourceNode | null = null;
    const g = ctx.createGain();
    g.gain.value = 0;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
        node?.disconnect();
        g.disconnect();
      } catch {
        /* already gone */
      }
    };
    try {
      node = ctx.createMediaElementSource(el);
      node.connect(g);
      g.connect(this.mixer.musicBus);
    } catch {
      queueMicrotask(o.onError);
      return { stop: cleanup };
    }
    el.onerror = () => {
      if (done) return;
      cleanup();
      o.onError();
    };
    el.onended = () => {
      if (done) return;
      cleanup();
      o.onEnded();
    };
    const t = ctx.currentTime;
    void el.play().then(
      () => {
        if (done) return;
        const now = ctx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(o.gain, now + Math.max(0.02, o.fadeInMs / 1000));
      },
      () => {
        if (done) return;
        cleanup();
        o.onError();
      },
    );
    void t;
    return {
      stop: (fadeMs: number) => {
        if (done) return;
        const now = ctx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + Math.max(0.03, fadeMs / 1000));
        setTimeout(cleanup, fadeMs + 80);
      },
    };
  }
}

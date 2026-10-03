/**
 * Start-up tuning for "Auto" quality: while the loading screen is up, run a few dozen real frames of the park (on the broadcast pitch camera: the typical shot),
 * measure the main-thread time of the tick (draw-call submission dominates it) and the frame interval, and move the preset down (or up, on
 * desktop-class devices) until that shot fits the 60 fps budget. The result is remembered per device signature, so later visits skip it.
 * The choice rests on measured times, not on the user agent: `deviceQuality` only supplies the starting point.
 */
import type { QualityName } from '../engine/quality';
import { QUALITY_ORDER } from '../engine/quality';

export interface Measure {
  /** median main-thread ms of one tick (sim + puppets + render submit) */
  tickMs: number;
  /** median interval between frames in ms (vsync-capped, so it only shows misses) */
  intervalMs: number;
}

export interface TuneLimits {
  /** the highest preset Auto may pick (phones: medium, so a hot device is not pushed further; the player can still choose High / Ultra) */
  max: QualityName;
  /** the lowest */
  min: QualityName;
}

const idx = (q: QualityName) => QUALITY_ORDER.indexOf(q);

/** over budget: the interval misses 60 fps, or the tick alone eats most of a frame */
export const isOver = (m: Measure) => m.intervalMs > 20 || m.tickMs > 13;
/** comfortably inside the budget: no missed frames and the tick uses well under half of it */
export const isComfortable = (m: Measure) => m.intervalMs < 17.6 && m.tickMs < 6.5;

/**
 * One decision step: the next preset to try, or null when `current` is the answer.
 * `came` says how we got here ('start' | 'down' | 'up') so that a step up that turned out too much is undone and never repeated.
 */
export function nextPreset(current: QualityName, m: Measure, lim: TuneLimits, came: 'start' | 'down' | 'up'): QualityName | null {
  const i = idx(current);
  if (isOver(m)) return i > idx(lim.min) ? QUALITY_ORDER[i - 1] : null;
  if (came === 'up') return null;
  if (came === 'start' && isComfortable(m) && i < idx(lim.max)) return QUALITY_ORDER[i + 1];
  return null;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

export interface TuneEngine {
  tick(dt: number, render?: boolean): void;
  setQuality(q: QualityName): void;
  rewarm(): Promise<void>;
  adaptive: { enabled: boolean };
  /** menu-mode camera; the tuner measures on the pitch camera (the typical shot) instead of the wide fly-around (the worst one) */
  attractView?: 'tour' | 'pitch';
}

const raf = () => new Promise<number>((r) => requestAnimationFrame(r));

/** run `frames` real frames and measure them (the first few are discarded: they pay for uploads and shader variants) */
export async function measure(e: TuneEngine, frames = 48, skip = 14): Promise<Measure> {
  const ticks: number[] = [], gaps: number[] = [];
  let last = await raf();
  for (let i = 0; i < frames; i++) {
    const ts = await raf();
    const t0 = performance.now();
    e.tick(Math.min((ts - last) / 1000, 0.05));
    if (i >= skip) {
      ticks.push(performance.now() - t0);
      gaps.push(ts - last);
    }
    last = ts;
  }
  return { tickMs: median(ticks), intervalMs: median(gaps) };
}

export interface TuneResult {
  preset: QualityName;
  steps: { preset: QualityName; m: Measure }[];
}

export async function tune(e: TuneEngine, start: QualityName, lim: TuneLimits, onStage?: (s: string) => void): Promise<TuneResult> {
  const wasAdaptive = e.adaptive.enabled;
  const wasView = e.attractView;
  e.adaptive.enabled = false;
  // Most of a game is spent on the pitch camera and close-ups; the wide fly-around of the menu costs more (more draw calls in view) and would
  // push phones down to Low although Medium holds 60 on the usual shots. The adaptive resolution scale absorbs the occasional wide shot.
  if (wasView !== undefined) e.attractView = 'pitch';
  const steps: TuneResult['steps'] = [];
  let cur = start;
  let came: 'start' | 'down' | 'up' = 'start';
  try {
    for (let n = 0; n < 4; n++) {
      onStage?.('Tuning graphics…');
      const m = await measure(e);
      steps.push({ preset: cur, m });
      const next = nextPreset(cur, m, lim, came);
      if (!next) {
        // a step up that was too much: back to where it was fine
        if (came === 'up' && isOver(m)) cur = QUALITY_ORDER[idx(cur) - 1];
        break;
      }
      came = idx(next) > idx(cur) ? 'up' : 'down';
      cur = next;
      e.setQuality(cur);
      await e.rewarm();
    }
    // landed on a preset other than the last one measured (an undone step up): switch back
    const last = steps[steps.length - 1].preset;
    if (cur !== last) {
      e.setQuality(cur);
      await e.rewarm();
    }
  } finally {
    e.adaptive.enabled = wasAdaptive;
    if (wasView !== undefined) e.attractView = wasView;
  }
  return { preset: cur, steps };
}

/** the device signature the remembered result belongs to */
export function signature(d: { gpu?: string; cores?: number; shortSide: number }, dpr: number): string {
  return `${d.gpu ?? '?'}|${d.cores ?? '?'}|${d.shortSide}|${dpr}`;
}

const KEY = 'cb.tune.v1';

export function loadTuned(store: Storage | null, sig: string): QualityName | null {
  try {
    const v = JSON.parse(store?.getItem(KEY) ?? 'null') as { sig: string; preset: QualityName; at: number } | null;
    if (v && v.sig === sig && QUALITY_ORDER.includes(v.preset) && Date.now() - v.at < 30 * 864e5) return v.preset;
  } catch {
    /* unreadable: measure again */
  }
  return null;
}

export function saveTuned(store: Storage | null, sig: string, preset: QualityName) {
  try {
    store?.setItem(KEY, JSON.stringify({ sig, preset, at: Date.now() }));
  } catch {
    /* private mode: not remembered */
  }
}

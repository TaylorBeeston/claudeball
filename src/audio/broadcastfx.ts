/**
 * Broadcast stings for the camera work (pure: the caller passes the time). Tasteful and rare: a soft whoosh for a dissolve or a wipe, a tiny
 * low tick on a hard cut to B-roll or out of a replay, a whoosh with a short rising sting into a replay, a small blip when a graphic
 * (lower third) appears, a low thump on a stadium aerial. At most one sting every 3 s (a replay sting may follow after 1 s).
 *
 * Two sources, never both: the engine's structured events (`cameraCut { kind, from, to, durationMs }`, `replayStart`, `replayEnd`,
 * `graphicShown { kind }`) when they arrive, and until then the changes of the director's shot name.
 */
export type FxId = 'bfx_whoosh' | 'bfx_thunk' | 'bfx_replay' | 'bfx_blip' | 'bfx_thump';

export interface FxPlan {
  id: FxId;
  gain: number;
}

export interface CameraEvent {
  type: string;
  kind?: string;
  from?: string;
  to?: string;
  durationMs?: number;
}

export const FX_EVENT_TYPES = new Set(['cameraCut', 'replayStart', 'replayEnd', 'graphicShown']);

const AERIAL = new Set(['aerial', 'stadium', 'stadiumAerial', 'establishing']);
const CLOSEUP = new Set(['broll', 'cutaway', 'closeup', 'closeUp', 'dugout', 'face']);

export class BroadcastFx {
  /** seconds between two stings (a replay sting only needs `replayGap`) */
  minGap: number;
  replayGap = 1;
  /** the engine sends structured events: the shot-name fallback is off */
  eventsSeen = false;
  private last = -99;
  private lastThump = -99;
  private lastReplay = -99;
  private prev = '';
  /** what was played (tests, debug) */
  readonly played: { t: number; id: FxId }[] = [];

  constructor(o: { minGap?: number } = {}) {
    this.minGap = o.minGap ?? 3;
  }

  private emit(id: FxId, gain: number, t: number, gap = this.minGap): FxPlan | null {
    if (t - this.last < gap) return null;
    this.last = t;
    if (id === 'bfx_thump') this.lastThump = t;
    if (id === 'bfx_replay') this.lastReplay = t;
    this.played.push({ t, id });
    if (this.played.length > 100) this.played.shift();
    return { id, gain };
  }

  private replay(t: number): FxPlan | null {
    if (t - this.lastReplay < 2) return null; // the cut event and the replayStart event of one replay: one sting
    return this.emit('bfx_replay', 0.8, t, this.replayGap);
  }

  /** a structured camera / graphics event from the engine */
  event(ev: CameraEvent, t: number): FxPlan | null {
    if (!FX_EVENT_TYPES.has(ev.type)) return null;
    this.eventsSeen = true;
    switch (ev.type) {
      case 'replayStart':
        return this.replay(t);
      case 'replayEnd':
        return this.emit('bfx_whoosh', 0.35, t);
      case 'graphicShown':
        return this.emit('bfx_blip', 0.3, t);
      case 'cameraCut': {
        const kind = String(ev.kind ?? 'cut');
        const to = String(ev.to ?? '');
        const from = String(ev.from ?? '');
        if (kind === 'replay' || (kind === 'cut' && to === 'replay')) return this.replay(t);
        if (AERIAL.has(to) && t - this.lastThump > 25) return this.emit('bfx_thump', 0.6, t);
        if (kind === 'dissolve') return this.emit('bfx_whoosh', 0.45, t);
        if (kind === 'wipe') return this.emit('bfx_whoosh', 0.6, t);
        if (kind === 'broll' || (kind === 'cut' && (CLOSEUP.has(to) || from === 'replay'))) return this.emit('bfx_thunk', 0.35, t);
        return null; // an ordinary cut is silent
      }
      default:
        return null;
    }
  }

  /** the director's shot name each frame (only the changes matter); used until structured events arrive */
  shot(name: string, t: number): FxPlan | null {
    const prev = this.prev;
    this.prev = name;
    if (this.eventsSeen || !prev || name === prev) return null;
    if (name === 'replay') return this.replay(t);
    if (prev === 'replay') return this.emit('bfx_whoosh', 0.35, t);
    if (name === 'broll') return this.emit('bfx_thunk', 0.35, t);
    if (name === 'wide' && t - this.lastThump > 25) return this.emit('bfx_thump', 0.6, t);
    return null;
  }
}

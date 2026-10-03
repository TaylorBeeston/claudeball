import type { BroadcastEvent } from './types';

/** A tiny typed emitter for the director's broadcast events. Listeners that throw never break the render loop. */
export class Broadcast {
  private listeners = new Set<(e: BroadcastEvent) => void>();

  on(cb: (e: BroadcastEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(e: BroadcastEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error('[broadcast] listener failed', err);
      }
    }
  }
}

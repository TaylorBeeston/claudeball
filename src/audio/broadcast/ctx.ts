import type { ChatCtx } from '../commentary';

/** What the booth knows about the game right now (built from the sim snapshot by the controller; fixtures in tests). */
export interface BoothCtx extends ChatCtx {
  /** a player by id: name and fielding role (`left`, `center`, `short` ...) */
  person?(id: unknown): { name: string; role?: string; number?: number } | undefined;
  /** sim time, seconds */
  time?: number;
}

export const lastNameOf = (full: string) => {
  const p = full.trim().split(/\s+/);
  return p.length > 1 ? p[p.length - 1] : full;
};

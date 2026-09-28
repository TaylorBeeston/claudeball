import type { GameEvent } from './types';
import type { World } from './world';
import { TICK } from './world';

const QUEUE_CAP = 20000;

type Distribute<T> = T extends unknown ? Omit<T, 'time'> : never;

/** Emit a discrete event: queued for `drainEvents()` and delivered to `on()` listeners synchronously. */
export function emit(w: World, e: Distribute<GameEvent>): void {
  const ev = { ...e, time: w.tick * TICK } as GameEvent;
  w.events.push(ev);
  if (w.events.length > QUEUE_CAP) w.events.splice(0, w.events.length - QUEUE_CAP);
  const a = w.listeners.get(ev.type);
  if (a) for (const cb of [...a]) cb(ev);
  const all = w.listeners.get('*');
  if (all) for (const cb of [...all]) cb(ev);
}

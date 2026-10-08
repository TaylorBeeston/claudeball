/** Decision plumbing: routes requests to the providers, one-tick application, pause / resume for deferred answers. */
import { emit } from './events';
import { snapshot } from './snapshot';
import { PENDING } from './decisions';
import type { Situation, DecisionKind, DecisionOf, DecisionProvider, DecisionRequest, FullDecisionProvider, Pending, RequestOf } from './decisions';
import type { TeamSide } from './types';
import type { World } from './world';
import * as clock from './clock';

export interface Slot {
  id: number;
  kind: DecisionKind;
  side: TeamSide;
  req: DecisionRequest;
  state: 'wait' | 'ready';
  value: unknown;
  /** Tick at which the answer became available (decisions are applied on a later tick). */
  readyTick: number;
  /** A deferred answer that does not pause the game (a `clocked` provider asked under the pitch clock). */
  free?: boolean;
}

export interface DecState {
  seq: number;
  slots: Map<string, Slot>;
  byId: Map<number, Slot>;
  /** Number of questions waiting for a deferred answer: while > 0 the sim does not advance. */
  waiting: number;
  providers: { home?: DecisionProvider; away?: DecisionProvider };
}

export function situationOf(w: World): Situation {
  const at = (b: number) => w.runners.find((r) => r.state === 'live' && r.base === b && !(r.isBatter && r.base === 0))?.p.info.id ?? null;
  return {
    inning: w.inning,
    half: w.half,
    outs: w.outs,
    balls: w.count.balls,
    strikes: w.count.strikes,
    scoreDiff: w.battingTeam.runs - w.fieldingTeam.runs,
    runners: { first: at(1), second: at(2), third: at(3) },
    clockSec: clock.clockOn(w) && clock.running(w) ? clock.remaining(w) : null,
    disengagementsLeft: clock.disengagementsLeft(w),
    timeoutAvailable: clock.timeoutAvailable(w),
  };
}

export const newDecState = (providers?: DecState['providers']): DecState => ({ seq: 0, slots: new Map(), byId: new Map(), waiting: 0, providers: { ...providers } });

/** Internal context the built-in AI needs for a request (kept out of the public request). */
const CTX = new WeakMap<object, unknown>();
export const ctxOf = <T>(req: object): T => CTX.get(req) as T;

type Body<K extends DecisionKind> = Omit<RequestOf<K>, 'id' | 'kind' | 'side' | 'time' | 'state'>;

const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as { then?: unknown }).then === 'function';

/**
 * Ask a question. Returns PENDING until the decision may be applied; call again on later ticks (idempotent for the same
 * `key`) and use the decision once it is returned (the slot is then consumed).
 */
export function ask<K extends DecisionKind>(w: World, key: string, kind: K, side: TeamSide, build: () => Body<K>, ctx?: unknown): DecisionOf<K> | Pending {
  const dec = w.dec;
  let slot = dec.slots.get(key);
  if (!slot) {
    const id = ++dec.seq;
    const req = { ...build(), id, kind, side, time: w.tick / 240 } as unknown as RequestOf<K>;
    let cache: unknown;
    Object.defineProperty(req, 'state', {
      enumerable: true,
      configurable: true,
      get: () => (cache ??= snapshot(w)),
    });
    if (ctx !== undefined) CTX.set(req, ctx);
    slot = { id, kind, side, req: req as DecisionRequest, state: 'ready', value: undefined, readyTick: w.tick };
    dec.slots.set(key, slot);
    dec.byId.set(id, slot);
    const fn = dec.providers[side]?.[kind] as ((r: RequestOf<K>) => unknown) | undefined;
    let r: unknown = fn ? fn(req) : undefined;
    if (r === undefined) r = (w.ai[kind] as (r: RequestOf<K>) => unknown)(req);
    if (r === PENDING || isThenable(r)) {
      slot.state = 'wait';
      if (dec.providers[side]?.clocked && (kind === 'pitch' || kind === 'pickoff') && clock.clockOn(w) && (w.clock.state === 'running' || w.clock.state === 'armed')) slot.free = true;
      else dec.waiting++;
      emit(w, { type: 'decisionRequested', id, decision: kind, side });
      if (r !== PENDING) {
        const s = slot;
        (r as PromiseLike<unknown>).then((v) => settle(w, s, v));
      }
    } else slot.value = r;
    return PENDING;
  }
  if (slot.state === 'wait') return PENDING;
  if (slot.readyTick === w.tick) return PENDING;
  dec.slots.delete(key);
  dec.byId.delete(slot.id);
  return slot.value as DecisionOf<K>;
}

function settle(w: World, slot: Slot, value: unknown): void {
  if (slot.state !== 'wait') return;
  let v = value;
  if (v === undefined) v = (w.ai[slot.kind] as (r: unknown) => unknown)(slot.req);
  slot.value = v;
  slot.state = 'ready';
  slot.readyTick = -1;
  if (!slot.free) w.dec.waiting--;
  emit(w, { type: 'decisionResolved', id: slot.id, decision: slot.kind, side: slot.side });
}

/** Answer a question that a provider deferred with `PENDING`. Returns false if `id` is not waiting. */
export function resolveDecision(w: World, id: number, value: unknown): boolean {
  const slot = w.dec.byId.get(id);
  if (!slot || slot.state !== 'wait') return false;
  settle(w, slot, value);
  return true;
}

export function pendingDecisions(w: World): DecisionRequest[] {
  return [...w.dec.slots.values()].filter((s) => s.state === 'wait').map((s) => s.req);
}

/** Drop unanswered questions that no longer apply (used when the situation they were about is gone). */
export function forget(w: World, prefix: string): void {
  for (const [k, s] of w.dec.slots) {
    if (!k.startsWith(prefix)) continue;
    if (s.state === 'wait' && !s.free) w.dec.waiting--;
    w.dec.slots.delete(k);
    w.dec.byId.delete(s.id);
  }
}

export type { FullDecisionProvider };

/**
 * The booth's memory of what it has said, across games: every template, story, anecdote and joke it picks is stamped, and the next pick prefers the
 * ones heard longest ago (never-heard first), so a listener who watches game after game hears the whole pool before the same words come round again.
 * Keys are the template strings themselves (before the names are filled in), hashed: "Here comes Smith" and "Here comes Jones" are the same line to
 * the ear, and a template keeps its key when other lines are added around it.
 *
 * The app keeps one memory for the whole visit and saves it in localStorage (`sharedMemory()`), because every game gets a fresh booth; tests and
 * tools use a plain `new BoothMemory()`. Without a memory the grammar picks at random, as it always did (seeded tests stay deterministic).
 */
export interface MemoryStore {
  load(): string | null;
  save(s: string): void;
}

const fnv = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
};

export class BoothMemory {
  /** key hash -> the use counter when it was last picked */
  private last = new Map<string, number>();
  private tick = 0;
  /** games begun with this memory */
  games = 0;
  private dirty = 0;

  constructor(private store: MemoryStore | null = null, private cap = 5000) {
    try {
      const raw = store?.load();
      if (raw) {
        const o = JSON.parse(raw) as { t?: number; g?: number; k?: [string, number][] };
        this.tick = Number(o.t) || 0;
        this.games = Number(o.g) || 0;
        for (const [k, v] of o.k ?? []) if (typeof k === 'string' && typeof v === 'number') this.last.set(k, v);
      }
    } catch {
      /* a broken store starts fresh */
    }
  }

  /** a new game starts (the booth calls it when it is given the memory) */
  beginGame() {
    this.games++;
    this.save();
  }

  /** uses since the key was last picked (Infinity: never) */
  age(key: string): number {
    const v = this.last.get(fnv(key));
    return v === undefined ? Infinity : this.tick - v;
  }

  use(key: string) {
    const h = fnv(key);
    this.last.delete(h); // (re-inserted last: the map stays in use order, so the cap drops the oldest)
    this.last.set(h, ++this.tick);
    if (this.last.size > this.cap) this.last.delete(this.last.keys().next().value!);
    if (++this.dirty >= 150) this.save();
  }

  /**
   * The order to try `keys` in: the never-heard ones first (shuffled), then the rest from the longest ago; the freshest third is shuffled among itself
   * so a pool of five does not turn into a fixed rotation. Returns indexes into `keys`.
   */
  order(keys: readonly string[], rng: () => number): number[] {
    const idx = keys.map((k, i) => ({ i, age: this.age(k), r: rng() }));
    const fresh = idx.filter((x) => x.age === Infinity).sort((a, b) => a.r - b.r);
    const heard = idx.filter((x) => x.age !== Infinity).sort((a, b) => b.age - a.age);
    const top = Math.max(1, Math.ceil(heard.length / 3));
    const head = heard.slice(0, top).sort((a, b) => a.r - b.r);
    return [...fresh, ...head, ...heard.slice(top)].map((x) => x.i);
  }

  /** pick one of `items` by `key(item)`, preferring the least recently heard, and stamp it */
  pick<T>(items: readonly T[], key: (x: T) => string, rng: () => number): T | undefined {
    if (!items.length) return undefined;
    const i = this.order(items.map(key), rng)[0];
    this.use(key(items[i]));
    return items[i];
  }

  save() {
    this.dirty = 0;
    if (!this.store) return;
    try {
      this.store.save(JSON.stringify({ t: this.tick, g: this.games, k: [...this.last.entries()] }));
    } catch {
      /* storage full or blocked: the memory still works for this visit */
    }
  }
}

const KEY = 'claudeball.booth.memory.v1';
let shared: BoothMemory | null = null;

/** the memory for this visit, kept in localStorage between visits (in-memory when storage is unavailable) */
export function sharedMemory(): BoothMemory {
  if (shared) return shared;
  let store: MemoryStore | null = null;
  try {
    if (typeof localStorage !== 'undefined') store = { load: () => localStorage.getItem(KEY), save: (s) => localStorage.setItem(KEY, s) };
  } catch {
    store = null;
  }
  return (shared = new BoothMemory(store));
}

// ---- the memory the grammar consults while the booth is choosing words ---------------------------------------------------------------------

let active: BoothMemory | null = null;

/** run `fn` with `mem` as the memory every `say()` / `pickFresh()` inside it consults (the booth wraps its own work in this) */
export function withMemory<T>(mem: BoothMemory | null, fn: () => T): T {
  const prev = active;
  active = mem;
  try {
    return fn();
  } finally {
    active = prev;
  }
}

export const activeMemory = () => active;

/** pick one string: the least recently heard when a memory is active, else at random (the old behaviour, same rng use) */
export function pickFresh(r: () => number, a: readonly string[]): string {
  if (active && a.length > 1) return active.pick(a, (x) => x, r)!;
  if (active && a.length === 1) active.use(a[0]);
  return a[Math.floor(r() * a.length)];
}

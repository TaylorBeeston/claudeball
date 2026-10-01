/**
 * The player's settings and the match setup, plus everything that turns URL parameters and saved preferences into them.
 * No DOM access here: storage and the query string are passed in, so it is unit-tested (`settings.test.ts`).
 *
 * Priority for every setting: URL parameter > saved preference (localStorage) > default. The match (seed, teams) is never saved:
 * a new visit is a new game, unless the link carries `?seed=`.
 */
import type { QualityName } from '../engine/quality';

export type TimeOfDay = 'day' | 'dusk' | 'night';
export type QualityChoice = 'auto' | QualityName;
export type Chatter = 'low' | 'normal' | 'high';

export interface GameSettings {
  quality: QualityChoice;
  tod: TimeOfDay;
  /** regulation innings (9 / 3 / 1 in the menu, any 1-9 by URL) */
  innings: number;
  camera: 'auto' | 'free';
  replays: boolean;
  /** default sim speed */
  speed: 1 | 2 | 4;
  /** broadcast HUD (scorebug, cards, pitch tracker, ticker) */
  hud: boolean;
  /** start with the box score open */
  box: boolean;
  /** how much the commentators say */
  chatter: Chatter;
}

export interface MatchSetup {
  seed: number;
  /** club index in the league (`clubs.ts`), or -1: the teams the seed itself produces */
  away: number;
  home: number;
}

export interface UrlFlags {
  /** skip the menu and start playing at once */
  autostart: boolean;
  /** `?menu=1`: show the menu even for automation */
  forceMenu: boolean;
  mock: boolean;
  noassets: boolean;
  noaudio: boolean;
  nopost: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  quality: 'auto',
  tod: 'day',
  innings: 9,
  camera: 'auto',
  replays: true,
  speed: 1,
  hud: true,
  box: false,
  chatter: 'normal',
};

/** The seed the game has always used when none is given: automation (and tests, other threads' scripts) rely on it being fixed. */
export const LEGACY_SEED = 20260928;
export const CLUB_COUNT = 30;
export const STORAGE_KEY = 'claudeball.settings.v1';

export const QUALITY_CHOICES: QualityChoice[] = ['auto', 'low', 'medium', 'high', 'ultra'];
export const TODS: TimeOfDay[] = ['day', 'dusk', 'night'];
export const GAME_LENGTHS = [9, 3, 1];

const oneOf = <T extends string | number>(v: unknown, list: readonly T[]): T | undefined => (list as readonly unknown[]).includes(v) ? (v as T) : undefined;

/** Validate a loose object (parsed JSON) into a partial settings object: unknown or malformed fields are dropped. */
export function sanitize(o: unknown): Partial<GameSettings> {
  const r: Partial<GameSettings> = {};
  if (!o || typeof o !== 'object') return r;
  const x = o as Record<string, unknown>;
  const q = oneOf(x.quality, QUALITY_CHOICES);
  if (q) r.quality = q;
  const t = oneOf(x.tod, TODS);
  if (t) r.tod = t;
  if (typeof x.innings === 'number' && Number.isInteger(x.innings) && x.innings >= 1 && x.innings <= 9) r.innings = x.innings;
  const c = oneOf(x.camera, ['auto', 'free'] as const);
  if (c) r.camera = c;
  if (typeof x.replays === 'boolean') r.replays = x.replays;
  const sp = oneOf(x.speed, [1, 2, 4] as const);
  if (sp) r.speed = sp;
  if (typeof x.hud === 'boolean') r.hud = x.hud;
  if (typeof x.box === 'boolean') r.box = x.box;
  const ch = oneOf(x.chatter, ['low', 'normal', 'high'] as const);
  if (ch) r.chatter = ch;
  return r;
}

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem' | 'removeItem'>;

/** Saved preferences; storage may be null, empty, corrupt or throw (private windows): then there is simply nothing saved. */
export function loadSaved(storage: Reader | null): Partial<GameSettings> {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveSettings(storage: Writer | null, s: GameSettings): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(s));
    return !!storage;
  } catch {
    return false;
  }
}

export function clearSaved(storage: Writer | null) {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

const truthy = (v: string | null) => v !== null && !['0', 'false', 'off', 'no'].includes(v.toLowerCase());
const falsy = (v: string | null) => v !== null && ['0', 'false', 'off', 'no'].includes(v.toLowerCase());

/** A seed from the link: digits stay numbers, any other text is hashed (FNV-1a), so `?seed=derby` is a stable shareable game. */
export function seedFromText(text: string): number {
  const t = text.trim();
  if (/^-?\d{1,15}$/.test(t)) return Math.abs(Number(t)) % 2147483647 || 1;
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
  return (h % 2147483646) + 1;
}

/** Club from `?away=` / `?home=`: a league index 0-29 or a three-letter abbreviation (the clubs list resolves those). */
export function clubFromParam(v: string, abbrs: readonly string[]): number | undefined {
  const t = v.trim();
  if (t.toLowerCase() === 'auto') return -1;
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 0 && n < CLUB_COUNT ? n : undefined;
  }
  const i = abbrs.findIndex((a) => a.toLowerCase() === t.toLowerCase());
  return i >= 0 ? i : undefined;
}

export interface ParsedParams {
  settings: Partial<GameSettings>;
  match: Partial<MatchSetup>;
  flags: UrlFlags;
  /** the parameter names that were present and understood (the menu shows "set by link" for these) */
  fromUrl: Set<string>;
}

export function parseParams(search: string, abbrs: readonly string[] = []): ParsedParams {
  const q = new URLSearchParams(search);
  const fromUrl = new Set<string>();
  const settings: Partial<GameSettings> = {};
  const match: Partial<MatchSetup> = {};
  const take = (k: string, fn: (v: string) => boolean) => {
    const v = q.get(k);
    if (v !== null && fn(v)) fromUrl.add(k);
  };
  take('quality', (v) => ((settings.quality = oneOf(v.toLowerCase(), QUALITY_CHOICES)) !== undefined));
  take('tod', (v) => ((settings.tod = oneOf(v.toLowerCase(), TODS)) !== undefined));
  take('innings', (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 9) return false;
    settings.innings = n;
    return true;
  });
  take('camera', (v) => ((settings.camera = oneOf(v.toLowerCase(), ['auto', 'free'] as const)) !== undefined));
  take('replays', (v) => ((settings.replays = !falsy(v)), true));
  take('speed', (v) => ((settings.speed = oneOf(Number(v), [1, 2, 4] as const)) !== undefined));
  take('hud', (v) => ((settings.hud = !falsy(v)), true));
  take('box', (v) => ((settings.box = truthy(v) || v === ''), true));
  take('chatter', (v) => ((settings.chatter = oneOf(v.toLowerCase(), ['low', 'normal', 'high'] as const)) !== undefined));
  for (const k of Object.keys(settings) as (keyof GameSettings)[]) if (settings[k] === undefined) delete settings[k];
  take('seed', (v) => v.trim() !== '' && ((match.seed = seedFromText(v)), true));
  take('away', (v) => (match.away = clubFromParam(v, abbrs)) !== undefined);
  take('home', (v) => (match.home = clubFromParam(v, abbrs)) !== undefined);
  for (const k of ['away', 'home'] as const) if (match[k] === undefined) delete match[k];
  const menu = q.get('menu');
  const flags: UrlFlags = {
    autostart: q.has('autostart') ? !falsy(q.get('autostart')) : falsy(menu),
    forceMenu: truthy(menu) || menu === '',
    mock: q.has('mock'),
    noassets: q.has('noassets'),
    noaudio: q.has('noaudio'),
    nopost: q.has('nopost'),
  };
  return { settings, match, flags, fromUrl };
}

/**
 * Whether to skip the menu. `?autostart` / `?menu=0` skip it, `?menu=1` shows it; with neither, automation (`navigator.webdriver`:
 * Playwright, Puppeteer, Selenium) skips it, so scripts written before the menu existed keep working, and people see the menu.
 */
export function shouldAutostart(flags: UrlFlags, webdriver: boolean): boolean {
  if (flags.forceMenu) return false;
  return flags.autostart || webdriver;
}

/** Fixed default seed for automation (reproducible), a fresh one for people. */
export function defaultSeed(automation: boolean, rnd: () => number = Math.random): number {
  return automation ? LEGACY_SEED : 1 + Math.floor(rnd() * 999_999);
}

export interface Resolved {
  settings: GameSettings;
  match: MatchSetup;
  flags: UrlFlags;
  autostart: boolean;
  fromUrl: Set<string>;
}

/** URL > saved > defaults. */
export function resolve(search: string, storage: Reader | null, webdriver: boolean, abbrs: readonly string[] = [], rnd: () => number = Math.random): Resolved {
  const p = parseParams(search, abbrs);
  const settings: GameSettings = { ...DEFAULT_SETTINGS, ...loadSaved(storage), ...p.settings };
  const autostart = shouldAutostart(p.flags, webdriver);
  const match: MatchSetup = { seed: p.match.seed ?? defaultSeed(autostart, rnd), away: p.match.away ?? -1, home: p.match.home ?? -1 };
  return { settings, match, flags: p.flags, autostart, fromUrl: p.fromUrl };
}

/** A link that reproduces this match and the look of the game; only what differs from the defaults is included. */
export function shareQuery(match: MatchSetup, s: GameSettings, abbrs: readonly string[] = []): string {
  const q = new URLSearchParams();
  q.set('seed', String(match.seed));
  const club = (i: number) => (i >= 0 ? abbrs[i] ?? String(i) : null);
  const a = club(match.away), h = club(match.home);
  if (a) q.set('away', a);
  if (h) q.set('home', h);
  if (s.innings !== DEFAULT_SETTINGS.innings) q.set('innings', String(s.innings));
  if (s.tod !== DEFAULT_SETTINGS.tod) q.set('tod', s.tod);
  return q.toString();
}

/** Short label for the menu: "9 innings". */
export const inningsLabel = (n: number) => `${n} inning${n === 1 ? '' : 's'}`;

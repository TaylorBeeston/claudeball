/**
 * Park music: which tracks exist and what each trigger means. The tracks are optional files in `public/audio/music/` described by
 * `manifest.json` (written by `npm run audio:music:index`); with no files the game plays its synthesised organ stingers instead.
 * Pure: shared by the runtime, the indexing script and the tests.
 */
export type Trigger = 'runScored' | 'homeRun' | 'rally' | 'walkUp' | 'inningBreak' | 'pitchingChange' | 'gameStart' | 'finalWin' | 'finalLoss';

export interface TriggerInfo {
  /** a higher priority cuts a lower one; a lower one never cuts a higher one that is playing */
  pri: number;
  /** wanted length in seconds [min, max] (the indexing script warns outside this) */
  dur: [number, number];
  /** a loop: it plays until the break ends (the file must end cleanly into its own start) */
  loop: boolean;
  /** seconds before the same trigger may fire again */
  cooldown: number;
  /** how many variants the brief asks for */
  variants: number;
  /** the organ stinger that plays when there is no file for it */
  organ?: string;
  what: string;
}

export const TRIGGERS: Record<Trigger, TriggerInfo> = {
  homeRun: { pri: 90, dur: [15, 25], loop: false, cooldown: 20, variants: 3, organ: 'hr_fanfare', what: 'the home team hits a home run: a celebration' },
  rally: { pri: 70, dur: [15, 20], loop: false, cooldown: 45, variants: 3, organ: 'rally', what: 'the home team scores 2+ runs in an inning, or a big hit with runners on' },
  runScored: { pri: 60, dur: [6, 10], loop: false, cooldown: 10, variants: 4, organ: 'charge', what: 'the home team scores a run: a stinger' },
  gameStart: { pri: 55, dur: [18, 24], loop: false, cooldown: 0, variants: 2, organ: 'ditty', what: 'pregame hype as the game starts' },
  pitchingChange: { pri: 40, dur: [10, 15], loop: false, cooldown: 20, variants: 2, what: 'a pitching change: the reliever walks in' },
  walkUp: { pri: 30, dur: [12, 20], loop: false, cooldown: 0, variants: 6, organ: 'walk_up', what: 'the home batter walks up to the plate (cut at the windup)' },
  inningBreak: { pri: 20, dur: [60, 90], loop: true, cooldown: 0, variants: 4, organ: 'bed', what: 'the break between innings, low under the crowd (cut when the next batter is called)' },
  finalWin: { pri: 100, dur: [18, 24], loop: false, cooldown: 0, variants: 2, organ: 'hr_fanfare', what: 'the home team wins' },
  finalLoss: { pri: 100, dur: [6, 12], loop: false, cooldown: 0, variants: 1, organ: 'dirge', what: 'the home team loses: short, somber or neutral' },
};

export const TRIGGER_IDS = Object.keys(TRIGGERS) as Trigger[];

export interface TrackInfo {
  /** `<trigger>-<n>` */
  id: string;
  file: string;
  trigger: Trigger;
  /** relative chance among the variants of its trigger */
  weight: number;
  durationMs: number;
  loop: boolean;
  /** per-track level, 0..2 (1 = as mastered) */
  gain: number;
  channels?: number;
}

export interface MusicManifest {
  version: 1;
  tracks: TrackInfo[];
}

export const EMPTY_MANIFEST: MusicManifest = { version: 1, tracks: [] };

/** `homeRun-2.ogg` -> { trigger: 'homeRun', n: 2 } */
export function parseFileName(file: string): { trigger: Trigger; n: number; ext: string } | null {
  const m = /^([A-Za-z]+)-(\d+)\.(ogg|mp3|m4a|opus|wav)$/.exec(file);
  if (!m || !(m[1] in TRIGGERS)) return null;
  return { trigger: m[1] as Trigger, n: Number(m[2]), ext: m[3] };
}

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Validate whatever came over the network: unknown triggers, bad numbers and duplicates are dropped, never thrown on. */
export function parseManifest(json: unknown): MusicManifest {
  const tracks: TrackInfo[] = [];
  const seen = new Set<string>();
  const list = (json as { tracks?: unknown } | null)?.tracks;
  if (!Array.isArray(list)) return { version: 1, tracks };
  for (const t of list as Record<string, unknown>[]) {
    if (!t || typeof t.file !== 'string' || typeof t.trigger !== 'string' || !(t.trigger in TRIGGERS)) continue;
    if (t.file.includes('..') || t.file.startsWith('/') || /^[a-z]+:/i.test(t.file)) continue; // files live in the music folder
    const trigger = t.trigger as Trigger;
    const id = typeof t.id === 'string' ? t.id : t.file.replace(/\.[a-z0-9]+$/i, '');
    if (seen.has(id)) continue;
    seen.add(id);
    tracks.push({
      id,
      file: t.file,
      trigger,
      weight: num(t.weight, 1, 0.01, 100),
      durationMs: num(t.durationMs, 0, 0, 10 * 60 * 1000),
      loop: typeof t.loop === 'boolean' ? t.loop : TRIGGERS[trigger].loop,
      gain: num(t.gain, 1, 0, 2),
      channels: typeof t.channels === 'number' ? t.channels : undefined,
    });
  }
  return { version: 1, tracks };
}

/** a weighted random variant of a trigger, avoiding the ones played last (unless it is the only one) */
export function pickTrack(tracks: TrackInfo[], trigger: Trigger, rng: () => number, recent: string[] = []): TrackInfo | null {
  const all = tracks.filter((t) => t.trigger === trigger);
  if (!all.length) return null;
  let pool = all.filter((t) => !recent.includes(t.id));
  if (!pool.length) pool = all.filter((t) => t.id !== recent[recent.length - 1]);
  if (!pool.length) pool = all;
  const total = pool.reduce((a, t) => a + t.weight, 0);
  let x = rng() * total;
  for (const t of pool) {
    x -= t.weight;
    if (x <= 0) return t;
  }
  return pool[pool.length - 1];
}

export interface TrackFacts {
  file: string;
  bytes: number;
  durationMs: number;
  channels?: number;
  sampleRate?: number;
}

export interface IndexReport {
  manifest: MusicManifest;
  warnings: string[];
}

export const MAX_FILE_BYTES = 1.2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 14 * 1024 * 1024;

/**
 * Build the manifest from the facts about the files in the folder (the script measures them), keeping what the owner tuned by hand in
 * the previous manifest (`gain`, `weight`, `loop`), and say what looks wrong.
 */
export function buildManifest(files: TrackFacts[], previous?: MusicManifest): IndexReport {
  const warnings: string[] = [];
  const prev = new Map((previous?.tracks ?? []).map((t) => [t.file, t]));
  const tracks: TrackInfo[] = [];
  let total = 0;
  for (const f of [...files].sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }))) {
    const p = parseFileName(f.file);
    if (!p) {
      warnings.push(`${f.file}: not named <trigger>-<n>.ogg (triggers: ${TRIGGER_IDS.join(', ')}): skipped`);
      continue;
    }
    const info = TRIGGERS[p.trigger];
    const old = prev.get(f.file);
    const sec = f.durationMs / 1000;
    if (sec < info.dur[0] * 0.6 || sec > info.dur[1] * 1.4) warnings.push(`${f.file}: ${sec.toFixed(1)} s, wanted ${info.dur[0]}-${info.dur[1]} s for ${p.trigger}`);
    if (f.bytes > MAX_FILE_BYTES) warnings.push(`${f.file}: ${(f.bytes / 1048576).toFixed(2)} MB, over the ${(MAX_FILE_BYTES / 1048576).toFixed(1)} MB limit`);
    if (f.sampleRate && f.sampleRate !== 44100) warnings.push(`${f.file}: ${f.sampleRate} Hz (44100 expected)`);
    if (f.channels && f.channels > 2) warnings.push(`${f.file}: ${f.channels} channels (stereo or mono expected)`);
    total += f.bytes;
    tracks.push({
      id: `${p.trigger}-${p.n}`,
      file: f.file,
      trigger: p.trigger,
      weight: old?.weight ?? 1,
      durationMs: Math.round(f.durationMs),
      loop: old?.loop ?? info.loop,
      gain: old?.gain ?? 1,
      ...(f.channels ? { channels: f.channels } : {}),
    });
  }
  if (total > MAX_TOTAL_BYTES) warnings.push(`total ${(total / 1048576).toFixed(1)} MB, over the ${(MAX_TOTAL_BYTES / 1048576).toFixed(0)} MB budget`);
  for (const t of TRIGGER_IDS) {
    const n = tracks.filter((x) => x.trigger === t).length;
    if (n === 0) warnings.push(`${t}: no track (the organ stinger plays instead)`);
    else if (n < TRIGGERS[t].variants) warnings.push(`${t}: ${n} of ${TRIGGERS[t].variants} wanted variants`);
  }
  return { manifest: { version: 1, tracks }, warnings };
}

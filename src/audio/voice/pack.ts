/**
 * The "voice pack": what `npm run announcer:export` writes (voice.json + model .onnx files) and the game loads for the opt-in
 * "My voice (custom announcer)". Nothing here is bundled with the game: the pack lives on the owner's disk or on a host they choose.
 */
import type { PhonemeIdMap } from './phonemize';

export type ModelKind = 'fp32' | 'fp16w' | 'int8' | 'fp16';
export type StyleName = 'calm' | 'building' | 'excited' | 'peak' | 'deadpan' | 'crisp' | 'deflated';
export type Role = 'pa' | 'ump' | 'pbp' | 'color';

export interface VoiceManifest {
  format: 1;
  name: string;
  /** ISO time of the export: part of the cache key so a re-exported pack is downloaded again */
  built?: string;
  sampleRate: number;
  models: Partial<Record<ModelKind, { file: string; bytes: number }>>;
  default: ModelKind;
  /** speaker name -> model speaker id; null for a single-voice model */
  speakers: Record<string, number> | null;
  /** style -> speaker name */
  styleSpeaker: Record<string, string> | null;
  scales: { noise: number; length: number; noiseW: number };
  phonemeIdMap: PhonemeIdMap;
  lexicon: Record<string, number[]>;
  attribution?: string;
  /** optional bank of the owner's own recordings (clips/index.json relative to voice.json), played for lines it covers exactly */
  clips?: { index: string };
  /** where to get onnxruntime-web from (default: pinned jsDelivr URL) */
  runtime?: { ortUrl?: string };
}

export const DEFAULT_ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Validate a parsed voice.json; throws an Error whose message tells the user what is wrong with the file. */
export function parseManifest(x: unknown): VoiceManifest {
  if (!isObj(x)) throw new Error('voice.json is not a JSON object');
  if (x.format !== 1) throw new Error(`voice.json format ${String(x.format)} is not supported (this game reads format 1)`);
  if (!isObj(x.models) || !Object.keys(x.models).length) throw new Error('voice.json lists no model files');
  const def = x.default as ModelKind;
  if (!isObj(x.models) || !isObj((x.models as Record<string, unknown>)[def]) || typeof ((x.models as Record<string, Record<string, unknown>>)[def]).file !== 'string') throw new Error('voice.json "default" does not point at a listed model');
  if (typeof x.sampleRate !== 'number' || x.sampleRate < 8000) throw new Error('voice.json has no valid sampleRate');
  const idmap = x.phonemeIdMap;
  if (!isObj(idmap) || !['_', '^', '$', ' '].every((k) => Array.isArray(idmap[k]))) throw new Error('voice.json phonemeIdMap is missing the pad/start/end/space symbols');
  if (!isObj(x.lexicon) || !Object.keys(x.lexicon).length) throw new Error('voice.json has an empty lexicon');
  const sc = isObj(x.scales) ? x.scales : {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    format: 1,
    name: typeof x.name === 'string' ? x.name : 'My voice',
    built: typeof x.built === 'string' ? x.built : undefined,
    sampleRate: x.sampleRate,
    models: x.models as VoiceManifest['models'],
    default: def,
    speakers: isObj(x.speakers) ? (x.speakers as Record<string, number>) : null,
    styleSpeaker: isObj(x.styleSpeaker) ? (x.styleSpeaker as Record<string, string>) : null,
    scales: { noise: num(sc.noise, 0.667), length: num(sc.length, 1), noiseW: num(sc.noiseW, 0.8) },
    phonemeIdMap: idmap as PhonemeIdMap,
    lexicon: x.lexicon as Record<string, number[]>,
    attribution: typeof x.attribution === 'string' ? x.attribution : undefined,
    clips: isObj(x.clips) && typeof x.clips.index === 'string' ? { index: x.clips.index } : undefined,
    runtime: isObj(x.runtime) ? (x.runtime as { ortUrl?: string }) : undefined,
  };
}

const PEAK_WORDS = /\b(gone|outta here|out of here|walk-?off|robbed|unbelievable|going, going|see you later|grand slam|home run)\b/i;
const DEFLATED_WORDS = /\b(shame|hurts|just missed|stranded|costly|sting|booted|dies|too bad|oh no)\b/i;

/**
 * Which delivery to use for a line, from what the game knows: who is speaking, how loud the ballpark is (the crowd excitement,
 * 0..1) and the line itself. The PA and umpire are crisp, the colour commentator deadpan; the play-by-play man rises with the crowd.
 */
export function chooseStyle(role: Role, text: string, excitement: number): StyleName {
  if (role === 'pa' || role === 'ump') return 'crisp';
  if (DEFLATED_WORDS.test(text)) return 'deflated';
  if (role === 'color') return 'deadpan';
  const bangs = (text.match(/!/g) ?? []).length;
  if (PEAK_WORDS.test(text) && (bangs > 0 || excitement > 0.6)) return 'peak';
  if (excitement > 0.75 && bangs > 0) return 'peak';
  if (bangs > 0 || excitement > 0.55) return 'excited';
  if (excitement > 0.3) return 'building';
  return 'calm';
}

/** Model speaker id for a style, or undefined for a single-voice model (or a pack without that character). */
export function speakerFor(m: VoiceManifest, style: StyleName): number | undefined {
  if (!m.speakers || !m.styleSpeaker) return undefined;
  const name = m.styleSpeaker[style];
  const id = name !== undefined ? m.speakers[name] : undefined;
  return id ?? Object.values(m.speakers)[0];
}

// ---- loading ------------------------------------------------------------------------------------------------------------------

export interface LoadedPack {
  manifest: VoiceManifest;
  model: ArrayBuffer;
  /** where it came from, for the settings */
  source: { kind: 'url'; url: string } | { kind: 'files'; names: string[] };
  /** absolute URL of voice.json for URL packs (clips resolve against it) */
  manifestUrl?: string;
}

export type Progress = (loaded: number, total: number) => void;

const CACHE_NAME = 'claudeball-voice-pack';
const LOCAL_BASE = 'https://claudeball.local/voice-pack/';

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** `https://host/path/` or `https://host/path/voice.json` -> the voice.json URL. */
export function manifestUrlOf(input: string): string {
  const u = new URL(input.trim(), typeof location !== 'undefined' ? location.href : undefined);
  if (!/\.json$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, '/') + 'voice.json';
  return u.toString();
}

async function fetchWithProgress(url: string, onProgress?: Progress, f: typeof fetch = fetch): Promise<ArrayBuffer> {
  const r = await f(url, { cache: 'force-cache' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !onProgress) return r.arrayBuffer();
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total || loaded);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

/** Load a pack from a URL (CORS-enabled host such as a Hugging Face model repo or a GitHub release), cached in the browser Cache API. */
export async function loadPackFromUrl(input: string, onProgress?: Progress, f: typeof fetch = fetch): Promise<LoadedPack> {
  const mUrl = manifestUrlOf(input);
  let manifest: VoiceManifest;
  try {
    const r = await f(mUrl, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    manifest = parseManifest(await r.json());
  } catch (e) {
    throw new Error(`could not read ${mUrl}: ${(e as Error).message}. The host must allow cross-origin requests (CORS).`);
  }
  const file = manifest.models[manifest.default]!.file;
  const modelUrl = new URL(file, mUrl).toString();
  const key = `${modelUrl}#${manifest.built ?? manifest.models[manifest.default]!.bytes}`;
  const cache = await openCache();
  const hit = await cache?.match(key);
  if (hit) return { manifest, model: await hit.arrayBuffer(), source: { kind: 'url', url: input }, manifestUrl: mUrl };
  const model = await fetchWithProgress(modelUrl, onProgress, f);
  try {
    await cache?.put(key, new Response(model.slice(0)));
  } catch {
    /* storage full or blocked: it just downloads again next time */
  }
  return { manifest, model, source: { kind: 'url', url: input }, manifestUrl: mUrl };
}

/** Load a pack from files the user picked (voice.json + the model .onnx), and remember it in the Cache API for next time. */
export async function loadPackFromFiles(files: File[]): Promise<LoadedPack> {
  const json = files.find((f) => /\.json$/i.test(f.name) && !/\.onnx\.json$/i.test(f.name));
  if (!json) throw new Error('pick voice.json together with the model file (model.onnx / model.int8.onnx)');
  const manifest = parseManifest(JSON.parse(await json.text()));
  const want = manifest.models[manifest.default]!.file.split('/').pop()!;
  const onnx = files.find((f) => f.name === want) ?? files.find((f) => /\.onnx$/i.test(f.name));
  if (!onnx) throw new Error(`pick the model file too (${want})`);
  const model = await onnx.arrayBuffer();
  const cache = await openCache();
  try {
    await cache?.put(LOCAL_BASE + 'voice.json', new Response(JSON.stringify(manifest)));
    await cache?.put(LOCAL_BASE + 'model.onnx', new Response(model.slice(0)));
  } catch {
    /* not persisted */
  }
  return { manifest, model, source: { kind: 'files', names: files.map((f) => f.name) } };
}

/** The pack saved from local files, if any. */
export async function loadSavedLocalPack(): Promise<LoadedPack | null> {
  const cache = await openCache();
  const m = await cache?.match(LOCAL_BASE + 'voice.json');
  const b = await cache?.match(LOCAL_BASE + 'model.onnx');
  if (!m || !b) return null;
  return { manifest: parseManifest(await m.json()), model: await b.arrayBuffer(), source: { kind: 'files', names: ['saved local pack'] } };
}

export async function forgetPack(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
  } catch {
    /* ignore */
  }
}

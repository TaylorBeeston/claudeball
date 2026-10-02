/**
 * Scan public/audio/music/ and write manifest.json (`npm run audio:music:index`).
 * Durations come from `ffprobe` when it is installed, else from the Ogg Vorbis / Opus headers (no dependency). Hand-tuned `gain`,
 * `weight` and `loop` of the previous manifest are kept. Warns about sizes (<= 1.2 MB each, <= 14 MB in all), lengths, names, sample rate
 * and missing variants. Exit code 0 even with warnings.
 *   npm run audio:music:index [-- --dir public/audio/music]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildManifest, parseManifest, type TrackFacts } from '../src/audio/park/manifest';

const argDir = process.argv.indexOf('--dir');
const dir = resolve(argDir > 0 ? process.argv[argDir + 1] : 'public/audio/music');

/** duration, channels and sample rate of an Ogg Vorbis or Opus file, from the first and last pages */
export function oggFacts(buf: Buffer): { durationMs: number; channels?: number; sampleRate?: number } | null {
  if (buf.length < 64 || buf.toString('latin1', 0, 4) !== 'OggS') return null;
  // the first page holds the identification header
  const segs = buf[26];
  const hdr = 27 + segs;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let opus = false;
  if (buf.toString('latin1', hdr + 1, hdr + 7) === 'vorbis') {
    channels = buf[hdr + 11];
    sampleRate = buf.readUInt32LE(hdr + 12);
  } else if (buf.toString('latin1', hdr, hdr + 8) === 'OpusHead') {
    opus = true;
    channels = buf[hdr + 9];
    sampleRate = 48000;
  } else return null;
  // the last page's granule position is the total sample count
  let last = -1;
  for (let i = buf.length - 14; i >= 0; i--) {
    if (buf[i] === 0x4f && buf.toString('latin1', i, i + 4) === 'OggS') {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const granule = Number(buf.readBigUInt64LE(last + 6));
  if (!sampleRate || granule <= 0) return null;
  const preSkip = opus ? buf.readUInt16LE(hdr + 10) : 0;
  return { durationMs: Math.round(((granule - preSkip) / sampleRate) * 1000), channels, sampleRate };
}

function ffprobe(path: string): { durationMs: number; channels?: number; sampleRate?: number } | null {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string; channels?: number; sample_rate?: string }[] };
    const a = j.streams?.find((s) => s.codec_type === 'audio');
    const d = Number(j.format?.duration);
    if (!Number.isFinite(d)) return null;
    return { durationMs: Math.round(d * 1000), channels: a?.channels, sampleRate: a?.sample_rate ? Number(a.sample_rate) : undefined };
  } catch {
    return null;
  }
}

function main() {
  if (!existsSync(dir)) {
    console.error(`no folder ${dir}`);
    process.exit(1);
  }
  const files: TrackFacts[] = [];
  const warnings: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /\.(ogg|mp3|m4a|opus|wav)$/i.test(x))) {
    const path = join(dir, f);
    const bytes = statSync(path).size;
    let facts = ffprobe(path);
    if (!facts && /\.(ogg|opus)$/i.test(f)) facts = oggFacts(readFileSync(path));
    if (!facts) {
      warnings.push(`${f}: could not read its length (install ffprobe, or use .ogg): skipped`);
      continue;
    }
    files.push({ file: f, bytes, ...facts });
  }
  const mpath = join(dir, 'manifest.json');
  let previous;
  try {
    previous = parseManifest(JSON.parse(readFileSync(mpath, 'utf8')));
  } catch {
    previous = undefined;
  }
  const r = buildManifest(files, previous);
  writeFileSync(mpath, JSON.stringify(r.manifest, null, 2) + '\n');
  const total = files.reduce((a, f) => a + f.bytes, 0);
  console.log(`${r.manifest.tracks.length} tracks, ${(total / 1048576).toFixed(1)} MB -> ${mpath}`);
  for (const t of r.manifest.tracks) console.log(`  ${t.id.padEnd(18)} ${(t.durationMs / 1000).toFixed(1).padStart(5)} s  gain ${t.gain}  weight ${t.weight}${t.loop ? '  loop' : ''}`);
  for (const w of [...warnings, ...r.warnings]) console.warn(`warning: ${w}`);
}

if (process.argv[1] && /music-index/.test(process.argv[1])) main();

/**
 * The foley bank, measured and written out for listening (node only: the recipes are pure). For every sound and bucket: length, attack
 * (10 % -> 90 % of the peak envelope), decay (peak -> -20 dB), spectral centroid, loudest 25 ms RMS, peak; and the bank's memory as the
 * game keeps it (mono float32 at 48 kHz). One WAV per sound (every bucket and variant in a row, 0.4 s apart) under
 * ~/claudeball-audio-renders/foley/ (never in the repo), plus `foley-analysis.json` and a markdown table.
 *
 *   npx tsx tools/audio/foley.ts [--out DIR] [--ids mitt_pop,glove_pop]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SFX_DEFS, renderSfx } from '../../src/audio/synth';
import type { SfxId } from '../../src/audio/types';
import { bandPower, powerSpectrum } from '../../src/audio/venue/analysis';
import { writeWav } from './render';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const out = opt('out', path.join(os.homedir(), 'claudeball-audio-renders', 'foley'))!;
const only = opt('ids')?.split(',');

export interface Measure {
  ms: number;
  attackMs: number;
  decayMs: number;
  centroidHz: number;
  rmsDb: number;
  peakDb: number;
}

/** measurements of one mono sound */
export function measure(x: Float32Array, sr: number): Measure {
  // envelope: 1 ms RMS
  const w = Math.max(1, Math.round(sr * 0.001));
  const env: number[] = [];
  for (let i = 0; i + w <= x.length; i += w) {
    let a = 0;
    for (let k = i; k < i + w; k++) a += x[k] * x[k];
    env.push(Math.sqrt(a / w));
  }
  const pk = Math.max(...env, 1e-9);
  const iPk = env.indexOf(pk);
  const i10 = env.findIndex((v) => v >= pk * 0.1);
  const i90 = env.findIndex((v) => v >= pk * 0.9);
  let iDec = env.length - 1;
  for (let i = iPk; i < env.length; i++)
    if (env[i] < pk * 0.1) {
      iDec = i;
      break;
    }
  const size = 2048;
  // half a window of silence first: the attack must land mid-window (a Hann window starting at t = 0 would hide it)
  const padded = new Float32Array(Math.max(size, x.length) + size);
  padded.set(x, size / 2);
  const psd = powerSpectrum(padded, size);
  let num = 0, den = 0;
  for (let k = 1; k < psd.length; k++) {
    const f = (k * sr) / size;
    num += f * psd[k];
    den += psd[k];
  }
  const r25 = Math.round(sr * 0.025);
  let best = 0, acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] * x[i];
    if (i >= r25) acc -= x[i - r25] * x[i - r25];
    best = Math.max(best, acc / r25);
  }
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  void bandPower;
  return {
    ms: Math.round((x.length / sr) * 1000),
    attackMs: +((Math.max(0, i90 - i10) * w * 1000) / sr).toFixed(1),
    decayMs: Math.round(((iDec - iPk) * w * 1000) / sr),
    centroidHz: Math.round(num / Math.max(1e-12, den)),
    rmsDb: +(10 * Math.log10(best + 1e-12)).toFixed(1),
    peakDb: +(20 * Math.log10(peak + 1e-12)).toFixed(1),
  };
}

/** every variant of every sound: measurements, and the bytes the game's bank holds (mono float32 at `sr`) */
export function bank(sr = 48000, ids: SfxId[] = Object.keys(SFX_DEFS) as SfxId[]) {
  const rows: (Measure & { id: SfxId; bucket: number; alt: number })[] = [];
  let bytes = 0;
  const renders = new Map<SfxId, Float32Array[]>();
  for (const id of ids) {
    const d = SFX_DEFS[id];
    for (let b = 0; b < d.buckets; b++)
      for (let a = 0; a < d.alts; a++) {
        const r = renderSfx(id, b, a);
        const x = r.ch[0];
        if (!id.startsWith('bfx_')) bytes += Math.ceil((x.length * sr) / r.sr) * 4;
        else bytes += x.length * 4 * r.ch.length;
        rows.push({ id, bucket: b, alt: a, ...measure(x, r.sr) });
        const list = renders.get(id) ?? [];
        list.push(x);
        renders.set(id, list);
      }
  }
  return { rows, bytes, renders };
}

function main() {
  fs.mkdirSync(out, { recursive: true });
  const ids = (only ?? Object.keys(SFX_DEFS)) as SfxId[];
  const t0 = performance.now();
  const { rows, bytes, renders } = bank(48000, ids);
  const synthMs = Math.round(performance.now() - t0);
  for (const [id, list] of renders) {
    const gap = Math.round(0.4 * 44100);
    const n = list.reduce((a, x) => a + x.length + gap, gap);
    const y = new Float32Array(n);
    let o = gap;
    for (const x of list) {
      y.set(x, o);
      o += x.length + gap;
    }
    writeWav(path.join(out, `${id}.wav`), [y, y], 44100);
  }
  // per sound: the bucket means
  const table: string[] = ['| sound | bucket | length ms | attack ms | decay ms (-20 dB) | centroid Hz | loudest 25 ms RMS dBFS | peak dBFS |', '|---|---|---|---|---|---|---|---|'];
  for (const id of ids)
    for (let b = 0; b < SFX_DEFS[id].buckets; b++) {
      const rs = rows.filter((r) => r.id === id && r.bucket === b);
      const m = (k: keyof Measure) => +(rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(1);
      table.push(`| ${id} | ${b} | ${m('ms')} | ${m('attackMs')} | ${m('decayMs')} | ${m('centroidHz')} | ${m('rmsDb')} | ${m('peakDb')} |`);
    }
  const md = table.join('\n');
  fs.writeFileSync(path.join(out, 'foley-analysis.json'), JSON.stringify({ synthMs, bankBytes: bytes, rows }, null, 1));
  fs.writeFileSync(path.join(out, 'foley-table.md'), md + '\n');
  console.log(md);
  console.log(`\n[foley] ${rows.length} variants, bank ${(bytes / 1048576).toFixed(2)} MB (mono float32 at 48 kHz), synthesis ${synthMs} ms; WAVs in ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();

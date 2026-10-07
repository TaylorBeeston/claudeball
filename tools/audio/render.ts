/**
 * Headless render of the whole audio graph (see `harness.ts`) to WAV files plus an analysis, so the mix can be listened to later and
 * checked by numbers now. Renders go to ~/claudeball-audio-renders/ (never into the repo).
 *
 *   npx tsx tools/audio/render.ts [--tag NAME] [--out DIR] [--scenes game,impulse,duck,organ] [--venue dry|normal|big] [--lowpower]
 *                                 [--voice FILE.wav | --no-voice] [--json]
 *
 * The booth / PA lines use the first recording in ~/claudeball-voice/wavs (the owner's own voice, local only) when it exists, else a
 * synthetic speech-like signal. Output per scene: `<tag>-<scene>.wav` (24-bit stereo) and one `<tag>-analysis.json`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, ROOT, freePort, sleep } from '../perf/lib';
import { db, lufsIntegrated, loudnessRange, mono, rmsEnvelope, rt60, rt60Band, samplePeak, truePeak, bandEdges, decayCurve } from '../../src/audio/venue/analysis';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (k: string) => args.includes(`--${k}`);
const tag = opt('tag', 'render')!;
const out = opt('out', path.join(os.homedir(), 'claudeball-audio-renders'))!;
const scenes = (opt('scenes', 'game,impulse,duck,organ') ?? '').split(',').filter(Boolean);
const venue = opt('venue');
const lowPower = flag('lowpower');

function pickVoice(): string | null {
  if (flag('no-voice')) return null;
  const f = opt('voice');
  if (f) return f;
  const dir = path.join(os.homedir(), 'claudeball-voice/wavs');
  try {
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.wav')).sort();
    return files.length ? path.join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

export function writeWav(file: string, chs: Float32Array[], sr: number) {
  const n = chs[0].length;
  const nc = chs.length;
  const buf = Buffer.alloc(44 + n * nc * 3);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * nc * 3, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * nc * 3, 28);
  buf.writeUInt16LE(nc * 3, 32);
  buf.writeUInt16LE(24, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * nc * 3, 40);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < nc; c++) {
      const v = Math.max(-1, Math.min(1, chs[c][i]));
      buf.writeIntLE(Math.round(v * 8388607), o, 3);
      o += 3;
    }
  fs.writeFileSync(file, buf);
}

const fromB64 = (s: string) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
};

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const port = await freePort();
  const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/tools/audio/harness.html`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const result: Record<string, unknown> = { tag, at: new Date().toISOString(), venue: venue ?? 'default', lowPower };
  try {
    const page = await browser.newPage();
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.goto(`${base}/tools/audio/harness.html`);
    await page.waitForFunction(() => (window as unknown as { cbAudio?: unknown }).cbAudio, null, { timeout: 60000 }).catch((e) => {
      throw new Error(`harness did not load: ${errs.join(' | ')} ${e}`);
    });
    const vf = pickVoice();
    const voice = vf ? fs.readFileSync(vf).toString('base64') : null;
    result.voice = vf ? `recording (${path.basename(vf)})` : 'synthetic';
    const settings = venue ? { venue } : {};
    const run = async (o: Record<string, unknown>) =>
      page.evaluate((o) => (window as unknown as { cbAudio: { render: (o: unknown) => Promise<{ sr: number; channels: string[]; renderMs: number; seconds: number; info: Record<string, unknown> }> } }).cbAudio.render(o), o);
    for (const scene of scenes) {
      const r = await run({ scene, voice, settings, lowPower });
      const chs = r.channels.map(fromB64);
      const file = path.join(out, `${tag}-${scene}.wav`);
      writeWav(file, chs, r.sr);
      const a: Record<string, unknown> = {
        file,
        seconds: r.seconds,
        renderMs: Math.round(r.renderMs),
        msPerAudioSecond: +(r.renderMs / r.seconds).toFixed(2),
        lufs: +lufsIntegrated(chs, r.sr).toFixed(2),
        lra: +loudnessRange(chs, r.sr).toFixed(2),
        samplePeakDb: +db(samplePeak(chs)).toFixed(2),
        truePeakDb: +db(truePeak(chs)).toFixed(2),
        clipped: chs.reduce((n, c) => n + c.filter((v) => Math.abs(v) >= 0.999).length, 0),
        finite: chs.every((c) => c.every(Number.isFinite)),
        info: r.info,
      };
      if (scene === 'impulse') {
        // the click at 0.5 s and the venue's answer: decay of the rendered tail (the bat crack itself is ~0.1 s long)
        const m = mono(chs);
        const from = Math.floor(0.5 * r.sr);
        const tail = m.subarray(from);
        a.rt60Render = +rt60(tail, r.sr, 20).toFixed(2);
        const edc = decayCurve(tail);
        a.edcAt = Object.fromEntries([0.1, 0.25, 0.5, 1, 2, 3].map((t) => [t, +edc[Math.min(edc.length - 1, Math.floor(t * r.sr))].toFixed(1)]));
      }
      if (scene === 'organ' || scene === 'pa') a.band = bandEdges(mono(chs), r.sr, 12);
      if (scene === 'duck') {
        // the same scene with the booth muted into the master (its key still drives the duck) vs no booth at all: the park bus's duck
        const silent = await run({ scene, voice, settings, lowPower, boothSilent: true });
        const none = await run({ scene, voice, settings, lowPower, parts: { booth: false } });
        const es = rmsEnvelope(mono(silent.channels.map(fromB64)), r.sr, 30, 10);
        const en = rmsEnvelope(mono(none.channels.map(fromB64)), r.sr, 30, 10);
        const diff = Array.from(es, (v, i) => +(v - en[i]).toFixed(2));
        const at = (t: number) => diff[Math.min(diff.length - 1, Math.round(t * 100))];
        a.duckDb = { before: at(4.5), t5_05: at(5.05), t5_1: at(5.1), t5_3: at(5.3), t6: at(6), t7: at(7) };
        a.duckSeries = diff.filter((_, i) => i % 5 === 0);
        const minD = Math.min(...diff.slice(450, 900));
        a.duckMinDb = minD;
        a.duckSilentInfo = silent.info;
      }
      (result as Record<string, unknown>)[scene] = a;
      console.log(`[render] ${scene}: ${file}  ${a.lufs} LUFS  TP ${a.truePeakDb} dBTP  ${a.msPerAudioSecond} ms/s`);
    }
    const ir = await page.evaluate((v) => (window as unknown as { cbAudio: { venueIr: (o: unknown) => Promise<{ sr: number; channels: string[] } | null> } }).cbAudio.venueIr({ venue: v }), venue ?? 'normal');
    if (ir) {
      const chs = ir.channels.map(fromB64);
      writeWav(path.join(out, `${tag}-ir.wav`), chs, ir.sr);
      const m = mono(chs);
      result.ir = { rt60: +rt60(m, ir.sr, 30).toFixed(2), bands: Object.fromEntries([125, 250, 500, 1000, 2000, 4000, 8000].map((f) => [f, +rt60Band(m, ir.sr, f, 20).toFixed(2)])) };
    }
    result.errors = errs.slice(0, 20);
  } finally {
    await browser.close();
    vite.kill();
  }
  const jf = path.join(out, `${tag}-analysis.json`);
  fs.writeFileSync(jf, JSON.stringify(result, null, 1));
  console.log(`[render] analysis: ${jf}`);
  if (flag('json')) console.log(JSON.stringify(result, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) void main().catch((e) => (console.error(e), process.exit(1)));

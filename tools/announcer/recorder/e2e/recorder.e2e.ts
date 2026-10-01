/**
 * End-to-end check of the recorder against a fake microphone (no real mic, no real voice folder):
 *   npm run announcer:record:e2e
 * Starts the recorder in-process with CB_VOICE_DIR pointed at a temp folder, launches Chromium with a looping espeak-ng "voice" as the fake
 * audio device, and drives the page: room tone, auto-detect take, toggle take, push-to-talk, retake, flag, skip, import, resume, API hardening.
 * Needs: espeak-ng on PATH and a Playwright Chromium (PLAYWRIGHT_CHROMIUM or the one in ~/.cache/ms-playwright).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { createServer } from 'vite';
import { analyze, decodeWav, encodeWav, resampleLinear } from '../src/dsp';

const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-recorder-e2e-'));
const voiceDir = path.join(tmp, 'voice');
process.env.CB_VOICE_DIR = voiceDir;
const PORT = 5300 + Math.floor(Math.random() * 400);
const shots = process.env.E2E_SHOTS ?? path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures++;
};

function chromePath(): string {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const p = path.join(root, d, 'chrome-linux64/chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('no Playwright chromium found; set PLAYWRIGHT_CHROMIUM');
}

/** Fake mic file: 1.5 s room noise, an espeak-ng sentence, 2.5 s room noise, looping forever. 48 kHz mono. */
function makeFakeMic(): string {
  const speech = path.join(tmp, 'speech.wav');
  execFileSync('espeak-ng', ['-v', 'en-us', '-s', '140', '-p', '40', '-a', '170', '-w', speech, 'Strike three, swinging! And that is the ballgame, folks.']);
  const d = decodeWav(fs.readFileSync(speech).buffer.slice(fs.readFileSync(speech).byteOffset) as ArrayBuffer);
  const s48 = resampleLinear(d.samples, d.rate, 48000);
  let peak = 0;
  for (const v of s48) peak = Math.max(peak, Math.abs(v));
  const g = 0.5 / peak; // about -6 dBFS
  let seed = 7;
  const noise = (n: number) => Float32Array.from({ length: n }, () => (((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1) * 0.0003);
  const out = new Float32Array(48000 * 1.5 + s48.length + 48000 * 2.5);
  out.set(noise(out.length));
  for (let i = 0; i < s48.length; i++) out[48000 * 1.5 + i] += s48[i] * g;
  const f = path.join(tmp, 'fake-mic.wav');
  fs.writeFileSync(f, Buffer.from(encodeWav(out, 48000, 16)));
  console.log(`fake mic: ${(out.length / 48000).toFixed(1)} s loop, speech ${(s48.length / 48000).toFixed(1)} s`);
  return f;
}

const state = (page: Page) => page.evaluate(() => (window as unknown as { __rec: { state: string; id: string; session: string; rate: number; roomToneDb?: number } }).__rec);
const waitState = (page: Page, s: string, timeout = 30000) => page.waitForFunction((x) => (window as unknown as { __rec: { state: string } }).__rec?.state === x, s, { timeout });
const readMeta = () => JSON.parse(fs.readFileSync(path.join(voiceDir, 'meta.json'), 'utf8')) as { takes: Record<string, { status: string; takes?: number; qc?: { status: string; checks: { id: string; status: string }[] } }>; config: Record<string, number> };
const wavInfo = (id: string) => {
  const b = fs.readFileSync(path.join(voiceDir, 'wavs', `${id}.wav`));
  const d = decodeWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  return { ...d, a: analyze(d.samples, d.rate, { roomToneDb: -75 }) };
};
const httpCall = (method: string, p: string, headers: Record<string, string> = {}, body?: Buffer) =>
  new Promise<number>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });

async function main() {
  const fake = makeFakeMic();
  const server = await createServer({ configFile: path.join(here, '../vite.config.ts'), server: { port: PORT, strictPort: true }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fake}`, '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 1000 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${m.text()} ${m.location().url}`));
    await page.goto(`http://127.0.0.1:${PORT}/`);

    // --- script loads, first line is shown
    await page.waitForFunction(() => document.getElementById('line-text')?.textContent?.length);
    const first = await page.textContent('#line-text');
    check('script loaded and first pilot line shown', !!first && first.length > 3 && (await page.textContent('#lineno'))!.includes('p0'), first ?? '');
    check('session chips rendered', (await page.locator('.sess').count()) > 5);

    // --- open mic, no processing, rate is what we asked
    await page.selectOption('#rate', '48000');
    await page.selectOption('#bits', '24');
    await page.selectOption('#mode', 'auto');
    await page.selectOption('#countdown', '0');
    await page.click('#open');
    await waitState(page, 'idle');
    const info = (await page.textContent('#capinfo')) ?? '';
    check('mic opened with 48 kHz and processing off', info.includes('context 48000') && info.includes('echo cancel off') && info.includes('noise suppression off') && info.includes('auto gain off'), info);

    // --- room tone (the fake mic is mostly quiet for the first 1.5 s of each loop, so use the quiet window)
    await page.fill('#rtsec', '1');
    await page.click('#roomtone');
    await page.waitForFunction(() => document.getElementById('rtinfo')?.dataset.db !== undefined, null, { timeout: 15000 });
    const rt = Number(await page.getAttribute('#rtinfo', 'data-db'));
    check('room tone captured and saved', fs.existsSync(path.join(voiceDir, 'roomtone.wav')) && Number.isFinite(rt), `${rt} dBFS`);

    // --- take 1: auto-detect hands free
    const id1 = (await state(page)).id;
    await page.keyboard.press('Space');
    await waitState(page, 'armed', 5000);
    await waitState(page, 'recording', 20000);
    await waitState(page, 'review', 20000);
    check('auto-detect start/stop recorded a take', fs.existsSync(path.join(voiceDir, 'wavs', `${id1}.wav`)));
    const w1 = wavInfo(id1);
    check('take is mono 48 kHz 24-bit', w1.rate === 48000 && w1.bits === 24 && w1.channels === 1, `${w1.rate}/${w1.bits}/${w1.channels}`);
    const head = w1.a.speechStart / w1.rate;
    const tail = (w1.samples.length - w1.a.speechEnd) / w1.rate;
    check('head/tail padding is 150-250 ms (+ detector tolerance)', head > 0.12 && head < 0.3 && tail > 0.12 && tail < 0.32, `head ${head.toFixed(2)} s, tail ${tail.toFixed(2)} s`);
    check('speech is complete (about 3 s)', w1.a.speechS > 2 && w1.a.speechS < 6, `${w1.a.speechS.toFixed(1)} s`);
    const m1 = readMeta();
    check('QC is OK and meta saved', m1.takes[id1]?.status === 'done' && m1.takes[id1]?.qc?.status !== 'fail', JSON.stringify(m1.takes[id1]?.qc?.checks.map((c) => `${c.id}:${c.status}`)));
    check('first take locked the recording config', m1.config.rate === 48000 && m1.config.bits === 24);
    await page.screenshot({ path: path.join(shots, 'recorder-review.png') });

    // --- next line, toggle mode (space start / space stop). Loop timing is arbitrary, so only assert a file + QC verdict.
    await page.keyboard.press('ArrowRight');
    const id2 = (await state(page)).id;
    check('arrow right advances to the next line', id2 !== id1);
    await page.selectOption('#mode', 'toggle');
    await page.keyboard.press('Space');
    await waitState(page, 'recording', 5000);
    await page.waitForTimeout(6800);
    await page.keyboard.press('Space');
    await waitState(page, 'review', 10000);
    const w2 = fs.existsSync(path.join(voiceDir, 'wavs', `${id2}.wav`));
    const q2 = readMeta().takes[id2]?.qc?.status;
    check('toggle mode recorded and judged a take (a full loop long)', w2 || q2 === 'fail', `qc ${q2}`);

    // --- retake the first line: overwrites, takes counter goes up
    await page.keyboard.press('ArrowLeft'); // retake: re-arms the same line (toggle mode starts recording after the 0 s countdown)
    await waitState(page, 'recording', 5000);
    check('left arrow starts a retake of the same line', (await state(page)).id === id2);
    await page.waitForTimeout(6800);
    await page.keyboard.press('Space');
    await waitState(page, 'review', 10000);

    // --- push to talk on line 3
    await page.keyboard.press('ArrowRight');
    const id3 = (await state(page)).id;
    await page.selectOption('#mode', 'ptt');
    await page.keyboard.down('Space');
    await waitState(page, 'recording', 5000);
    await page.waitForTimeout(6800);
    await page.keyboard.up('Space');
    await waitState(page, 'review', 10000);
    check('push-to-talk held and released produced a take or a fail verdict', fs.existsSync(path.join(voiceDir, 'wavs', `${id3}.wav`)) || readMeta().takes[id3]?.qc?.status === 'fail');

    // --- flag + skip
    await page.keyboard.press('ArrowRight');
    const id4 = (await state(page)).id;
    await page.keyboard.press('f');
    await page.waitForTimeout(300);
    check('F flags a line for review', readMeta().takes[id4]?.status === 'flag');
    await page.keyboard.press('s');
    await page.waitForTimeout(300);
    const id5 = (await state(page)).id;
    await page.keyboard.press('s');
    await page.waitForTimeout(300);
    check('S skips and moves on', readMeta().takes[id5]?.status === 'skipped' && (await state(page)).id !== id5);

    // --- import: stereo 44.1 kHz WAV for the current line -> mono 48 kHz saved
    const cur = (await state(page)).id;
    const sp = fs.readFileSync(path.join(tmp, 'speech.wav'));
    const imp = decodeWav(sp.buffer.slice(sp.byteOffset, sp.byteOffset + sp.byteLength) as ArrayBuffer);
    const lead = new Float32Array(Math.round(imp.rate * 0.6));
    const padded = new Float32Array(lead.length * 2 + imp.samples.length);
    padded.set(imp.samples, lead.length);
    const f44 = path.join(tmp, `${cur}.wav`);
    fs.writeFileSync(f44, Buffer.from(encodeWav(resampleLinear(padded, imp.rate, 44100), 44100, 16)));
    await page.setInputFiles('#import', f44);
    await page.waitForFunction((id) => document.querySelector(`.li[data-id="${id}"] .st`)?.textContent !== '·', cur, { timeout: 15000 });
    const wi = wavInfo(cur);
    check('imported WAV was matched by name, converted and trimmed', wi.rate === 48000 && wi.channels === 1 && wi.a.speechS > 1, `${wi.rate} Hz, ${wi.samples.length / wi.rate} s`);

    // --- resume: a reload lands on the first line that is not done yet, progress persists
    const doneBefore = Object.values(readMeta().takes).filter((t) => t.status === 'done' || t.status === 'flag').length;
    await page.reload();
    await page.waitForFunction(() => document.getElementById('line-text')?.textContent?.length);
    const prog = (await page.textContent('#overall')) ?? '';
    check('progress survives a reload', prog.includes(`${doneBefore}/`), prog);
    const resumed = (await state(page)).id;
    check('resume lands on a line without a take', !fs.existsSync(path.join(voiceDir, 'wavs', `${resumed}.wav`)) || readMeta().takes[resumed]?.status === 'flag', resumed);
    await page.screenshot({ path: path.join(shots, 'recorder-main.png') });

    check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    // --- API hardening on the real server
    check('foreign Host header refused', (await httpCall('GET', '/api/script', { Host: 'evil.example.com' })) === 403);
    check('path traversal id refused', [400, 404].includes(await httpCall('PUT', '/api/wav/..%2f..%2fpwn', {}, Buffer.from('x'))));
    check('nothing was written outside the voice folder', !fs.existsSync(path.join(tmp, 'pwn.wav')) && !fs.existsSync(path.join(tmp, 'pwn')));
    const ls = await new Promise<string>((r) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/info' }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r(d)); }));
    check('api reports the temp voice dir, not the real home', ls.includes(tmp) && !ls.includes('claudeball-voice'));
    const addr = server.httpServer?.address();
    check('listens on 127.0.0.1 only', typeof addr === 'object' && addr?.address === '127.0.0.1', JSON.stringify(addr));
  } finally {
    await browser.close();
    await server.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED. Artifacts in ${tmp}` : `\nall checks passed. Screenshots in ${shots}`);
  if (!failures && !process.env.E2E_KEEP) fs.rmSync(voiceDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

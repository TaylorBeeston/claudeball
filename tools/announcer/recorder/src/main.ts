import { openCapture, listInputs, type Capture } from './capture';
import { analyze, dbfs, encodeWav, decodeWav, fmtTime, levels, qc as runQc, trim, Vad, type Qc, type Analysis } from './dsp';
import { FsaStore, ServerStore, type MetaSnapshot, type ScriptLine, type Store, type TakeMeta } from './store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SETTINGS_KEY = 'claudeball.recorder.v1';

type Mode = 'toggle' | 'ptt' | 'auto';
type State = 'closed' | 'idle' | 'countdown' | 'armed' | 'recording' | 'finishing' | 'review';

interface Settings {
  deviceId: string;
  rate: 44100 | 48000;
  bits: 16 | 24;
  mode: Mode;
  countdown: number;
  pad: number;
  autoplay: boolean;
  autonext: boolean;
  rtsec: number;
  session: string;
}
const defaults: Settings = { deviceId: '', rate: 48000, bits: 24, mode: 'toggle', countdown: 1, pad: 200, autoplay: true, autonext: false, rtsec: 5, session: '' };
function loadSettings(): Settings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...defaults };
  }
}
let settings = loadSettings();
const saveSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private window: settings just do not persist */
  }
};

let store: Store = new ServerStore();
let lines: ScriptLine[] = [];
let meta: MetaSnapshot = { takes: {}, config: {}, files: [], roomTone: false };
let sessions: string[] = [];
let idx = 0; // index within the current session
let state: State = 'closed';
let cap: Capture | null = null;
let roomToneDb: number | undefined;

// capture buffers
const PREROLL_S = 0.5;
let preroll: Float32Array[] = [];
let prerollLen = 0;
let chunks: Float32Array[] = [];
let vad = new Vad(-45);
let recStartedAt = 0;
let lastTake: { samples: Float32Array; analysis: Analysis; qc: Qc; id: string } | null = null;
let pk = -120;
let pkHold = -120;
let rmsDb = -120;
let clipUntil = 0;

const sessionLines = () => lines.filter((l) => l.session === settings.session);
const cur = (): ScriptLine | undefined => sessionLines()[idx];
const rate = () => cap?.ctx.sampleRate ?? settings.rate;

const takeOf = (id: string): TakeMeta | undefined => {
  const t = meta.takes[id];
  if (t) return t;
  return meta.files.includes(id) ? { status: 'done' } : undefined;
};
const isDone = (id: string) => takeOf(id)?.status === 'done' || takeOf(id)?.status === 'flag';

function setState(s: State) {
  state = s;
  const el = $('state');
  el.textContent = { closed: 'no microphone', idle: 'ready', countdown: 'get ready…', armed: 'listening for your voice…', recording: '● RECORDING', finishing: 'finishing…', review: 'review' }[s];
  el.className = `state ${s}`;
  $('rec').classList.toggle('on', s === 'recording');
  const open = s !== 'closed';
  ($('rec') as HTMLButtonElement).disabled = !open;
  ($('roomtone') as HTMLButtonElement).disabled = !open || s === 'recording';
  for (const id of ['retake', 'next', 'skip', 'flag']) ($(id) as HTMLButtonElement).disabled = !lines.length;
  ($('play') as HTMLButtonElement).disabled = !(cur() && isDone(cur()!.id));
  ($('rec') as HTMLButtonElement).textContent = s === 'recording' || s === 'armed' || s === 'countdown' ? '■ Stop ' : '● Record ';
  ($('rec') as HTMLButtonElement).insertAdjacentHTML('beforeend', '<kbd>Space</kbd>');
}

// ------------------------------------------------------------------ UI: line, progress, list
function renderLine() {
  const l = cur();
  const sl = sessionLines();
  $('line-text').textContent = l ? l.normalized : lines.length ? 'Session complete. Pick another session above.' : 'No script found. Run: npm run announcer:script';
  $('line-orig').textContent = l && l.normalized !== l.text ? `game text: ${l.text}` : '';
  $('direction').textContent = l ? l.direction : '';
  $('direction').style.display = l ? '' : 'none';
  const tag = $('style');
  tag.textContent = l ? l.style : '';
  tag.className = `tag ${l?.style ?? ''}`;
  $('lineno').textContent = l ? `${l.id} · line ${idx + 1} of ${sl.length}` : '';
  $('linekind').textContent = l ? `${l.kind} · speaker ${l.speaker}` : '';
  renderProgress();
  renderList();
  const t = l && takeOf(l.id);
  $('review').hidden = !(t && lastTake?.id === l?.id);
  ($('play') as HTMLButtonElement).disabled = !(l && isDone(l.id));
  const fl = $('flag') as HTMLButtonElement;
  fl.textContent = t?.status === 'flag' ? '⚑ Flagged ' : '⚑ Flag ';
  fl.insertAdjacentHTML('beforeend', '<kbd>F</kbd>');
}

function statusIcon(id: string): [string, string] {
  const t = takeOf(id);
  if (!t) return ['·', ''];
  if (t.status === 'skipped') return ['↷', 'skip'];
  if (t.status === 'flag') return ['⚑', 'warn'];
  const s = t.qc?.status ?? 'ok';
  return [s === 'ok' ? '✓' : s === 'warn' ? '!' : '✗', s];
}

function renderProgress() {
  const el = $('sessions');
  el.innerHTML = '';
  for (const s of sessions) {
    const sl = lines.filter((l) => l.session === s);
    const done = sl.filter((l) => isDone(l.id) || takeOf(l.id)?.status === 'skipped').length;
    const b = document.createElement('button');
    b.className = `sess${s === settings.session ? ' cur' : ''}${done === sl.length ? ' complete' : ''}`;
    b.dataset.session = s;
    b.textContent = `${s} ${done}/${sl.length}`;
    b.onclick = () => selectSession(s);
    el.append(b);
  }
  const sl = sessionLines();
  const left = sl.filter((l) => !isDone(l.id) && takeOf(l.id)?.status !== 'skipped');
  const leftS = left.reduce((a, l) => a + l.estSeconds, 0);
  $('progress').textContent = `Session ${settings.session}: ${sl.length - left.length}/${sl.length} lines done, about ${fmtTime(leftS)} of audio left (roughly ${Math.round((leftS * 2.4) / 60)} min at the mic).`;
  const doneAll = lines.filter((l) => isDone(l.id)).length;
  const bad = lines.filter((l) => isDone(l.id) && takeOf(l.id)?.qc?.status === 'fail').length;
  $('overall').textContent = `${doneAll}/${lines.length} lines recorded${bad ? ` · ${bad} to retake` : ''}`;
}

function renderList() {
  const box = $('list');
  box.innerHTML = '';
  sessionLines().forEach((l, i) => {
    const [ic, cls] = statusIcon(l.id);
    const d = document.createElement('div');
    d.className = `li${i === idx ? ' cur' : ''}`;
    d.dataset.id = l.id;
    d.innerHTML = `<span class="st ${cls}">${ic}</span><span class="tx"></span><span class="muted">${l.style}</span>`;
    (d.querySelector('.tx') as HTMLElement).textContent = `${l.id}  ${l.normalized}`;
    d.onclick = () => goTo(i);
    box.append(d);
  });
}

function showBanner(msg: string, err = false) {
  const b = $('banner');
  b.hidden = !msg;
  b.textContent = msg;
  b.className = `banner${err ? ' err' : ''}`;
}

function firstUndone(session: string): number {
  const sl = lines.filter((l) => l.session === session);
  const i = sl.findIndex((l) => !isDone(l.id) && takeOf(l.id)?.status !== 'skipped');
  return i < 0 ? 0 : i;
}

function selectSession(s: string) {
  if (state === 'recording' || state === 'armed') cancelRecording();
  settings.session = s;
  saveSettings();
  idx = firstUndone(s);
  lastTake = null;
  renderLine();
  setState(state);
}

function goTo(i: number) {
  if (state === 'recording' || state === 'armed' || state === 'countdown') cancelRecording();
  const n = sessionLines().length;
  idx = Math.max(0, Math.min(n - 1, i));
  lastTake = null;
  if (state === 'review') setState('idle');
  renderLine();
}

// ------------------------------------------------------------------ meter
const meterCv = $('meter') as HTMLCanvasElement;
function drawMeter() {
  const c = meterCv.getContext('2d')!;
  const w = meterCv.width, h = meterCv.height;
  c.clearRect(0, 0, w, h);
  const x = (db: number) => ((Math.max(-60, Math.min(0, db)) + 60) / 60) * w;
  // zones
  const zones: [number, number, string][] = [[-60, -18, '#1e3b2c'], [-18, -3, '#2f4a1f'], [-3, 0, '#4a1f22']];
  for (const [a, b, col] of zones) {
    c.fillStyle = col;
    c.fillRect(x(a), 0, x(b) - x(a), h);
  }
  c.fillStyle = '#3ecf8e';
  c.fillRect(0, 8, x(rmsDb), 20);
  c.fillStyle = pk > -3 ? '#f2575b' : pk > -12 ? '#f5b546' : '#5aa9ff';
  c.fillRect(0, 34, x(pk), 20);
  c.fillStyle = '#fff';
  c.fillRect(x(pkHold) - 1, 4, 3, h - 8);
  c.fillStyle = '#ffffff55';
  c.font = '10px monospace';
  for (let d = -60; d <= 0; d += 12) c.fillText(String(d), x(d) + 2, h - 2);
  if (roomToneDb !== undefined) {
    c.fillStyle = '#f5b546';
    c.fillRect(x(roomToneDb), 0, 2, h);
  }
  pk = Math.max(-120, pk - 1.2);
  pkHold = Math.max(pk, pkHold - 0.25);
  $('peaktxt').textContent = `peak ${pkHold > -119 ? pkHold.toFixed(1) : '-∞'} dBFS`;
  $('rmstxt').textContent = `rms ${rmsDb > -119 ? rmsDb.toFixed(1) : '-∞'}`;
  $('clip').classList.toggle('on', performance.now() < clipUntil);
  requestAnimationFrame(drawMeter);
}

// ------------------------------------------------------------------ capture handling
function onBlock(b: Float32Array) {
  const lv = levels(b);
  pk = Math.max(pk, lv.peakDb);
  pkHold = Math.max(pkHold, lv.peakDb);
  rmsDb = lv.rmsDb;
  if (lv.peak >= 0.989) clipUntil = performance.now() + 2000;
  const ms = (b.length / rate()) * 1000;
  if (state === 'recording' || state === 'finishing') {
    chunks.push(b);
    if (state === 'recording') {
      if (settings.mode === 'auto' && vad.push(lv.rmsDb, ms) === 'end') stopRecording();
      if (performance.now() - recStartedAt > 60000) stopRecording();
    }
    return;
  }
  // not recording: keep a rolling pre-roll so the first word is never clipped by a late button press
  preroll.push(b);
  prerollLen += b.length;
  while (prerollLen - preroll[0].length > PREROLL_S * rate()) prerollLen -= preroll.shift()!.length;
  if (state === 'armed' && vad.push(lv.rmsDb, ms) === 'start') beginRecording();
}

function beginRecording() {
  chunks = [...preroll];
  preroll = [];
  prerollLen = 0;
  recStartedAt = performance.now();
  setState('recording');
}

function stopRecording() {
  if (state !== 'recording') return;
  setState('finishing');
  // keep listening for 350 ms: the tail of the last word and a little room after it
  setTimeout(() => void finalize(), 350);
}

function cancelRecording() {
  chunks = [];
  vad.reset();
  countdownToken++;
  $('countdownbox').hidden = true;
  setState(cap ? 'idle' : 'closed');
}

const concat = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function finalize() {
  const l = cur();
  if (!l) return setState('idle');
  const raw = concat(chunks);
  chunks = [];
  vad.reset();
  const r = rate();
  const a = analyze(raw, r, { roomToneDb });
  const result = runQc(a, l.estSeconds);
  const t = trim(raw, r, a, settings.pad);
  lastTake = { samples: t.samples, analysis: a, qc: result, id: l.id };
  drawWave(t, a);
  showQc(result);
  const existing = takeOf(l.id);
  const keepOld = result.status === 'fail' && existing && isDone(l.id) && existing.qc?.status !== 'fail';
  if (!keepOld && a.speechStart >= 0) await saveTake(l, t.samples, result);
  else if (keepOld) showBanner(`Take for ${l.id} failed its checks and was not saved: the earlier take is kept. Retake it.`);
  setState('review');
  renderLine();
  $('review').hidden = false;
  if (settings.autoplay && t.samples.length) void playSamples(t.samples);
  if (settings.autonext && result.status !== 'fail') setTimeout(() => goTo(idx + 1), 900);
}

async function saveTake(l: ScriptLine, samples: Float32Array, result: Qc, imported = false) {
  const bits = settings.bits;
  try {
    await store.putWav(l.id, encodeWav(samples, rate(), bits));
    const prev = takeOf(l.id);
    const m: TakeMeta = { status: 'done', qc: result, durationS: Math.round((samples.length / rate()) * 100) / 100, rate: rate(), bits, takes: (prev?.takes ?? 0) + 1, imported };
    await store.putMeta(l.id, m);
    meta.takes[l.id] = { ...meta.takes[l.id], ...m };
    if (!meta.files.includes(l.id)) meta.files.push(l.id);
    if (meta.config.rate === undefined) {
      await store.putConfig({ rate: rate(), bits });
      meta.config = { rate: rate(), bits };
    }
    showBanner('');
  } catch (e) {
    showBanner(`Could not save ${l.id}: ${(e as Error).message}`, true);
  }
}

function showQc(q: Qc) {
  const box = $('qc');
  box.innerHTML = '';
  const overall = document.createElement('span');
  overall.className = `badge ${q.status}`;
  overall.id = 'qc-overall';
  overall.textContent = q.status === 'ok' ? 'Take OK' : q.status === 'warn' ? 'Take OK, with notes' : 'Retake suggested';
  box.append(overall);
  for (const c of q.checks) {
    if (c.status === 'ok' && q.status !== 'ok') continue;
    const s = document.createElement('span');
    s.className = `badge ${c.status}`;
    s.dataset.check = c.id;
    s.title = c.detail;
    s.textContent = c.status === 'ok' ? `✓ ${c.label}` : `${c.label}: ${c.detail}`;
    box.append(s);
  }
}

function drawWave(t: { samples: Float32Array; padHeadS: number; padTailS: number }, _a: Analysis) {
  const cv = $('wave') as HTMLCanvasElement;
  const c = cv.getContext('2d')!;
  const w = cv.width, h = cv.height;
  c.clearRect(0, 0, w, h);
  const s = t.samples;
  if (!s.length) return;
  const per = s.length / w;
  c.fillStyle = '#ffffff12';
  c.fillRect(0, 0, (t.padHeadS * rate() / s.length) * w, h);
  c.fillRect(w - (t.padTailS * rate() / s.length) * w, 0, (t.padTailS * rate() / s.length) * w, h);
  c.fillStyle = '#5aa9ff';
  for (let x = 0; x < w; x++) {
    let mn = 0, mx = 0;
    for (let i = Math.floor(x * per); i < Math.min(s.length, Math.floor((x + 1) * per)); i++) {
      if (s[i] < mn) mn = s[i];
      if (s[i] > mx) mx = s[i];
    }
    c.fillRect(x, h / 2 - mx * (h / 2), 1, Math.max(1, (mx - mn) * (h / 2)));
  }
}

// ------------------------------------------------------------------ playback
let audioEl: HTMLAudioElement | null = null;
async function playSamples(s: Float32Array) {
  audioEl?.pause();
  audioEl = new Audio(URL.createObjectURL(new Blob([encodeWav(s, rate(), 16)], { type: 'audio/wav' })));
  await audioEl.play().catch(() => {});
}
async function playSaved() {
  const l = cur();
  if (!l) return;
  const buf = await store.getWav(l.id);
  if (!buf) return;
  audioEl?.pause();
  audioEl = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  await audioEl.play().catch(() => {});
}

// ------------------------------------------------------------------ actions
let countdownToken = 0;
async function startFlow() {
  if (!cap || !cur()) return;
  if (state === 'recording') return stopRecording();
  if (state === 'armed' || state === 'countdown') return cancelRecording();
  if (state === 'review') {
    /* recording over a take: counts as a retake */
  }
  audioEl?.pause();
  const token = ++countdownToken;
  const n = settings.mode === 'ptt' ? 0 : settings.countdown;
  if (n > 0) {
    setState('countdown');
    const box = $('countdownbox');
    box.hidden = false;
    for (let i = n; i > 0; i--) {
      box.textContent = String(i);
      await new Promise((r) => setTimeout(r, 1000));
      if (token !== countdownToken) return;
    }
    box.hidden = true;
  }
  if (token !== countdownToken) return;
  lastTake = null;
  $('review').hidden = true;
  if (settings.mode === 'auto') {
    vad = new Vad(Math.max(-52, (roomToneDb ?? -60) + 14), 120, 1200);
    preroll = preroll.slice(-Math.ceil((PREROLL_S * rate()) / 1024));
    setState('armed');
  } else beginRecording();
}

async function toggleFlag() {
  const l = cur();
  if (!l) return;
  const t = takeOf(l.id);
  const next: TakeMeta['status'] = t?.status === 'flag' ? 'done' : 'flag';
  if (!t && next === 'flag') {
    // flag a line you have not recorded yet: note it, keep the line pending
    await store.putMeta(l.id, { status: 'flag' });
    meta.takes[l.id] = { status: 'flag' };
  } else {
    await store.putMeta(l.id, { status: next });
    meta.takes[l.id] = { ...meta.takes[l.id], status: next };
  }
  renderLine();
}

async function skip() {
  const l = cur();
  if (!l) return;
  if (!isDone(l.id)) {
    await store.putMeta(l.id, { status: 'skipped' });
    meta.takes[l.id] = { status: 'skipped' };
  }
  goTo(idx + 1);
}

function retake() {
  if (state === 'recording' || state === 'armed' || state === 'countdown') cancelRecording();
  lastTake = null;
  $('review').hidden = true;
  setState(cap ? 'idle' : 'closed');
  void startFlow();
}

// ------------------------------------------------------------------ keyboard
const typing = (e: Event) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
let pttDown = false;
window.addEventListener('keydown', (e) => {
  if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (e.repeat) return;
      if (settings.mode === 'ptt') {
        if (!pttDown && state !== 'recording') {
          pttDown = true;
          void startFlow();
        }
      } else void startFlow();
      break;
    case 'ArrowLeft': e.preventDefault(); retake(); break;
    case 'ArrowRight': e.preventDefault(); goTo(idx + 1); break;
    case 'ArrowUp': e.preventDefault(); goTo(idx - 1); break;
    case 'p': case 'P': void playSaved(); break;
    case 's': case 'S': void skip(); break;
    case 'f': case 'F': void toggleFlag(); break;
    case 'Escape': cancelRecording(); break;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && settings.mode === 'ptt' && pttDown) {
    pttDown = false;
    if (state === 'recording') stopRecording();
  }
});

// ------------------------------------------------------------------ setup panel
async function openMic() {
  try {
    cap?.stop();
    cap = await openCapture({ deviceId: settings.deviceId || undefined, rate: settings.rate });
    cap.onBlock = onBlock;
    await populateMics();
    $('capinfo').textContent = `${cap.info.label || 'microphone'} · context ${cap.info.contextRate} Hz${cap.info.trackRate ? ` (device ${cap.info.trackRate})` : ''} · echo cancel ${cap.info.echoCancellation ? 'ON' : 'off'} · noise suppression ${cap.info.noiseSuppression ? 'ON' : 'off'} · auto gain ${cap.info.autoGainControl ? 'ON' : 'off'}`;
    if (cap.info.echoCancellation || cap.info.noiseSuppression || cap.info.autoGainControl) showBanner('This browser would not turn off echo cancellation / noise suppression / auto gain for this device. Recordings may sound processed: try another browser or device.');
    setState('idle');
    renderLine();
  } catch (e) {
    showBanner(`Could not open the microphone: ${(e as Error).message}. Allow microphone access for this page.`, true);
  }
}

async function populateMics() {
  const sel = $('mic') as HTMLSelectElement;
  const devs = await listInputs();
  sel.innerHTML = '';
  for (const d of devs) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone ${sel.length + 1}`;
    sel.append(o);
  }
  if (settings.deviceId && devs.some((d) => d.deviceId === settings.deviceId)) sel.value = settings.deviceId;
}

async function captureRoomTone() {
  if (!cap) return;
  const secs = Math.max(1, Math.min(30, Number(($('rtsec') as HTMLInputElement).value) || 5));
  cancelRecording();
  $('rtinfo').textContent = `stay quiet… ${secs} s`;
  preroll = [];
  prerollLen = 0;
  chunks = [];
  setState('finishing'); // collect blocks without VAD / UI side effects
  await new Promise((r) => setTimeout(r, secs * 1000));
  const s = concat(chunks);
  chunks = [];
  setState('idle');
  const lv = levels(s, Math.floor(s.length * 0.1)); // skip the first 10 %: the click of the button
  roomToneDb = lv.rmsDb;
  await store.putRoomTone(encodeWav(s, rate(), 16));
  await store.putConfig({ roomToneDb });
  meta.roomTone = true;
  showRoomTone(lv.rmsDb, lv.peakDb);
}
function showRoomTone(rms: number, peak: number) {
  const verdict = rms < -60 ? 'excellent' : rms < -52 ? 'good' : rms < -45 ? 'a bit noisy' : 'too noisy: find a quieter spot';
  $('rtinfo').textContent = `room noise ${rms.toFixed(1)} dBFS (peak ${peak.toFixed(1)}): ${verdict}`;
  $('rtinfo').dataset.db = rms.toFixed(1);
}

// import
async function importFiles(files: FileList | File[]) {
  const list = [...files];
  for (const f of list) {
    const stem = f.name.replace(/\.[^.]+$/, '').toLowerCase();
    const target = lines.find((l) => l.id === stem) ?? (list.length === 1 ? cur() : undefined);
    if (!target) {
      showBanner(`Skipped ${f.name}: its name is not a line id, and several files were dropped at once.`);
      continue;
    }
    try {
      const mono = await decodeFile(await f.arrayBuffer(), settings.rate);
      const a = analyze(mono, settings.rate, { roomToneDb });
      const q = runQc(a, target.estSeconds);
      const t = trim(mono, settings.rate, a, settings.pad);
      if (a.speechStart < 0) {
        showBanner(`${f.name}: no speech found, not imported.`);
        continue;
      }
      await saveTake(target, t.samples, q, true);
      if (target.id === cur()?.id) {
        lastTake = { samples: t.samples, analysis: a, qc: q, id: target.id };
        drawWave(t, a);
        showQc(q);
      }
    } catch (e) {
      showBanner(`Could not import ${f.name}: ${(e as Error).message}`, true);
    }
  }
  renderLine();
  setState(state === 'closed' ? 'closed' : 'idle');
}

/** Decode any audio file to mono float at the target rate (the browser's decoder resamples to the offline context's rate). */
async function decodeFile(buf: ArrayBuffer, targetRate: number): Promise<Float32Array> {
  try {
    const ctx = new OfflineAudioContext(1, 1, targetRate);
    const ab = await ctx.decodeAudioData(buf.slice(0));
    const mono = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / ab.numberOfChannels;
    }
    return mono;
  } catch {
    return decodeWav(buf).samples; // plain WAV fallback
  }
}

// ------------------------------------------------------------------ wiring + boot
function bindSetup() {
  const s = settings;
  ($('rate') as HTMLSelectElement).value = String(s.rate);
  ($('bits') as HTMLSelectElement).value = String(s.bits);
  ($('mode') as HTMLSelectElement).value = s.mode;
  ($('countdown') as HTMLSelectElement).value = String(s.countdown);
  ($('pad') as HTMLSelectElement).value = String(s.pad);
  ($('autoplay') as HTMLInputElement).checked = s.autoplay;
  ($('autonext') as HTMLInputElement).checked = s.autonext;
  ($('rtsec') as HTMLInputElement).value = String(s.rtsec);
  const on = (id: string, f: () => void) => $(id).addEventListener('change', () => { f(); saveSettings(); $(id).blur(); });
  on('mic', () => { settings.deviceId = ($('mic') as HTMLSelectElement).value; if (cap) void openMic(); });
  on('rate', () => { settings.rate = Number(($('rate') as HTMLSelectElement).value) as 44100 | 48000; if (cap) void openMic(); checkConfig(); });
  on('bits', () => { settings.bits = Number(($('bits') as HTMLSelectElement).value) as 16 | 24; checkConfig(); });
  on('mode', () => { settings.mode = ($('mode') as HTMLSelectElement).value as Mode; });
  on('countdown', () => { settings.countdown = Number(($('countdown') as HTMLSelectElement).value); });
  on('pad', () => { settings.pad = Number(($('pad') as HTMLSelectElement).value); });
  on('autoplay', () => { settings.autoplay = ($('autoplay') as HTMLInputElement).checked; });
  on('autonext', () => { settings.autonext = ($('autonext') as HTMLInputElement).checked; });
  on('rtsec', () => { settings.rtsec = Number(($('rtsec') as HTMLInputElement).value) || 5; });
  $('open').onclick = () => void openMic();
  $('roomtone').onclick = () => void captureRoomTone();
  $('rec').onclick = () => { $('rec').blur(); void startFlow(); };
  $('play').onclick = () => { $('play').blur(); void playSaved(); };
  $('retake').onclick = () => { $('retake').blur(); retake(); };
  $('next').onclick = () => { $('next').blur(); goTo(idx + 1); };
  $('skip').onclick = () => { $('skip').blur(); void skip(); };
  $('flag').onclick = () => { $('flag').blur(); void toggleFlag(); };
  ($('import') as HTMLInputElement).onchange = (e) => { const f = (e.target as HTMLInputElement).files; if (f?.length) void importFiles(f); (e.target as HTMLInputElement).value = ''; };
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files); });
  // File System Access backend, where the browser has it
  if ('showDirectoryPicker' in window) {
    const sel = $('storage') as HTMLSelectElement;
    sel.insertAdjacentHTML('beforeend', '<option value="fsa">A folder I pick (browser)</option>');
    sel.onchange = () => {
      $('pickdir').hidden = sel.value !== 'fsa';
      if (sel.value === 'server') void useStore(new ServerStore());
    };
    $('pickdir').onclick = async () => {
      try {
        const h = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite', id: 'claudeball-voice' });
        await useStore(new FsaStore(h, new ServerStore()));
      } catch {
        /* cancelled */
      }
    };
  }
}

function checkConfig() {
  const c = meta.config;
  if (c.rate && c.bits && (c.rate !== settings.rate || c.bits !== settings.bits)) showBanner(`Earlier takes were saved at ${c.rate / 1000} kHz / ${c.bits}-bit. Keep the same settings (and the same mic gain) for every session so the takes match.`);
  else if (!cap) showBanner('');
}

async function useStore(s: Store) {
  store = s;
  meta = await store.meta();
  if (meta.config.rate) {
    settings.rate = meta.config.rate as 44100 | 48000;
    settings.bits = (meta.config.bits as 16 | 24) ?? settings.bits;
    ($('rate') as HTMLSelectElement).value = String(settings.rate);
    ($('bits') as HTMLSelectElement).value = String(settings.bits);
  }
  const rt = (meta.config as { roomToneDb?: number }).roomToneDb;
  if (rt !== undefined) {
    roomToneDb = rt;
    showRoomTone(rt, NaN);
  }
  $('where').textContent = `saving to: ${s.label}`;
  idx = firstUndone(settings.session);
  renderLine();
}

async function boot() {
  bindSetup();
  try {
    lines = await store.script();
    const info = (await (await fetch('/api/info')).json()) as { voiceDir: string };
    $('dirinfo').textContent = `Private folder: ${info.voiceDir}. It is never uploaded or committed.`;
    sessions = [...new Set(lines.map((l) => l.session))];
    if (!sessions.includes(settings.session)) settings.session = sessions[0] ?? '';
    await useStore(store);
    // resume where you left off: first session with something left to do
    if (!meta.config.rate || !isDone(cur()?.id ?? '')) {
      /* stay on the saved session */
    }
    idx = firstUndone(settings.session);
    renderLine();
    checkConfig();
  } catch (e) {
    showBanner(`Could not load the script or your folder: ${(e as Error).message}. Run \`npm run announcer:script\` first.`, true);
  }
  setState('closed');
  requestAnimationFrame(drawMeter);
}
Object.defineProperty(window, '__rec', {
  // read by the e2e test: always the live state, not a snapshot
  get: () => ({ state, session: settings.session, idx, id: cur()?.id, rate: rate(), roomToneDb }),
});
void boot();
void dbfs;

/**
 * The promo, end to end: `npm run promo:render [-- options]`
 *
 *   1. capture   every shot in shots.ts, frame by frame in headless Chrome on the real GPU (Vulkan), with its game audio (cached per shot by content hash)
 *   2. sheets    a contact sheet per shot (QA)
 *   3. titles, mix, picture, encode, teaser, snippets: the typography layer, the music bed and the mix, the edit, the encodes (edit.ts, titles.ts, music.ts, assemble.ts)
 *
 * With no format, all of them: 1080p (+ the README teaser and the audio snippets), then 4K, then the vertical cut.
 * Options: --1080p, --preview (960x540, 30 fps), --4k (3840x2160: the 1920x1080 viewport at device scale 2), --vertical (the 9:16 cut),
 *          --music FILE (a track instead of the code bed: the mix reads it, never writes it),
 *          --only id,id (capture just these), --stages capture,sheets,... , --force (ignore the cache), --no-build
 * Everything goes to ~/claudeball-promo/ (CB_PROMO_DIR); nothing is written into the repo.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build, startPreview, systemLoad } from '../perf/lib';
import { PROMO_DIR, buildKey, cached, captureShot, openChrome, shotDir, shotHash, type RenderSettings, type ShotManifest } from './capture';
import { SHOTS, VSHOTS } from './shots';
import { buildPicture, encode, fillOverlay, layout, mix, overlayList, voiceWindow } from './assemble';
import { BEAT, CUTS, VCUTS, VOICE, cutTimes, resolveIn, type Cut, type VoiceTrack } from './edit';
import type { Overlay } from './overlay';
import { SR } from './dsp';
import { heardText } from './voiceText';
import { renderOverlay } from './titles';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k: string) => argv.includes(`--${k}`);

const vertical = flag('vertical');
/** the shots of this cut: the vertical cut has its own re-shoots (and the phone footage) */
const shotList = () => (vertical ? VSHOTS : SHOTS);
const cutList = (): Cut[] => (vertical ? VCUTS : CUTS);
const voiceList = (): VoiceTrack[] => (vertical ? VOICE.map((v) => ({ ...v, shot: `v-${v.shot}` })) : VOICE);

/** full-size renders keep only the frames the edit uses (+-1 s); a preview keeps everything (free to re-edit) */
function withKeep(list: typeof SHOTS): typeof SHOTS {
  if (flag('preview') || flag('keep-all')) return list;
  const cuts = cutList();
  return list.map((s) => {
    // (a cut anchored on what the broadcast shows keeps the whole take: the anchor is only known once it is captured)
    if (cuts.some((c) => c.shot === s.id && c.anchor)) return s;
    const r = cuts.filter((c) => c.shot === s.id && !c.black).map((c): [number, number] => [Math.max(0, +(c.in - 1).toFixed(2)), +(c.in + c.beats * BEAT + 1).toFixed(2)]);
    return r.length ? { ...s, keep: r } : s;
  });
}

export function settings(): RenderSettings {
  // vertical: the 960x540 viewport on its side (540x960 CSS), at device scale 2 for 1080x1920
  if (vertical) return { width: 960, height: 540, dpr: flag('preview') ? 1 : 2, fps: flag('preview') ? 30 : 60, format: 'jpeg', quality: flag('preview') ? 90 : 95, buildKey: '' };
  if (flag('preview')) return { width: 960, height: 540, dpr: 1, fps: 30, format: 'jpeg', quality: 90, buildKey: '' };
  if (flag('4k')) return { width: 1920, height: 1080, dpr: 2, fps: 60, format: 'jpeg', quality: 95, buildKey: '' };
  return { width: 1920, height: 1080, dpr: 1, fps: 60, format: 'jpeg', quality: 95, buildKey: '' };
}

const log = (s: string) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${s}`;
  console.log(line);
  fs.appendFileSync(path.join(PROMO_DIR, 'render.log'), line + '\n');
};

async function capture(rs: RenderSettings, shoot = true): Promise<Map<string, ShotManifest>> {
  const only = opt('only', '').split(',').filter(Boolean);
  const all = withKeep(shotList());
  // --adopt KEY: shots captured under an earlier build key (a change known not to touch the picture or sound, e.g. tooling only) are
  // re-stamped with the current one instead of being re-shot
  const adopt = opt('adopt', '');
  if (adopt)
    for (const s of all) {
      const f = path.join(shotDir(s.id, rs), 'manifest.json');
      if (!fs.existsSync(f)) continue;
      const m = JSON.parse(fs.readFileSync(f, 'utf8')) as ShotManifest;
      if (m.hash !== shotHash(s, { ...rs, buildKey: adopt })) continue;
      m.hash = shotHash(s, rs);
      fs.writeFileSync(f, JSON.stringify(m, null, 1));
      log(`[render] adopted ${s.id} from build ${adopt}`);
    }
  const todo = all.filter((s) => (!only.length || only.includes(s.id)) && (flag('force') || !cached(s, rs)));
  const out = new Map<string, ShotManifest>();
  for (const s of all) {
    const m = cached(s, rs);
    if (m) out.set(s.id, m);
  }
  // without the capture stage the edit works from what is cached (a missing or stale shot is reported, not re-shot)
  if (!shoot && todo.length) {
    log(`[render] not captured (no capture stage): ${todo.map((s) => s.id).join(', ')}`);
    for (const s of todo) {
      const f = path.join(shotDir(s.id, rs), 'manifest.json');
      if (fs.existsSync(f)) out.set(s.id, JSON.parse(fs.readFileSync(f, 'utf8')) as ShotManifest);
    }
    return out;
  }
  if (!todo.length) {
    log(`[render] capture: all ${all.length} shots cached`);
    return out;
  }
  const load = systemLoad();
  log(`[render] capture: ${todo.length} of ${all.length} shots (${rs.width * rs.dpr}x${rs.height * rs.dpr} @ ${rs.fps}) | GPU ${load.gpu} | load ${load.loadavg.join(' ')}`);
  const srv = await startPreview();
  let chrome = await openChrome(rs);
  try {
    for (const s of todo) {
      try {
        out.set(s.id, await captureShot(chrome, srv.url, s, rs, log));
      } catch (e) {
        log(`[render] ${s.id} FAILED: ${(e as Error).message.split('\n')[0]}`);
        // a crashed tab / browser: start a fresh one for the next shot
        await chrome.close().catch(() => {});
        chrome = await openChrome(rs);
      }
    }
  } finally {
    await chrome.close();
    srv.stop();
  }
  return out;
}

function sheets(rs: RenderSettings, shots: Map<string, ShotManifest>) {
  const dir = path.join(PROMO_DIR, 'sheets');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, m] of shots) {
    const sd = shotDir(id, rs);
    // (a full-size render keeps only the frames the edit uses)
    const have = m.info.map((f) => f.i).filter((i) => fs.existsSync(path.join(sd, `${String(i).padStart(5, '0')}.${m.ext}`)));
    if (!have.length) continue;
    const n = Math.min(24, have.length);
    const args: string[] = [];
    for (let k = 0; k < n; k++) {
      const i = have[Math.round((k * (have.length - 1)) / Math.max(1, n - 1))];
      const f = m.info[i];
      args.push('-label', `${(i / m.fps).toFixed(2)}s ${f.sim.toFixed(2)} ${f.shot}`, path.join(sd, `${String(i).padStart(5, '0')}.${m.ext}`));
    }
    const out = path.join(dir, `${id}.jpg`);
    execFileSync('montage', [...args, '-tile', '6x', '-geometry', '400x225+3+3', '-pointsize', '13', '-background', '#111', '-fill', '#eee', out]);
  }
  log(`[render] sheets -> ${dir}`);
}

/** what the booth said in the cuts that quote it (the captured lines, timed to the edit) */
function quotes(rs: RenderSettings, shots: Map<string, ShotManifest>): Overlay[] {
  const { starts } = cutTimes();
  const out: Overlay[] = [];
  // (a caption never runs into a black card: the title, the end card)
  const blackAt = (t: number) => Math.min(...cutList().map((c, i) => (c.black && starts[i] > t ? starts[i] : Infinity)));
  const quote = (ev: { text?: string; name?: string; speaker?: string }, t0: number, t1: number): Overlay => ({ k: 'quote', t0, t1: Math.min(t1, blackAt(t0) - 0.15), who: ev.name ?? 'Booth', role: ev.speaker === 'color' ? 'analyst' : 'play-by-play', text: `\u201c${ev.text}\u201d` });
  for (const v of voiceList()) {
    // (the window the mix plays: it ends at a pause, so a line it cuts is not captioned)
    const w = voiceWindow(rs, v, shots.get(v.shot));
    if (!w) continue;
    const { src, vin, dur } = w;
    const t0a = shots.get(v.shot)!.audio!.t0;
    const mono = src[0].map((l, i) => (l + src[1][i]) / 2);
    for (const s of shots.get(v.shot)?.speech ?? []) {
      const ev = s.ev as { type: string; text?: string; name?: string; speaker?: string; channel?: string; expectedDurationMs?: number };
      if (ev.type !== 'speechStart' || ev.channel !== 'booth' || s.t < vin || s.t > vin + dur - 0.5) continue;
      // only the words the track plays (it stops at a pause, often before the end of a long call)
      const heard = heardText(ev.text ?? '', mono, Math.round((t0a + s.t) * SR), Math.round((t0a + vin + dur) * SR));
      if (!heard) continue;
      const t0 = v.at - v.pre + s.t - vin;
      if (cutList().some((c, i) => c.black && t0 >= starts[i] - 0.3 && t0 < starts[i] + c.beats * BEAT)) continue; // no caption over a card
      out.push(quote({ ...ev, text: heard }, t0, Math.min(v.at - v.pre + dur, t0 + Math.max(1.6, (ev.expectedDurationMs ?? 2000) / 1000 + 0.4))));
    }
  }
  cutList().forEach((c, i) => {
    if (!c.quote) return;
    const m = shots.get(c.shot);
    const dur = c.beats * BEAT;
    for (const s of m?.speech ?? []) {
      const ev = s.ev as { type: string; text?: string; name?: string; speaker?: string; channel?: string; expectedDurationMs?: number };
      const cin = resolveIn(c, m);
      if (ev.type !== 'speechStart' || ev.channel !== 'booth' || s.t < cin - 0.3 || s.t > cin + dur - 0.4) continue;
      const t0 = Math.max(starts[i], starts[i] + s.t - cin);
      out.push({ k: 'quote', t0, t1: Math.min(starts[i] + dur + 2.5, t0 + Math.max(1.6, (ev.expectedDurationMs ?? 2000) / 1000 + 0.4)), who: ev.name ?? 'Booth', role: ev.speaker === 'color' ? 'analyst' : 'play-by-play', text: `\u201c${ev.text}\u201d` });
    }
  });
  // one caption at a time: a line ends where the next begins
  const q = out.filter((o): o is Extract<Overlay, { k: 'quote' }> => o.k === 'quote').sort((a, b) => a.t0 - b.t0);
  for (let i = 0; i + 1 < q.length; i++) q[i].t1 = Math.min(q[i].t1, q[i + 1].t0 - 0.05);
  return out;
}

/**
 * The README teaser: 9 s of the walk-off (contact in slow motion, flight, fireworks) from the 1080p master, 1280x720, VP9 two-pass, no sound
 * (a README plays it muted), under 3 MB; and a poster frame. Written to ~/claudeball-promo/ (copy to docs/media/ to commit).
 */
function teaser(log: (s: string) => void) {
  const src = path.join(PROMO_DIR, 'promo-16x9-1080p60.mp4');
  if (!fs.existsSync(src)) return log('[teaser] no 1080p master yet');
  const { starts } = cutTimes();
  // from the walk-off contact (slow motion) through the flight to the first fireworks
  const from = starts[CUTS.findIndex((c) => c.shot === 'wo-contact')];
  const out = path.join(PROMO_DIR, 'teaser.webm');
  const vf = 'scale=1280:720:flags=lanczos,fps=30';
  for (const pass of [1, 2])
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(from), '-t', '9', '-i', src, '-vf', vf, '-an', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:v', 'libvpx-vp9', '-b:v', '2300k', '-maxrate', '3000k', '-bufsize', '4600k', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '1', '-pass', String(pass), '-passlogfile', path.join(PROMO_DIR, 'teaser-pass'), ...(pass === 1 ? ['-f', 'null', '/dev/null'] : [out])]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(from + 8.1), '-i', src, '-frames:v', '1', '-vf', 'scale=1280:720', '-q:v', '3', path.join(PROMO_DIR, 'teaser.jpg')]);
  log(`[teaser] ${out} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB) + teaser.jpg`);
}

/** short WAVs of the key moments, to audition (the master and the stems): the title, the drop, the walk-off */
function snippets(out: string, log: (s: string) => void) {
  const { starts } = cutTimes();
  const t = (shot: string, nth = 0) => starts[CUTS.map((c, i) => (c.shot === shot ? i : -1)).filter((i) => i >= 0)[nth]];
  const moments: [string, number, number][] = [
    ['title', t('open-face', 1) - 1.5, 5],
    ['drop', t('bang-first') - 2.5, 7],
    ['walkoff', t('wo-pitcher'), 12],
    ['endcard', t('wo-broadcast', 1) - 1, 8],
  ];
  const dir = path.join(out, 'snippets');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, from, dur] of moments)
    for (const f of ['master.wav', 'stems/music.wav', 'stems/game.wav', 'stems/voice.wav', 'stems/fx.wav'])
      execFileSync('sox', [path.join(out, f), path.join(dir, `${name}-${path.basename(f, '.wav')}.wav`), 'trim', String(Math.max(0, from)), String(dur)]);
  log(`[snippets] ${moments.length} moments x 5 -> ${dir}`);
}

/** a contact sheet of the finished video: a frame a second with its time */
function contact(file: string, sheet: string, log: (s: string) => void) {
  const tmp = fs.mkdtempSync(path.join(PROMO_DIR, 'contact-'));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', "fps=1,scale=480:-2,drawtext=text='%{pts\\:hms}':x=6:y=6:fontsize=16:fontcolor=yellow:box=1:boxcolor=black@0.6", path.join(tmp, '%03d.jpg')]);
  const files = fs.readdirSync(tmp).sort().map((f) => path.join(tmp, f));
  execFileSync('montage', [...files, '-tile', '8x', '-geometry', '+2+2', '-background', '#111', sheet]);
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`[contact] ${sheet}`);
}

async function main() {
  fs.mkdirSync(PROMO_DIR, { recursive: true });
  // no format given: everything, one format after the other (1080p and the README teaser, 4K, the vertical cut), each in its own process
  if (!['preview', '1080p', '4k', 'vertical'].some(flag)) {
    build(flag('no-build'));
    const rest = argv.filter((a) => a !== '--no-build');
    for (const f of ['--1080p', '--4k', '--vertical']) {
      log(`[render] === ${f.slice(2)} ===`);
      execFileSync(process.execPath, [...process.execArgv, new URL(import.meta.url).pathname, f, '--no-build', ...rest], { stdio: 'inherit' });
    }
    return;
  }
  build(flag('no-build'));
  const rs = { ...settings(), buildKey: buildKey() };
  const stages = opt('stages', `capture,sheets,titles,mix,picture,encode${flag('1080p') ? ',teaser,snippets' : ''}`).split(',');
  const shots = await capture(rs, stages.includes('capture'));
  if (stages.includes('sheets')) sheets(rs, shots);
  const tag = `${vertical ? 'vertical-' : ''}${flag('preview') ? 'preview' : flag('4k') ? '4k' : '1080p'}`;
  const out = path.join(PROMO_DIR, 'edit', tag);
  fs.mkdirSync(out, { recursive: true });
  const L = layout(rs, vertical);
  const ovl = path.join(out, 'ovl');
  if (stages.includes('titles')) {
    const chrome = await openChrome(rs);
    try {
      const has = await renderOverlay(chrome, [...overlayList(L, vertical), ...quotes(rs, shots)], L.W, L.H, L.fps, L.frames, ovl, log);
      fillOverlay(L, has, ovl);
    } finally {
      await chrome.close();
    }
  }
  const musicFile = opt('music', '');
  if (musicFile && path.resolve(musicFile).startsWith(path.resolve(out))) throw new Error('--music: keep your track outside edit/ (the mix writes its stems there)');
  if (stages.includes('mix')) mix(rs, shots, out, log, cutList(), voiceList(), musicFile ? path.resolve(musicFile) : undefined);
  const pic = stages.includes('picture') ? buildPicture(rs, shots, L, out, log, cutList()) : path.join(out, 'pic');
  if (stages.includes('snippets')) snippets(out, log);
  if (stages.includes('encode')) {
    const file = path.join(PROMO_DIR, vertical ? (flag('preview') ? 'promo-preview-vertical-540x960.mp4' : 'promo-9x16-1080x1920.mp4') : flag('preview') ? 'promo-preview-540p30.mp4' : flag('4k') ? 'promo-16x9-2160p60.mp4' : 'promo-16x9-1080p60.mp4');
    encode(L, pic, ovl, path.join(out, 'master.wav'), file, { bitrate: flag('preview') ? '6M' : flag('4k') ? '60M' : '20M', preview: flag('preview') }, log);
    contact(file, file.replace(/\.mp4$/, '-contact.jpg'), log);
  }
  // (from the encoded 1080p master: after the encode)
  if (stages.includes('teaser') && !vertical && !flag('preview') && !flag('4k')) teaser(log);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

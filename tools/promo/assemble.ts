/**
 * Assembles the promo from the cached shots: the picture timeline (a symlink per output frame into the shots' frames, black cards,
 * the phone composite), the audio mix (each cut's game audio from its shot, the booth where the edit wants it, the music bed ducked
 * under the booth, the produced effects; loudness to -14 LUFS, true peak under -1 dBTP; stems exported), and the encode.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, lufsIntegrated, loudnessRange, truePeak } from '../../src/audio/venue/analysis';
import { writeWav } from '../audio/render';
import { shotDir, type RenderSettings, type ShotManifest } from './capture';
import { BEAT, CUTS, VOICE, cutTimes, musicPlan, overlays, resolveIn, voiceIn, type Cut, type VoiceTrack } from './edit';
import { SR, dbGain, limit, readWav, speechEnd, type Stereo } from './dsp';
import { renderMusic } from './music';
import type { Overlay } from './overlay';

export interface Layout {
  W: number;
  H: number;
  fps: number;
  frames: number;
  phoneRect: [number, number, number, number];
}

export function layout(rs: RenderSettings, portrait = false): Layout {
  const W = (portrait ? rs.height : rs.width) * rs.dpr, H = (portrait ? rs.width : rs.height) * rs.dpr;
  const { total } = cutTimes();
  // the phone: a 9:19.5 screen, 78 % of the frame's height, right of centre (the caption sits left)
  const ph = Math.round(H * 0.78), pw = Math.round((ph * 9) / 19.5);
  const phoneRect: [number, number, number, number] = portrait ? [Math.round((W - W * 0.7) / 2), Math.round(H * 0.08), Math.round(W * 0.7), Math.round(W * 0.7 * 19.5 / 9)] : [Math.round(W * 0.66 - pw / 2), Math.round((H - ph) / 2), pw, ph];
  return { W, H, fps: rs.fps, frames: Math.round(total * rs.fps), phoneRect };
}

export function overlayList(L: Layout, portrait = false): Overlay[] {
  // (the vertical cut shows the phone footage full frame: no phone drawn round it)
  return overlays()
    .filter((o) => !(portrait && o.k === 'phone'))
    .map((o) => (o.k === 'phone' ? { ...o, rect: L.phoneRect } : o));
}

/** the picture: out/pic/00000.jpg ... as symlinks (or composites) */
export function buildPicture(rs: RenderSettings, shots: Map<string, ShotManifest>, L: Layout, out: string, log: (s: string) => void, cuts: Cut[] = CUTS) {
  const pic = path.join(out, 'pic');
  fs.rmSync(pic, { recursive: true, force: true });
  fs.mkdirSync(pic, { recursive: true });
  const black = path.join(out, 'black.jpg');
  execFileSync('magick', ['-size', `${L.W}x${L.H}`, 'xc:#05070b', '-quality', '95', black]);
  const { starts } = cutTimes();
  let composites = 0;
  for (let f = 0; f < L.frames; f++) {
    const t = f / L.fps;
    let ci = starts.length - 1;
    while (ci > 0 && starts[ci] > t + 1e-9) ci--;
    const c = cuts[ci];
    const dst = path.join(pic, `${String(f).padStart(5, '0')}.jpg`);
    if (c.black) {
      fs.symlinkSync(black, dst);
      continue;
    }
    const m = shots.get(c.shot);
    if (!m) throw new Error(`shot ${c.shot} is not captured`);
    const sf = Math.min(m.frames - 1, Math.max(0, Math.round((resolveIn(c, m) + (t - starts[ci])) * m.fps)));
    const src = path.join(shotDir(c.shot, rs), `${String(sf).padStart(5, '0')}.${m.ext}`);
    if (c.phone) {
      // the portrait capture inside the phone, over the night park (the aerial, blurred and darkened)
      const bgShot = shots.get('open-aerial');
      const bg = bgShot ? path.join(shotDir('open-aerial', rs), `${String(Math.min(bgShot.frames - 1, sf)).padStart(5, '0')}.${bgShot.ext}`) : black;
      const [x, y, w, h] = L.phoneRect;
      execFileSync('magick', [bg, '-resize', `${L.W}x${L.H}!`, '-blur', '0x14', '-brightness-contrast', '-35x-10', '(', src, '-resize', `${w}x${h}!`, ')', '-geometry', `+${x}+${y}`, '-composite', '-quality', '95', dst]);
      composites++;
      continue;
    }
    const size = m.size;
    if (size[0] !== L.W || size[1] !== L.H) {
      // another size or shape (the phone's viewport in the vertical cut): fill the frame, centred
      execFileSync('magick', [src, '-resize', `${L.W}x${L.H}^`, '-gravity', 'center', '-extent', `${L.W}x${L.H}`, '-quality', '95', dst]);
      composites++;
    } else fs.symlinkSync(src, dst);
  }
  log(`[assemble] picture: ${L.frames} frames (${composites} composited) -> ${pic}`);
  return pic;
}

/** the overlay frames: a transparent PNG for every frame without type */
export function fillOverlay(L: Layout, has: boolean[], dir: string) {
  const empty = path.join(dir, '_empty.png');
  execFileSync('magick', ['-size', `${L.W}x${L.H}`, 'xc:none', `PNG32:${empty}`]); // RGBA like the canvas's PNGs (a grey+alpha one reads as opaque black in the overlay)
  for (let f = 0; f < L.frames; f++) if (!has[f]) fs.symlinkSync(empty, path.join(dir, `${String(f).padStart(5, '0')}.png`));
}

const zeros = (n: number): Stereo => [new Float32Array(n), new Float32Array(n)];
const addInto = (dst: Stereo, src: Stereo, gain = 1) => {
  for (let c = 0; c < 2; c++) for (let i = 0; i < Math.min(dst[c].length, src[c].length); i++) dst[c][i] += src[c][i] * gain;
};
const loud = (s: Stereo) => lufsIntegrated(s as unknown as Float32Array[], SR);

/** the mix: returns the master and writes the stems */
/**
 * `musicFile`: a music track to use instead of the bed written in code (e.g. a YuE render at 120 BPM): a WAV at 48 kHz, mono or stereo,
 * laid from the start of the timeline (padded with silence or cut to its length); it gets the same level and the same duck under the
 * booth as the code bed, and the produced effects stay. The file itself is only read.
 */
/** a booth track's window in its take: where it starts (shot seconds) and how long it runs, ended at a pause (never mid-word) */
export function voiceWindow(rs: RenderSettings, v: VoiceTrack, m: ShotManifest | undefined): { src: Stereo; vin: number; dur: number } | null {
  const file = path.join(shotDir(v.shot, rs), 'booth.wav');
  if (!m?.audio || !fs.existsSync(file)) return null;
  const vin = voiceIn(v, m);
  if (vin === null) return null;
  const src = readWav(file).ch as Stereo;
  const from = Math.round((m.audio.t0 + vin) * SR);
  const mono = src[0].map((l, i) => (l + src[1][i]) / 2);
  return { src, vin, dur: speechEnd(mono, from, Math.round(v.dur * SR)) / SR };
}

export function mix(rs: RenderSettings, shots: Map<string, ShotManifest>, out: string, log: (s: string) => void, cuts: Cut[] = CUTS, voice: VoiceTrack[] = VOICE, musicFile?: string): { master: Stereo; report: Record<string, number> } {
  const { starts, total } = cutTimes();
  const n = Math.ceil(total * SR);
  const park = zeros(n), booth = zeros(n);
  const cache = new Map<string, { park: Stereo; booth: Stereo; t0: number }>();
  const fadeS = Math.round(0.012 * SR);
  cuts.forEach((c, i) => {
    if (c.black || (c.park == null && c.booth == null)) return;
    const m = shots.get(c.shot);
    if (!m?.audio) return;
    if (!cache.has(c.shot)) {
      const dir = shotDir(c.shot, rs);
      const p = path.join(dir, 'park.wav'), b = path.join(dir, 'booth.wav');
      if (!fs.existsSync(p)) return;
      cache.set(c.shot, { park: readWav(p).ch as Stereo, booth: readWav(b).ch as Stereo, t0: m.audio.t0 });
    }
    const a = cache.get(c.shot)!;
    const from = Math.round((a.t0 + resolveIn(c, m)) * SR), at0 = Math.round(starts[i] * SR), len = Math.round(c.beats * BEAT * SR);
    for (const [src, dst, g] of [[a.park, park, c.park], [a.booth, booth, c.booth]] as const) {
      if (g == null) continue;
      const gain = dbGain(g);
      for (let k = 0; k < len; k++) {
        const s = from + k, d = at0 + k;
        if (s < 0 || s >= src[0].length || d >= n) continue;
        const env = Math.min(1, k / fadeS, (len - k) / fadeS);
        dst[0][d] += src[0][s] * gain * env;
        dst[1][d] += src[1][s] * gain * env;
      }
    }
  });
  // continuous booth tracks over several cuts (the climax's call)
  for (const v of voice) {
    const w = voiceWindow(rs, v, shots.get(v.shot));
    if (!w) {
      if (shots.get(v.shot)?.audio) log(`[mix] WARNING: ${v.shot} has no booth line "${v.line}" in this take`);
      continue;
    }
    const { src, vin, dur } = w;
    if (Math.abs(dur - v.dur) > 0.01) log(`[mix] ${v.shot}: the booth track ends at a pause, ${dur.toFixed(2)} s instead of ${v.dur} s`);
    const m = shots.get(v.shot)!;
    const from = Math.round((m.audio!.t0 + vin) * SR), at0 = Math.round((v.at - v.pre) * SR), len = Math.round(dur * SR), fl = Math.round(0.06 * SR);
    const g = dbGain(v.db);
    for (let k = 0; k < len; k++) {
      const sI = from + k, d = at0 + k;
      if (sI < 0 || sI >= src[0].length || d < 0 || d >= n) continue;
      const env = Math.min(1, k / fl, (len - k) / fl);
      booth[0][d] += src[0][sI] * g * env;
      booth[1][d] += src[1][sI] * g * env;
    }
  }
  const plan = musicPlan();
  const mus = renderMusic(plan);
  const band = zeros(n);
  if (musicFile) {
    const w = readWav(musicFile);
    if (w.sr !== SR) throw new Error(`${musicFile}: ${w.sr} Hz, the mix runs at ${SR} (resample it first, e.g. sox in.wav -r 48000 out.wav)`);
    const l = w.ch[0], r = w.ch[1] ?? w.ch[0];
    for (let i = 0; i < Math.min(n, l.length); i++) {
      band[0][i] = l[i];
      band[1][i] = r[i];
    }
    log(`[mix] music: ${musicFile} (${(l.length / SR).toFixed(1)} s) instead of the code bed`);
  } else {
    addInto(band, mus.music);
    addInto(band, mus.drums);
  }
  const fx = zeros(n);
  addInto(fx, mus.fx);
  // stem levels (integrated loudness over the whole timeline)
  const norm = (s: Stereo, target: number) => {
    const l = loud(s);
    if (Number.isFinite(l)) addInto(s, s, dbGain(target - l) - 1);
  };
  norm(band, -16);
  norm(park, -21);
  norm(fx, -22);
  // the booth sits on top while it speaks: its loudest moments around -13 LUFS short-term
  norm(booth, -24);
  // duck the band under the booth (and a little under the game's big moments: the crowd's roar)
  const env = new Float32Array(n);
  {
    let e = 0;
    const att = Math.exp(-1 / (0.03 * SR)), rel = Math.exp(-1 / (0.45 * SR));
    for (let i = 0; i < n; i++) {
      const x = Math.abs(booth[0][i]) + Math.abs(booth[1][i]);
      e = x > e ? x + (e - x) * att : x + (e - x) * rel;
      env[i] = e;
    }
  }
  for (let i = 0; i < n; i++) {
    const g = 1 / (1 + 6 * Math.min(1, env[i] * 8));
    band[0][i] *= g;
    band[1][i] *= g;
  }
  const sum = zeros(n);
  addInto(sum, band);
  addInto(sum, park);
  addInto(sum, booth);
  addInto(sum, fx);
  // master: to -14 LUFS, then the true-peak limiter at -1 dBTP; once more for what the limiter took off
  let master = sum;
  for (let pass = 0; pass < 3; pass++) {
    const l = loud(master);
    const g = dbGain(-14 - l);
    const scaled: Stereo = [master[0].map((v) => v * g), master[1].map((v) => v * g)];
    master = limit(scaled, -2.2, 0.005, 0.15); // AAC adds up to ~1 dB of inter-sample overshoot: the encoded file stays under -1 dBTP
  }
  const report = {
    lufs: +loud(master).toFixed(2),
    truePeakDb: +db(truePeak(master as unknown as Float32Array[])).toFixed(2),
    lra: +loudnessRange(master as unknown as Float32Array[], SR).toFixed(2),
    bandLufs: +loud(band).toFixed(1),
    parkLufs: +loud(park).toFixed(1),
    boothLufs: +loud(booth).toFixed(1),
    fxLufs: +loud(fx).toFixed(1),
  };
  const sd = path.join(out, 'stems');
  fs.mkdirSync(sd, { recursive: true });
  writeWav(path.join(sd, 'music.wav'), band as unknown as Float32Array[], SR);
  writeWav(path.join(sd, 'fx.wav'), fx as unknown as Float32Array[], SR);
  writeWav(path.join(sd, 'game.wav'), park as unknown as Float32Array[], SR);
  writeWav(path.join(sd, 'voice.wav'), booth as unknown as Float32Array[], SR);
  writeWav(path.join(out, 'master.wav'), master as unknown as Float32Array[], SR);
  log(`[mix] master ${report.lufs} LUFS, true peak ${report.truePeakDb} dBTP, LRA ${report.lra} | stems: band ${report.bandLufs} park ${report.parkLufs} booth ${report.boothLufs} fx ${report.fxLufs} -> ${sd}`);
  return { master, report };
}

/** H.264 high, yuv420p, faststart, AAC 320k; film grain added at the encode */
/** integrated loudness and true peak of a media file's audio, by ffmpeg's EBU R128 meter (it reports on stderr) */
function r128(file: string): { lufs: number; tp: number } {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return parseR128(String(r.stderr ?? ''));
}
function parseR128(s: string) {
  const sum = s.slice(s.lastIndexOf('Summary:'));
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(sum), p = /Peak:\s+(-?[\d.]+) dBFS/.exec(sum.slice(sum.indexOf('True peak')));
  return { lufs: i ? +i[1] : NaN, tp: p ? +p[1] : NaN };
}

export function encode(L: Layout, pic: string, ovl: string, wav: string, file: string, opts: { bitrate: string; preview?: boolean }, log: (s: string) => void) {
  const grain = L.H >= 2000 ? 5 : 4;
  // AAC adds inter-sample overshoot: encode the audio alone, measure its true peak, and trim the gain so the file stays under -1 dBTP
  const probe = file.replace(/\.mp4$/, '.probe.m4a');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', probe]);
  const m = r128(probe);
  fs.rmSync(probe, { force: true });
  const trim = Number.isFinite(m.tp) && m.tp > -1.1 ? -(m.tp + 1.1) : 0;
  log(`[encode] AAC round trip: ${m.lufs} LUFS, ${m.tp} dBTP${trim ? ` -> gain ${trim.toFixed(2)} dB` : ''}`);
  const args = [
    '-y', '-loglevel', 'error', '-stats',
    '-framerate', String(L.fps), '-i', path.join(pic, '%05d.jpg'),
    '-framerate', String(L.fps), '-i', path.join(ovl, '%05d.png'),
    '-i', wav,
    // (the frames are full-range sRGB JPEG / PNG: convert to limited-range BT.709, as players expect, and say so in the stream)
    '-filter_complex', `[0:v][1:v]overlay=format=auto,noise=alls=${grain}:allf=t,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]`,
    '-map', '[v]', '-map', '2:a', '-af', `volume=${trim.toFixed(2)}dB`,
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', opts.preview ? 'veryfast' : 'slow', '-b:v', opts.bitrate, '-maxrate', opts.bitrate.replace(/\d+/, (d) => String(Math.round(+d * 1.25))), '-bufsize', opts.bitrate.replace(/\d+/, (d) => String(+d * 2)),
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '320k', '-ar', '48000',
    '-shortest', file,
  ];
  // the overshoot of the final mux is not exactly the probe's: check the file, and re-encode with more trim until it is under -1 dBTP
  let f = { lufs: NaN, tp: NaN };
  let gain = trim;
  for (let pass = 0; pass < 3; pass++) {
    const a = [...args];
    a[a.indexOf('-af') + 1] = `volume=${gain.toFixed(2)}dB`;
    execFileSync('ffmpeg', a, { stdio: ['ignore', 'ignore', 'inherit'] });
    f = r128(file);
    if (!(f.tp > -1.0)) break;
    gain -= f.tp + 1.15;
    log(`[encode] true peak ${f.tp} dBTP over -1: again at ${gain.toFixed(2)} dB`);
  }
  log(`[encode] ${file} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB): ${f.lufs} LUFS, true peak ${f.tp} dBTP`);
}

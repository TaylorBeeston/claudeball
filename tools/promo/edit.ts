/**
 * The edit: one timeline on a 120 BPM grid (a beat = 0.5 s, a bar = 2 s) that drives the picture (which shot, from where, for how many
 * beats), the typography layer, the music's sections and hits, and the audio rules per cut. Cold open -> title -> build (what is real)
 * -> drop (the montage) -> the phone -> the walk-off -> end card.
 *
 * Every number on screen is the sim's own (exit velocity, pitch speed, the margin at first); the lines in quotes are what the game's
 * booth said in that shot (captured with the audio).
 */
import type { MusicPlan } from './music';
import type { Overlay } from './overlay';

export const BPM = 120;
export const BEAT = 60 / BPM;

export interface Cut {
  shot: string;
  /** where in the shot (output seconds from its first frame) the cut starts */
  in: number;
  beats: number;
  /** the shot's game audio: park (crowd, bat, PA, organ: the game's own soundscape) and booth level in dB (null = off) */
  park?: number | null;
  booth?: number | null;
  /** show what the booth says in this cut as a quote (the captured line) */
  quote?: boolean;
  /** portrait footage placed inside the phone */
  phone?: boolean;
  /** black instead of a picture (title card) */
  black?: boolean;
}

export const CUTS: Cut[] = [
  // cold open (night): 0 - 14 s
  { shot: 'open-aerial', in: 0.4, beats: 8, park: -6, booth: null },
  { shot: 'open-crane', in: 0, beats: 8, park: -4, booth: null },
  { shot: 'open-face', in: 0.4, beats: 4, park: -6, booth: null },
  { shot: 'open-face', in: 2.4, beats: 8, black: true, park: null, booth: null },
  // build: 14 - 30 s
  { shot: 'pitch-flight', in: 0.1, beats: 5, park: -8, booth: null },
  { shot: 'pitch-mitt', in: 0.3, beats: 3, park: -4, booth: null },
  { shot: 'strikeout-hud', in: 1.6, beats: 6, park: -3, booth: null },
  { shot: 'contact-bomb', in: 0.3, beats: 7, park: -10, booth: null },
  { shot: 'bomb-flight', in: 0, beats: 3, park: -2, booth: null },
  { shot: 'robbed', in: 0.6, beats: 8, park: -3, booth: null },
  // drop: 30 - 50 s
  { shot: 'bang-first', in: 9.0, beats: 6, park: -3, booth: null },
  { shot: 'triple-play', in: 0.8, beats: 5, park: -4, booth: null },
  { shot: 'steal-third', in: 1.0, beats: 3, park: -4, booth: null },
  { shot: 'double-play', in: 0.6, beats: 3, park: -4, booth: null },
  { shot: 'face-card', in: 0.8, beats: 4, park: -6, booth: null },
  { shot: 'pickoff', in: 4.0, beats: 4, park: -4, booth: null },
  { shot: 'inside-park', in: 12.0, beats: 5, park: -3, booth: null },
  { shot: 'bomb-broadcast', in: 7.0, beats: 5, park: -2, booth: null },
  { shot: 'bomb-broadcast', in: 20.0, beats: 5, park: -4, booth: null },
  // the phone: 50 - 54 s
  { shot: 'phone-portrait', in: 1.0, beats: 8, phone: true, park: null, booth: null },
  // the walk-off: 54 - 66 s
  { shot: 'wo-pitcher', in: 0.2, beats: 3, park: -3, booth: null },
  { shot: 'wo-contact', in: 0.1, beats: 7, park: -12, booth: null },
  { shot: 'wo-flight', in: 0.3, beats: 6, park: 0, booth: 0, quote: true },
  { shot: 'wo-fireworks', in: 0.4, beats: 5, park: 0, booth: 0 },
  { shot: 'wo-broadcast', in: 22.0, beats: 3, park: -2, booth: null },
  // end card: 66 - 74 s
  { shot: 'wo-broadcast', in: 25.0, beats: 16, black: true, park: null, booth: null },
];

/** the start time (s) of every cut, and the total */
export function cutTimes(): { starts: number[]; total: number } {
  const starts: number[] = [];
  let t = 0;
  for (const c of CUTS) {
    starts.push(t);
    t += c.beats * BEAT;
  }
  return { starts, total: t };
}

const at = (shot: string, nth = 0) => {
  const { starts } = cutTimes();
  const idx = CUTS.map((c, i) => (c.shot === shot ? i : -1)).filter((i) => i >= 0)[nth];
  return { t0: starts[idx], t1: starts[idx] + CUTS[idx].beats * BEAT };
};

/** the typography layer, on the same clock */
export function overlays(): Overlay[] {
  const { total } = cutTimes();
  const pitch = at('pitch-flight'), ko = at('strikeout-hud'), bat = at('contact-bomb'), fly = at('bomb-flight'), rob = at('robbed');
  const bang = at('bang-first'), tp = at('triple-play'), face = at('face-card'), itp = at('inside-park'), park = at('bomb-broadcast', 0);
  const phone = at('phone-portrait');
  const title = at('open-face', 1);
  const end = at('wo-broadcast', 1);
  const o: Overlay[] = [
    { k: 'fill', t0: 0, t1: 0.8, color: '#000', a0: 1, a1: 0 },
    { k: 'fill', t0: title.t0, t1: title.t1, color: '#05070b', a0: 1, a1: 1 },
    { k: 'flash', t: title.t0, dur: 0.35, color: '#fff3c8' },
    { k: 'title', t0: title.t0, t1: title.t1 - 0.05 },
    { k: 'tagline', t0: title.t0 + 1.0, t1: title.t1 - 0.05, lines: ['Two AIs. One ballgame.', 'Nothing scripted.'], step: 1.0 },
    { k: 'caption', t0: pitch.t0 + 0.15, t1: at('pitch-mitt').t1 - 0.1, text: 'Every pitch is physics', sub: 'drag · Magnus · spin, simulated in flight' },
    { k: 'stat', t0: ko.t0 + 0.8, t1: ko.t1 - 0.1, value: '100.6 mph', label: 'strike three, from the sim', side: 'right' },
    { k: 'caption', t0: bat.t0 + 0.3, t1: bat.t1 - 0.1, text: 'Real bat–ball contact', sub: 'a swung bat meets a spinning ball' },
    { k: 'stat', t0: fly.t0 + 0.05, t1: fly.t1 - 0.05, value: '123.8 mph', label: 'off the bat', side: 'right' },
    { k: 'caption', t0: rob.t0 + 0.3, t1: rob.t1 - 0.1, text: 'Fielders read the ball', sub: 'and climb the wall to take one back' },
    { k: 'flash', t: bang.t0, dur: 0.3 },
    { k: 'stat', t0: bang.t0 + 0.3, t1: bang.t1 - 0.1, value: '0.02 s', label: 'bang-bang at first', side: 'right' },
    { k: 'caption', t0: tp.t0 + 0.2, t1: tp.t1 - 0.1, text: 'Triple play', sub: '5-4-3, around the horn' },
    { k: 'caption', t0: face.t0 + 0.1, t1: face.t1 - 0.1, text: 'Every player rated', sub: '20-80 scouting grades drive the sim', side: 'right' },
    { k: 'caption', t0: itp.t0 + 0.2, t1: itp.t1 - 0.1, text: 'A broadcast that calls itself', sub: 'cameras, replays, a two-man booth' },
    { k: 'caption', t0: park.t0 + 0.2, t1: park.t1 - 0.1, text: 'A living ballpark', sub: 'crowd, organ, PA, a pitch clock', side: 'right' },
    { k: 'phone', t0: phone.t0, t1: phone.t1, rect: [0, 0, 0, 0] },
    { k: 'caption', t0: phone.t0 + 0.3, t1: phone.t1 - 0.1, text: 'Runs in your browser', sub: 'desktop or phone · free · open source' },
    { k: 'fill', t0: end.t0 - 0.35, t1: end.t0, color: '#000', a0: 0, a1: 1 },
    { k: 'endcard', t0: end.t0, t1: total },
    { k: 'fill', t0: total - 0.6, t1: total, color: '#000', a0: 0, a1: 1 },
  ];
  return o;
}

/** the music follows the edit: sections in bars, a hit on the cuts that matter, the band out for the walk-off's slow motion */
export function musicPlan(): MusicPlan {
  const { starts, total } = cutTimes();
  const title = at('open-face', 1), drop = at('bang-first'), contact = at('wo-contact'), flight = at('wo-flight');
  const hits: MusicPlan['hits'] = [
    { t: title.t0, kind: 'boom', gain: 1 },
    { t: title.t0, kind: 'revcrash', len: 1.6, gain: 0.7 },
    { t: drop.t0, kind: 'riser', len: 4, gain: 0.8 },
    { t: drop.t0, kind: 'impact', gain: 1 },
    { t: contact.t0 + 0.9, kind: 'boom', gain: 0.9 },
    { t: flight.t0, kind: 'impact', gain: 1 },
    { t: flight.t0, kind: 'revcrash', len: 1.2, gain: 0.6 },
    { t: at('wo-broadcast', 1).t0, kind: 'boom', gain: 0.8 },
  ];
  // a whoosh into every cut in the build and the drop (not on the hard hits above)
  starts.forEach((t, i) => {
    if (t > 14 && t < 50 && !hits.some((h) => Math.abs(h.t - t) < 0.1)) hits.push({ t, kind: 'whoosh', gain: 0.35, len: 0.5 });
  });
  return {
    bpm: BPM,
    seconds: total,
    sections: [
      { kind: 'intro', bars: 5 },
      { kind: 'title', bars: 2 },
      { kind: 'build', bars: 6 },
      { kind: 'lift', bars: 2 },
      { kind: 'drop', bars: 10 },
      { kind: 'break', bars: 2 },
      { kind: 'climax', bars: 6 },
      { kind: 'outro', bars: 4 },
    ],
    hits,
    stops: [{ t0: contact.t0 + 0.4, t1: flight.t0 }],
  };
}

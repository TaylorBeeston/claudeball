/**
 * Organ music as data (pure, no Web Audio, unit-tested): pieces are a melody plus chord changes, compiled into timed note events.
 *
 * Tunes: the seventh-inning stretch is the chorus of "Take Me Out to the Ball Game" (Albert Von Tilzer / Jack Norworth, 1908,
 * public domain), transcribed note for note (3/4, C major, chords as in the usual lead sheets). The "charge" figure is the traditional
 * bugle call, the "shave and a haircut" tag is a stock ballpark riff; everything else is original to this project.
 */
export type OrganId =
  | 'stretch' // Take Me Out to the Ball Game (chorus)
  | 'charge' // the bugle-call figure
  | 'rally' // a longer rally build: charge, charge a step up, then a tag
  | 'hr_fanfare'
  | 'ditty' // between-innings riff (cycles through three)
  | 'ditty2'
  | 'ditty3'
  | 'sting' // "shave and a haircut" two-bit tag
  | 'walk_up'
  | 'dirge'
  | 'bed' // soft chord bed with arpeggios (cycles through three progressions)
  | 'bed2'
  | 'bed3';

export type Layer = 'lead' | 'chord' | 'bass' | 'arp';

export interface NoteEvent {
  /** start, in beats from the start of the piece */
  at: number;
  dur: number;
  midi: number;
  vel: number;
  layer: Layer;
}

/** [midi note (0 = rest), beats] */
export type Step = [number, number];

type Comp = 'waltz' | 'stab' | 'pad' | 'march' | 'none';

interface Section {
  /** chord symbols, one per bar (or `bars` bars for the last symbol repeated) */
  chords: string[];
  comp: Comp;
}

export interface Piece {
  id: OrganId;
  /** priority: a higher one cuts a lower one that is playing */
  pri: number;
  bpm: number;
  beatsPerBar: number;
  lead: Step[];
  /** lead-in bars before the melody (chords only) */
  introBars?: number;
  sections: Section[];
  /** swell the leslie to the fast "tremolo" speed (fanfares) */
  fast?: boolean;
  /** arpeggio the chord tones (bed) instead of a lead */
  arp?: boolean;
  /** bed pieces loop until stopped */
  loop?: boolean;
  /** relative loudness */
  level: number;
}

const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** chord symbol -> pitch classes: triad or dominant 7th, minor with "m" (Dm, Am, Cm) */
export function chordPcs(sym: string): { root: number; pcs: number[] } {
  const m = /^([A-G])([#b]?)(m?)(7?)$/.exec(sym);
  if (!m) throw new Error(`bad chord ${sym}`);
  const root = (NOTE_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  const minor = m[3] === 'm';
  const pcs = [root, (root + (minor ? 3 : 4)) % 12, (root + 7) % 12];
  if (m[4] === '7') pcs.push((root + 10) % 12);
  return { root, pcs };
}

/** close voicing of the chord just above middle C (organ left hand): notes in 55..70 */
export function chordVoicing(sym: string): number[] {
  const { pcs } = chordPcs(sym);
  return pcs.map((pc) => {
    let n = 48 + pc;
    while (n < 55) n += 12;
    while (n > 66) n -= 12;
    return n;
  }).sort((a, b) => a - b);
}

/** pedal bass: the chord root in 36..47 */
export function bassNote(sym: string): number {
  let n = 36 + chordPcs(sym).root;
  if (n > 47) n -= 12;
  return n;
}

const beatsOf = (steps: Step[]) => steps.reduce((a, s) => a + s[1], 0);

function compBar(out: NoteEvent[], sym: string, comp: Comp, at: number, bpb: number) {
  const v = chordVoicing(sym);
  const bass = bassNote(sym);
  switch (comp) {
    case 'waltz': // oom-pah-pah
      out.push({ at, dur: 0.9, midi: bass, vel: 0.9, layer: 'bass' });
      for (const beat of [1, 2]) for (const m of v) out.push({ at: at + beat, dur: 0.7, midi: m, vel: 0.65, layer: 'chord' });
      break;
    case 'march': // bass on 1 and 3, chord on 2 and 4
      for (const b of [0, 2]) out.push({ at: at + b, dur: 0.9, midi: bass, vel: 0.9, layer: 'bass' });
      for (const b of [1, 3]) for (const m of v) out.push({ at: at + b, dur: 0.7, midi: m, vel: 0.65, layer: 'chord' });
      break;
    case 'stab':
      out.push({ at, dur: bpb * 0.9, midi: bass, vel: 0.9, layer: 'bass' });
      for (const m of v) out.push({ at, dur: bpb * 0.9, midi: m, vel: 0.8, layer: 'chord' });
      break;
    case 'pad':
      out.push({ at, dur: bpb, midi: bass, vel: 0.6, layer: 'bass' });
      for (const m of v) out.push({ at, dur: bpb, midi: m, vel: 0.5, layer: 'chord' });
      break;
    default:
      break;
  }
}

/** Compile a piece into note events (beats). */
export function buildPiece(p: Piece): NoteEvent[] {
  const out: NoteEvent[] = [];
  const bpb = p.beatsPerBar;
  const intro = p.introBars ?? 0;
  const bars: { sym: string; comp: Comp }[] = [];
  for (const s of p.sections) for (const sym of s.chords) bars.push({ sym, comp: s.comp });
  bars.forEach((b, i) => compBar(out, b.sym, b.comp, i * bpb, bpb));
  // melody starts after the intro bars
  let t = intro * bpb;
  if (p.arp) {
    // arpeggio: eighth notes over the chord tones of the current bar
    bars.forEach((b, i) => {
      const v = chordVoicing(b.sym).map((n) => n + 12);
      const pat = [0, 1, 2, 1, 0, 1, 2, 1];
      for (let k = 0; k < bpb * 2; k++) out.push({ at: i * bpb + k * 0.5, dur: 0.45, midi: v[pat[k % pat.length] % v.length], vel: 0.35, layer: 'arp' });
    });
  } else {
    for (const [m, beats] of p.lead) {
      if (m > 0) out.push({ at: t, dur: Math.max(0.12, beats * 0.94), midi: m, vel: 1, layer: 'lead' });
      t += beats;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export const pieceBeats = (p: Piece) => Math.max(p.sections.reduce((a, s) => a + s.chords.length, 0) * p.beatsPerBar, (p.introBars ?? 0) * p.beatsPerBar + beatsOf(p.lead));

// ---- the stretch: chorus of Take Me Out to the Ball Game ------------------------------------------------------------------

const C4 = 60, D4 = 62, E4 = 64, F4 = 65, Fs4 = 66, G4 = 67, Gs4 = 68, A4 = 69, B4 = 71, C5 = 72, D5 = 74, E5 = 76, F5 = 77, Fs5 = 78, G5 = 79, A5 = 81, C6 = 84;

/** The chorus, 31 bars of 3/4 (ties merged). */
export const TAKE_ME_OUT: Step[] = [
  [C4, 2], [C5, 1], [A4, 1], [G4, 1], [E4, 1], [G4, 3], [D4, 3], // Take me out to the ball game
  [C4, 2], [C5, 1], [A4, 1], [G4, 1], [E4, 1], [G4, 4], [0, 2], // take me out with the crowd
  [A4, 1], [Gs4, 1], [A4, 1], [E4, 1], [F4, 1], [G4, 1], [A4, 2], [F4, 1], [D4, 3], // buy me some peanuts and Cracker Jack
  [A4, 2], [A4, 1], [A4, 1], [B4, 1], [C5, 1], [D5, 1], [B4, 1], [A4, 1], [G4, 1], [E4, 1], [D4, 1], // I don't care if I never get back
  [C4, 2], [C5, 1], [A4, 1], [G4, 1], [E4, 1], [G4, 3], [D4, 2], [D4, 1], // let me root, root, root for the home team
  [C4, 2], [D4, 1], [E4, 1], [F4, 1], [G4, 1], [A4, 4], [A4, 1], [B4, 1], // if they don't win it's a shame, for it's
  [C5, 3], [C5, 3], [C5, 1], [B4, 1], [A4, 1], [G4, 1], [Fs4, 1], [G4, 1], [A4, 3], [B4, 3], [C5, 3], // one, two, three strikes you're out at the old ball game
];

const STRETCH_CHORDS = ['C', 'C', 'G', 'G7', 'C', 'C', 'G', 'G7', 'A7', 'A7', 'Dm', 'Dm', 'D', 'D', 'G7', 'G7', 'C', 'C', 'G7', 'G7', 'C7', 'C7', 'F', 'F', 'F', 'D7', 'C', 'A7', 'D7', 'G7', 'C'];

export const PIECES: Record<OrganId, Piece> = {
  stretch: { id: 'stretch', pri: 5, bpm: 138, beatsPerBar: 3, introBars: 1, lead: TAKE_ME_OUT, sections: [{ chords: ['G7'], comp: 'waltz' }, { chords: STRETCH_CHORDS, comp: 'waltz' }], level: 1.1 },
  // the bugle-call figure over a C chord: da-da-da-DAH ... da-DAH
  charge: { id: 'charge', pri: 3, bpm: 148, beatsPerBar: 4, lead: [[G4, 0.5], [C5, 0.5], [E5, 0.5], [G5, 1.5], [E5, 0.5], [G5, 2.5]], sections: [{ chords: ['C', 'C'], comp: 'stab' }], fast: true, level: 1.15 },
  // charge in C, charge a step up (D), then a stomping tag resolving to C
  rally: {
    id: 'rally', pri: 4, bpm: 150, beatsPerBar: 4, fast: true, level: 1.2,
    lead: [[G4, 0.5], [C5, 0.5], [E5, 0.5], [G5, 1.5], [E5, 0.5], [G5, 1.5], [0, 1], [A4, 0.5], [D5, 0.5], [Fs5, 0.5], [A5, 1.5], [Fs5, 0.5], [A5, 1.5], [0, 1], [G5, 0.5], [G5, 0.5], [G5, 0.5], [C6, 2.5], [0, 0.5], [C6, 0.5], [C6, 1.5]],
    sections: [{ chords: ['C', 'C', 'D', 'D', 'G', 'G', 'C', 'C'], comp: 'march' }],
  },
  hr_fanfare: {
    id: 'hr_fanfare', pri: 6, bpm: 128, beatsPerBar: 4, fast: true, level: 1.25,
    lead: [[C5, 0.25], [E5, 0.25], [G5, 0.25], [C6, 0.25], [G5, 0.25], [E5, 0.25], [G5, 0.25], [C6, 0.25], [C6, 1], [A5, 0.5], [C6, 1.5], [G5, 0.5], [B4 + 12, 1.5], [C6, 0.25], [D5 + 12, 0.25], [C6, 0.25], [D5 + 12, 0.25], [C6, 3]],
    sections: [{ chords: ['C', 'F', 'G7', 'C'], comp: 'stab' }],
  },
  ditty: { id: 'ditty', pri: 1, bpm: 124, beatsPerBar: 4, lead: [[C5, 0.5], [C5, 0.5], [G4, 0.5], [A4, 0.5], [G4, 1], [E5, 0.5], [D5, 0.5], [C5, 1], [A4, 0.5], [A4, 0.5], [F4, 0.5], [G4, 0.5], [A4, 1], [G4, 0.5], [E4, 0.5], [D4, 1], [C5, 2]], sections: [{ chords: ['C', 'Am', 'F', 'G7'], comp: 'march' }, { chords: ['C'], comp: 'stab' }], level: 0.95 },
  ditty2: { id: 'ditty2', pri: 1, bpm: 112, beatsPerBar: 4, lead: [[E5, 0.5], [E5, 0.5], [0, 0.5], [E5, 0.5], [D5, 0.5], [C5, 0.5], [D5, 1], [G4, 0.5], [A4, 0.5], [B4, 1], [C5, 0.5], [D5, 0.5], [E5, 1], [D5, 1], [C5, 2]], sections: [{ chords: ['C', 'G', 'F', 'G7'], comp: 'waltz' }, { chords: ['C'], comp: 'stab' }], level: 0.95 },
  ditty3: { id: 'ditty3', pri: 1, bpm: 132, beatsPerBar: 4, lead: [[G4, 0.5], [B4, 0.5], [D5, 0.5], [G5, 1.5], [F5, 0.5], [E5, 0.5], [D5, 1], [E5, 0.5], [C5, 0.5], [A4, 1], [B4, 0.5], [D5, 0.5], [G5, 2]], sections: [{ chords: ['G', 'C', 'Am', 'D7'], comp: 'march' }, { chords: ['G'], comp: 'stab' }], level: 0.95 },
  // "shave and a haircut ... two bits" tag, a stock ballpark riff
  sting: { id: 'sting', pri: 2, bpm: 156, beatsPerBar: 4, lead: [[C5, 0.5], [G4, 0.25], [G4, 0.25], [A4, 0.5], [G4, 0.5], [0, 0.5], [B4, 0.5], [C5, 1.5]], sections: [{ chords: ['C', 'C'], comp: 'stab' }], level: 1.0 },
  walk_up: { id: 'walk_up', pri: 2, bpm: 108, beatsPerBar: 4, lead: [[C5, 0.5], [0, 0.5], [C5, 0.5], [E5, 0.5], [G5, 1], [E5, 0.5], [C5, 0.5], [F5, 0.5], [0, 0.5], [F5, 0.5], [A5, 0.5], [G5, 1], [E5, 0.5], [D5, 0.5]], sections: [{ chords: ['C', 'F'], comp: 'march' }], level: 0.9 },
  dirge: { id: 'dirge', pri: 2, bpm: 80, beatsPerBar: 4, lead: [[G4, 1], [F4, 1], [63, 1], [D4, 1], [C4, 3]], sections: [{ chords: ['Cm', 'Cm'], comp: 'pad' }], level: 0.9 },
  // soft beds: chord pads with arpeggios, looped
  bed: { id: 'bed', pri: 0, bpm: 84, beatsPerBar: 4, lead: [], arp: true, loop: true, sections: [{ chords: ['C', 'Am', 'F', 'G', 'C', 'Am', 'Dm', 'G7'], comp: 'pad' }], level: 1.0 },
  bed2: { id: 'bed2', pri: 0, bpm: 78, beatsPerBar: 4, lead: [], arp: true, loop: true, sections: [{ chords: ['G', 'Em', 'C', 'D', 'G', 'Em', 'Am', 'D7'], comp: 'pad' }], level: 0.55 },
  bed3: { id: 'bed3', pri: 0, bpm: 90, beatsPerBar: 4, lead: [], arp: true, loop: true, sections: [{ chords: ['F', 'C', 'Dm', 'C', 'F', 'C', 'G', 'C'], comp: 'pad' }], level: 1.0 },
};

export const DITTIES: OrganId[] = ['ditty', 'ditty2', 'ditty3'];
export const BEDS: OrganId[] = ['bed', 'bed2', 'bed3'];

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BEDS, DITTIES, PIECES, TAKE_ME_OUT, bassNote, buildPiece, chordPcs, chordVoicing, pieceBeats, type OrganId } from '../music';
import { Organ } from '../organ';
import { DEFAULT_SETTINGS, Mixer } from '../mixer';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pc = (m: number) => NAMES[m % 12];

describe('Take Me Out to the Ball Game transcription', () => {
  it('is 31 bars of 3/4 and matches the chord chart bar for bar', () => {
    const beats = TAKE_ME_OUT.reduce((a, s) => a + s[1], 0);
    expect(beats).toBe(31 * 3);
    const p = PIECES.stretch;
    expect(p.beatsPerBar).toBe(3);
    expect(p.sections.reduce((a, s) => a + s.chords.length, 0)).toBe(1 + 31); // intro bar + the chorus
    expect(pieceBeats(p)).toBe(32 * 3);
  });

  it('opens "Take me out to the ball game" C C\' A G E G D and ends on a held C over C', () => {
    const notes = TAKE_ME_OUT.slice(0, 7).map((s) => s[0]);
    expect(notes.map(pc)).toEqual(['C', 'C', 'A', 'G', 'E', 'G', 'D']);
    expect(notes[1] - notes[0]).toBe(12); // the octave leap on "me"
    expect(TAKE_ME_OUT[TAKE_ME_OUT.length - 1]).toEqual([72, 3]);
  });

  it('has the chorus landmarks: Buy me some peanuts (A G# A E F G), one two three strikes (C B A G F# G)', () => {
    const names = TAKE_ME_OUT.map((s) => pc(s[0]));
    const seq = (a: string[]) => names.join(' ').includes(a.join(' '));
    expect(seq(['A', 'G#', 'A', 'E', 'F', 'G', 'A', 'F', 'D'])).toBe(true);
    expect(seq(['C', 'B', 'A', 'G', 'F#', 'G', 'A', 'B', 'C'])).toBe(true);
    // every melody note lies in a sensible singing range
    for (const [m] of TAKE_ME_OUT) if (m) expect(m >= 60 && m <= 74).toBe(true);
  });

  it('plays as an oom-pah-pah waltz: bass on 1, chords on 2 and 3, on the chart\'s changes', () => {
    const ev = buildPiece(PIECES.stretch);
    const bar = (i: number) => ev.filter((e) => e.at >= i * 3 && e.at < (i + 1) * 3);
    const b2 = bar(1); // first bar of the chorus: C
    expect(b2.filter((e) => e.layer === 'bass').map((e) => [e.at - 3, pc(e.midi)])).toEqual([[0, 'C']]);
    expect(new Set(b2.filter((e) => e.layer === 'chord').map((e) => e.at - 3))).toEqual(new Set([1, 2]));
    // bar 4 of the chorus is G7: the chord tones are G B D F
    const g7 = new Set(bar(4).filter((e) => e.layer === 'chord').map((e) => pc(e.midi)));
    expect(g7).toEqual(new Set(['G', 'B', 'D', 'F']));
    // the melody starts after the intro bar
    expect(ev.filter((e) => e.layer === 'lead')[0].at).toBe(3);
  });
});

describe('chords', () => {
  it('parses triads, sevenths and minors; voicings stay in the left-hand range', () => {
    expect(chordPcs('C').pcs).toEqual([0, 4, 7]);
    expect(chordPcs('Dm').pcs).toEqual([2, 5, 9]);
    expect(chordPcs('A7').pcs).toEqual([9, 1, 4, 7]);
    expect(() => chordPcs('H')).toThrow();
    for (const s of ['C', 'G7', 'F', 'Dm', 'Am', 'D7', 'C7', 'Cm', 'A7']) {
      for (const n of chordVoicing(s)) expect(n >= 55 && n <= 66).toBe(true);
      expect(bassNote(s) >= 36 && bassNote(s) <= 47).toBe(true);
    }
  });
});

describe('pieces', () => {
  it('every piece compiles to ordered, in-range note events within its length', () => {
    for (const id of Object.keys(PIECES) as OrganId[]) {
      const p = PIECES[id];
      const ev = buildPiece(p);
      expect(ev.length, id).toBeGreaterThan(3);
      const total = pieceBeats(p);
      for (let i = 0; i < ev.length; i++) {
        expect(ev[i].midi >= 24 && ev[i].midi <= 96, `${id} note ${ev[i].midi}`).toBe(true);
        expect(ev[i].at).toBeGreaterThanOrEqual(0);
        expect(ev[i].at, id).toBeLessThan(total + 0.001);
        if (i) expect(ev[i].at).toBeGreaterThanOrEqual(ev[i - 1].at);
      }
    }
  });

  it('beds loop and are the lowest priority; fanfares outrank the stretch', () => {
    for (const b of BEDS) {
      expect(PIECES[b].loop).toBe(true);
      expect(PIECES[b].pri).toBe(0);
    }
    expect(PIECES.hr_fanfare.pri).toBeGreaterThan(PIECES.stretch.pri);
    expect(PIECES.rally.pri).toBeGreaterThan(PIECES.charge.pri);
    expect(DITTIES).toHaveLength(3);
  });

  it('the charge figure rises G C E to a held G', () => {
    const lead = PIECES.charge.lead.map((s) => pc(s[0]));
    expect(lead.slice(0, 4)).toEqual(['G', 'C', 'E', 'G']);
  });
});

/** AudioContext double with the nodes the organ uses. */
function fakeCtx() {
  const oscs: any[] = [];
  const node = (extra: object = {}) => {
    const n: any = { connect: vi.fn((to: any) => to), disconnect: vi.fn(), ...extra };
    return n;
  };
  const param = () => ({ value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() });
  const ctx: any = {
    state: 'running', sampleRate: 44100, currentTime: 1, destination: node(),
    resume: async () => {}, close: async () => {},
    createGain: () => node({ gain: param() }),
    createDynamicsCompressor: () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createAnalyser: () => node({ fftSize: 2048 }),
    createBiquadFilter: () => node({ frequency: param(), Q: param(), type: '' }),
    createConvolver: () => node({ buffer: null }),
    createStereoPanner: () => node({ pan: param() }),
    createDelay: () => node({ delayTime: param() }),
    createWaveShaper: () => node({ curve: null }),
    createPeriodicWave: () => ({}),
    createBuffer: (c: number, len: number, sr: number) => ({ getChannelData: () => new Float32Array(len), length: len, sampleRate: sr, copyToChannel() {} }),
    createBufferSource: () => node({ buffer: null, start: vi.fn(), stop: vi.fn(), playbackRate: param() }),
    createOscillator: () => {
      const o: any = node({ frequency: param(), detune: param(), type: 'sine', setPeriodicWave: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null });
      oscs.push(o);
      return o;
    },
  };
  return { ctx, oscs };
}

describe('organ player', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const f = fakeCtx();
    const m = new Mixer({ ...DEFAULT_SETTINGS }, () => f.ctx);
    await m.unlock();
    const o = new Organ(m);
    return { f, m, o };
  }

  it('is a silent no-op without a running context', () => {
    const o = new Organ(new Mixer({ ...DEFAULT_SETTINGS }, () => { throw new Error('none'); }));
    expect(o.play('charge')).toBe(false);
    expect(o.playing).toBeNull();
  });

  it('plays notes ahead of time and a fanfare cuts the soft bed, but a bed never cuts a fanfare', async () => {
    const { f, o } = await setup();
    expect(o.play('bed')).toBe(true);
    expect(o.playing).toMatch(/^bed/);
    const before = f.oscs.length;
    expect(before).toBeGreaterThan(5);
    expect(o.play('rally')).toBe(true); // higher priority cuts the bed
    expect(o.playing).toBe('rally');
    expect(o.play('bed')).toBe(false); // lower priority is refused
    expect(o.play('charge')).toBe(false); // charge < rally
    expect(o.play('hr_fanfare')).toBe(true); // the home run fanfare outranks the rally
    expect(o.refused).toBe(2);
  });

  it('stop() silences everything: notes are stopped and the piece forgets itself', async () => {
    const { f, o } = await setup();
    o.play('ditty');
    o.stop(0.1);
    expect(o.playing).toBeNull();
    vi.advanceTimersByTime(500);
    for (const osc of f.oscs.slice(2)) expect(osc.stop).toHaveBeenCalled(); // (the first two are the always-on rotary LFOs)
  });

  it('rotates through the three ditties and the three beds', async () => {
    const { o } = await setup();
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      o.play('ditty');
      seen.push(o.playing!);
      o.stop(0.01);
    }
    expect(new Set(seen).size).toBe(3);
  });

  it('a non-looping riff ends by itself', async () => {
    const { f, o } = await setup();
    o.play('sting');
    expect(o.playing).toBe('sting');
    f.ctx.currentTime += 30;
    vi.advanceTimersByTime(400);
    expect(o.playing).toBeNull();
  });
});

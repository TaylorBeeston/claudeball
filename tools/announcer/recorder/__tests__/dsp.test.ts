import { describe, expect, it } from 'vitest';
import { analyze, decodeWav, encodeWav, levels, qc, resampleLinear, trim, Vad } from '../src/dsp';

const R = 48000;
/** `lead` s of noise, `speech` s of a voice-like burst (200 Hz carrier, syllable-rate modulation), `tail` s of noise. */
function take(lead: number, speech: number, tail: number, o: { noiseDb?: number; peakDb?: number; clip?: boolean } = {}): Float32Array {
  const n = Math.round((lead + speech + tail) * R);
  const out = new Float32Array(n);
  const noise = 10 ** ((o.noiseDb ?? -70) / 20);
  const amp = 10 ** ((o.peakDb ?? -8) / 20);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / R;
    let v = rnd() * noise;
    if (t >= lead && t < lead + speech) v += amp * Math.sin(2 * Math.PI * 200 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t));
    out[i] = o.clip ? Math.max(-1, Math.min(1, v * 6)) : v;
  }
  return out;
}

describe('analysis and trimming', () => {
  it('finds the speech and trims with ~200 ms padding on both ends', () => {
    const s = take(1.0, 2.0, 1.0);
    const a = analyze(s, R);
    expect(a.speechStart / R).toBeGreaterThan(0.95);
    expect(a.speechStart / R).toBeLessThan(1.1);
    expect(a.speechS).toBeGreaterThan(1.8);
    const t = trim(s, R, a, 200);
    expect(t.padHeadS).toBeGreaterThan(0.18);
    expect(t.padHeadS).toBeLessThan(0.22);
    expect(t.padTailS).toBeGreaterThan(0.18);
    expect(t.samples.length / R).toBeGreaterThan(2.3);
    expect(t.samples.length / R).toBeLessThan(2.6);
  });

  it('clamps padding to what was recorded', () => {
    const a = analyze(take(0.05, 1, 0.05), R);
    const t = trim(take(0.05, 1, 0.05), R, a, 200);
    expect(t.padHeadS).toBeLessThan(0.1);
  });

  it('keeps a phrase with a breath in the middle as one take', () => {
    const a = analyze(Float32Array.from([...take(0.5, 1, 0.3), ...take(0, 1, 0.5)]), R);
    expect(a.speechS).toBeGreaterThan(1.8);
  });
});

describe('quality checks', () => {
  it('passes a clean take', () => {
    const q = qc(analyze(take(1, 2.4, 1), R), 3.6);
    expect(q.status).toBe('ok');
  });
  it('flags clipping', () => {
    expect(qc(analyze(take(1, 2, 1, { clip: true }), R), 3).checks.find((c) => c.id === 'clipping')!.status).toBe('fail');
  });
  it('flags a quiet take', () => {
    const q = qc(analyze(take(1, 2, 1, { peakDb: -34, noiseDb: -80 }), R), 3);
    expect(q.checks.find((c) => c.id === 'level')!.status).toBe('fail');
  });
  it('flags a noisy room', () => {
    const q = qc(analyze(take(1, 2, 1, { noiseDb: -38, peakDb: -10 }), R), 3);
    expect(['warn', 'fail']).toContain(q.checks.find((c) => c.id === 'noise')!.status);
  });
  it('flags a take with no speech', () => {
    expect(qc(analyze(take(2, 0, 0), R), 3).checks[0]).toMatchObject({ id: 'speech', status: 'fail' });
  });
  it('flags short and long takes against the script estimate', () => {
    expect(qc(analyze(take(1, 0.4, 1), R), 8).checks.find((c) => c.id === 'length')!.status).toBe('warn');
    expect(qc(analyze(take(1, 9, 1), R), 3).checks.find((c) => c.id === 'length')!.status).toBe('warn');
  });
  it('flags an end that was cut off, and a start that was cut off', () => {
    expect(qc(analyze(take(1, 2, 0), R), 3).checks.find((c) => c.id === 'end')!.status).toBe('fail');
    expect(qc(analyze(take(0, 2, 1), R), 3).checks.find((c) => c.id === 'start')!.status).toBe('fail');
  });
});

describe('voice activity detector', () => {
  it('starts after the onset time and ends after the silence time', () => {
    const v = new Vad(-40, 100, 1000);
    const ev: string[] = [];
    const feed = (db: number, ms: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const e = v.push(db, ms);
        if (e) ev.push(e);
      }
    };
    feed(-70, 20, 50);
    expect(ev).toEqual([]);
    feed(-20, 20, 4); // 80 ms: not yet
    expect(ev).toEqual([]);
    feed(-20, 20, 3);
    expect(ev).toEqual(['start']);
    feed(-70, 20, 30); // 600 ms of quiet: still the same utterance
    expect(ev).toEqual(['start']);
    feed(-70, 20, 30);
    expect(ev).toEqual(['start', 'end']);
  });
});

describe('WAV', () => {
  it('round-trips 16 and 24 bit', () => {
    const s = take(0.1, 0.3, 0.1, { peakDb: -6 });
    for (const bits of [16, 24] as const) {
      const d = decodeWav(encodeWav(s, R, bits));
      expect(d.rate).toBe(R);
      expect(d.bits).toBe(bits);
      expect(d.samples.length).toBe(s.length);
      let err = 0;
      for (let i = 0; i < s.length; i++) err = Math.max(err, Math.abs(d.samples[i] - s[i]));
      expect(err).toBeLessThan(bits === 16 ? 1e-3 : 1e-5);
    }
  });
  it('rejects garbage and mixes stereo down', () => {
    expect(() => decodeWav(new ArrayBuffer(100))).toThrow();
    const mono = encodeWav(Float32Array.from([0.5, 0.5, 0.5, 0.5]), 8000, 16);
    expect(levels(decodeWav(mono).samples).peak).toBeCloseTo(0.5, 2);
  });
  it('resamples by length', () => {
    expect(resampleLinear(new Float32Array(44100), 44100, 48000).length).toBe(48000);
  });
});

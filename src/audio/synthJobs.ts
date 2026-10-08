/**
 * The sounds the game synthesises at start-up (every effect, the crowd one-shots, the three bed loops, the stadium's impulse response), as
 * plain jobs: `runJob` is pure (no Web Audio, no DOM), so the same code runs in `synthWorker.ts` (the normal path: about a second of maths
 * that used to run on the main thread in 6 ms slices, with single jobs of 100+ ms, i.e. frozen frames right as the game started) and on
 * the main thread when there is no worker (the offline render tool, tests, very old browsers).
 */
import { renderSfx, renderCrowd, crowdLoop } from './synth';
import { stadiumIR, type VenuePreset } from './venue/ir';
import type { Rendered } from './dsp';
import type { CrowdId, SfxId } from './types';

export type SynthJob =
  | { k: 'sfx'; id: SfxId; b: number; a: number }
  | { k: 'crowd'; id: CrowdId }
  | { k: 'loop'; kind: 'murmur' | 'roar' | 'claps' }
  | { k: 'ir'; venue: VenuePreset; lowPower: boolean };

/** the job's result at the context's sample rate `sr`: park sounds mono (they go into mono mic strips), broadcast stings and the IR as made */
export function runJob(j: SynthJob, sr: number): Rendered {
  switch (j.k) {
    case 'sfx': {
      const r = renderSfx(j.id, j.b, j.a);
      return j.id.startsWith('bfx_') ? r : monoAt(r, sr);
    }
    case 'crowd':
      return monoAt(renderCrowd(j.id), sr);
    case 'loop':
      return monoAt(crowdLoop(j.kind), sr);
    case 'ir':
      return irFor(j.venue, sr, j.lowPower);
  }
}

/** the stadium IR as the convolver takes it: stereo, or on phones one channel of at most 1.6 s with a 0.3 s fade (~1/3 of the work) */
export function irFor(venue: VenuePreset, sr: number, lowPower: boolean): Rendered {
  const ir = stadiumIR(sr, venue);
  if (!lowPower) return { sr, ch: [ir.ch[0], ir.ch[1]] };
  const n = Math.min(ir.ch[0].length, Math.floor(1.6 * sr));
  const x = ir.ch[0].slice(0, n);
  const fade = Math.floor(0.3 * sr);
  for (let i = n - fade; i < n; i++) x[i] *= (n - i) / fade;
  for (let i = 0; i < n; i++) x[i] = (x[i] + ir.ch[1][i]) * Math.SQRT1_2;
  return { sr, ch: [x] };
}

/** a rendered sound folded to mono and resampled (cubic Hermite) to `sr`; a loop stays seamless (the interpolation wraps) */
export function monoAt(r: Rendered, sr: number): Rendered {
  const n = r.ch[0].length;
  const m = new Float32Array(n);
  for (const c of r.ch) for (let i = 0; i < n; i++) m[i] += c[i] / r.ch.length;
  if (r.sr === sr) return { sr, ch: [m] };
  const ratio = r.sr / sr;
  const out = new Float32Array(Math.floor(n / ratio));
  const at = (i: number) => m[((i % n) + n) % n];
  for (let j = 0; j < out.length; j++) {
    const x = j * ratio;
    const i = Math.floor(x);
    const f = x - i;
    const y0 = at(i - 1), y1 = at(i), y2 = at(i + 1), y3 = at(i + 2);
    const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    out[j] = ((c3 * f + c2) * f + c1) * f + y1;
  }
  return { sr, ch: [out] };
}


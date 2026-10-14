/** The ticker names every pitch the sim can throw ("Ray Castillo delivers a sw, 81 mph." for a sweeper: promo jank log P8). */
import { describe, expect, it } from 'vitest';
import type { PitchType } from '../../sim/types';
import { PITCH_NAMES } from '../hud';

// a Record over the union: adding a pitch type to the sim without listing it here fails to compile
const ALL: Record<PitchType, true> = { FF: true, FT: true, SI: true, FC: true, SL: true, CU: true, CH: true, SW: true, FS: true };

describe('pitch names', () => {
  it('has a ticker name for every sim pitch type', () => {
    for (const t of Object.keys(ALL)) expect(PITCH_NAMES[t], t).toMatch(/^[A-Z][A-Z -]+$/);
  });
});

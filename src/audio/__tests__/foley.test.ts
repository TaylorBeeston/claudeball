import { describe, expect, it } from 'vitest';
import { surfaceAt, fenceAt, foulLanding, surfaceBounce, surfaceStep } from '../field';
import { SFX_DEFS, renderSfx } from '../synth';
import { CueMapper, mittBucket } from '../cues';
import type { Cue, MapCtx, SfxId } from '../types';

const ctx = (o: Partial<MapCtx> = {}): MapCtx => ({
  pos: (id) => (id === 'b1' ? { x: 0.8, y: 0, z: 0.3 } : id === 'ss' ? { x: 9, y: 0, z: 32 } : undefined),
  person: () => ({ name: 'Joe Smith', number: 7 }),
  inning: 3, half: 'top', outs: 0, balls: 0, strikes: 0, score: { home: 0, away: 0 }, runners: [false, false, false], teams: { home: 'H', away: 'A' }, speed: 1,
  ...o,
});
const sfx = (cs: Cue[], id: SfxId) => cs.filter((c): c is Extract<Cue, { kind: 'sfx' }> => c.kind === 'sfx' && c.id === id);

describe('the field under the ball', () => {
  it('knows grass, infield dirt, the mound, the plate and the warning track', () => {
    expect(surfaceAt(0, 0.2)).toBe('plate');
    expect(surfaceAt(0, 18.4)).toBe('mound');
    expect(surfaceAt(0, 10)).toBe('grass'); // infield grass between the plate and the mound
    expect(surfaceAt(-19.4, 19.4)).toBe('dirt'); // first base
    expect(surfaceAt(6, 33)).toBe('dirt'); // the skin behind the bags
    expect(surfaceAt(0, 70)).toBe('grass');
    expect(surfaceAt(0, 119)).toBe('track');
    expect(surfaceAt(-9.7, 9.7)).toBe('dirt'); // the base path to first
    expect(surfaceBounce('track')).toEqual({ id: 'dirt_thud', bucket: 1 });
    expect(surfaceStep('grass')).toBe(0);
  });

  it('reads the fence by direction (the sim table) and lands foul flies in the seats or the net', () => {
    expect(fenceAt(0).distance).toBeCloseTo(121.9, 1);
    expect(fenceAt(-45).distance).toBeCloseTo(100.6, 1);
    expect(fenceAt(180).height).toBeGreaterThan(10); // the backstop net
    const seats = foulLanding(95, 35, 70);
    expect(seats.where).toBe('seats');
    expect(Math.hypot(seats.pos.x, seats.pos.z)).toBeGreaterThan(fenceAt(70).distance);
    expect(seats.pos.x).toBeGreaterThan(0); // spray + is the third-base side
    expect(foulLanding(80, 60, 170).where).toBe('net');
    expect(foulLanding(70, 5, 60).where).toBe('field');
  });
});

describe('foley recipes', () => {
  it('every variant is finite, bounded, not silent, short, and the same for the same seed', () => {
    for (const id of Object.keys(SFX_DEFS) as SfxId[]) {
      const d = SFX_DEFS[id];
      for (let b = 0; b < d.buckets; b++) {
        const r = renderSfx(id, b, 0);
        let pk = 0;
        for (const c of r.ch) for (const v of c) {
          expect(Number.isFinite(v)).toBe(true);
          pk = Math.max(pk, Math.abs(v));
        }
        expect(pk, `${id}/${b}`).toBeGreaterThan(0.01);
        expect(pk, `${id}/${b}`).toBeLessThanOrEqual(0.98);
        expect(r.ch[0].length / r.sr, id).toBeLessThan(2.5);
      }
    }
    expect(Array.from(renderSfx('mitt_pop', 3, 1).ch[0])).toEqual(Array.from(renderSfx('mitt_pop', 3, 1).ch[0]));
    expect(Array.from(renderSfx('mitt_pop', 3, 1).ch[0].slice(0, 400))).not.toEqual(Array.from(renderSfx('mitt_pop', 3, 2).ch[0].slice(0, 400)));
  });
});

describe('foley mapping', () => {
  it('mitt by pitch speed; a pitch in the dirt is blocked; a corner pitch is framed', () => {
    expect([70, 84, 91, 99].map(mittBucket)).toEqual([0, 1, 2, 3]);
    const m = new CueMapper({ detailed: true });
    m.map({ type: 'pitchReleased', mph: 92, release: { x: 0, y: 1.8, z: 16.5 } }, ctx());
    m.map({ type: 'pitchCrossed', mph: 92, x: 0, y: 0.1, inZone: false }, ctx());
    const dirt = m.map({ type: 'catch', fielderId: 'c', kind: 'pitch', height: 'low', firm: true, pos: { x: 0, y: 0.2, z: -1 } }, ctx());
    expect(sfx(dirt, 'mitt_block')).toHaveLength(1);
    expect(sfx(dirt, 'mitt_pop')).toHaveLength(0);
    m.map({ type: 'pitchCrossed', mph: 92, x: 0.24, y: 0.8, inZone: true }, ctx());
    const corner = m.map({ type: 'catch', fielderId: 'c', kind: 'pitch', height: 'chest', firm: true, pos: { x: 0.2, y: 0.8, z: -1 } }, ctx());
    expect(sfx(corner, 'mitt_creak')).toHaveLength(1);
  });

  it('a foul fly into the stands clacks in the seats later; a bare-hand tag smacks; a ball in play drops the bat', () => {
    const m = new CueMapper({ detailed: true });
    const hit = m.map({ type: 'contact', batterId: 'b1', exitMph: 98, launchDeg: 34, sprayDeg: 72, time: 10, pos: { x: 0, y: 1, z: 0 } }, ctx());
    expect(sfx(hit, 'bat_drop')).toHaveLength(0); // foul side: he keeps the bat
    const foul = m.map({ type: 'call', time: 10.4, call: { kind: 'foul' } }, ctx());
    const seat = sfx(foul, 'seat_thump');
    expect(seat).toHaveLength(1);
    expect(seat[0].delay!).toBeGreaterThan(1);
    expect(sfx(foul, 'seat_scramble')).toHaveLength(1);
    expect(sfx(foul, 'pouch')).toHaveLength(1);
    const fair = m.map({ type: 'contact', batterId: 'b1', exitMph: 92, launchDeg: 12, sprayDeg: 10, time: 20, pos: { x: 0, y: 1, z: 0 } }, ctx());
    expect(sfx(fair, 'bat_drop')).toHaveLength(1);
    m.map({ type: 'tagAttempt', fielderId: 'ss', runnerId: 'r', base: 2, hand: 'hand', pos: { x: 0, y: 0.5, z: 38 } }, ctx());
    const tag = m.map({ type: 'tag', fielderId: 'ss', runnerId: 'r', pos: { x: 0, y: 0.5, z: 38 } }, ctx());
    expect(sfx(tag, 'bare_smack')).toHaveLength(1);
    expect(sfx(tag, 'tag_slap')).toHaveLength(0);
    // a safe call is not a slide (the slide comes from the runner's animation)
    expect(sfx(m.map({ type: 'safe', playerId: 'r', base: 1 }, ctx()), 'slide_scuff')).toHaveLength(0);
  });
});

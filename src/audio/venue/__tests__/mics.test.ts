import { describe, expect, it } from 'vitest';
import { BASES, FAR_M, MICS, PAN_SIGN, SPEAKERS, ZONES, imageOf, micPan, micsFor, panOf, pickupOne, pickups, polar, zoneForPan, SPEED_OF_SOUND, type MicDef } from '../mics';

const mic = (id: string) => MICS.find((m) => m.id === id)!;
const plate = { x: 0, y: 1, z: 0 };

describe('mic array maths', () => {
  it('delays are flight times at 343 m/s; relative delays put the nearest mic first', () => {
    const p = pickupOne(mic('wall_cf'), plate);
    expect(p.delay).toBeCloseTo(p.dist / SPEED_OF_SOUND, 9);
    // the bat crack reaches the centre-field wall mic ~0.3 s after the dish behind home
    const all = pickups(plate, MICS, MICS.length, -200);
    const dish = all.find((x) => x.mic === 'plate')!;
    const cf = all.find((x) => x.mic === 'wall_cf')!;
    expect(Math.min(...all.map((x) => x.delay))).toBe(0);
    expect(cf.delay - dish.delay).toBeGreaterThan(0.25);
    expect(cf.delay - dish.delay).toBeLessThan(0.35);
    expect(cf.delay - dish.delay).toBeCloseTo((cf.dist - dish.dist) / SPEED_OF_SOUND, 9);
  });

  it('inverse distance with a floor: flat inside the reference distance, -6 dB per doubling beyond it', () => {
    const m: MicDef = { ...mic('crowd_home'), pattern: 'omni', faderDb: 0, ref: 5, pos: { x: 0, y: 0, z: 0 } };
    const at = (d: number) => pickupOne(m, { x: d, y: 0, z: 0 }).gain;
    expect(at(1)).toBeCloseTo(at(4), 9);
    expect(at(20) / at(10)).toBeCloseTo(0.5, 6);
    expect(at(5)).toBeCloseTo(1, 6);
  });

  it('polar patterns: cardioid null at the back, shotgun and dish narrow, boundary half-space', () => {
    expect(polar('omni', -1)).toBe(1);
    expect(polar('cardioid', 1)).toBe(1);
    expect(polar('cardioid', -1)).toBeLessThan(0.05);
    expect(polar('cardioid', 0)).toBeCloseTo(0.5, 6);
    expect(polar('shotgun', Math.cos(Math.PI / 4))).toBeLessThan(polar('cardioid', Math.cos(Math.PI / 4)));
    expect(polar('parabolic', Math.cos(Math.PI / 4))).toBeLessThan(polar('shotgun', Math.cos(Math.PI / 4)));
    expect(polar('boundary', 0.2)).toBe(1);
    expect(polar('boundary', -1)).toBeLessThan(0.3);
    // the dish behind home hears the plate far better than the crowd behind it
    expect(pickupOne(mic('plate'), plate).gain).toBeGreaterThan(20 * pickupOne(mic('plate'), { x: 0, y: 6, z: -30 }).gain);
  });

  it('far or off-axis pickups take the darker input; a close directional mic gets the proximity bass', () => {
    expect(pickupOne(mic('wall_cf'), plate).far).toBe(true);
    expect(pickupOne(mic('wall_cf'), plate).dist).toBeGreaterThan(FAR_M);
    expect(pickupOne(mic('first'), BASES.first).far).toBe(false);
    expect(pickupOne(mic('first'), BASES.third).far).toBe(true); // far behind its axis
    const d = mic('dugout');
    expect(pickupOne(d, { x: d.pos.x - 0.3, y: d.pos.y - 0.2, z: d.pos.z + 0.3 }).proximityDb).toBeGreaterThan(1);
    expect(pickupOne(d, { x: 18, y: 0.6, z: 3 }).proximityDb).toBe(0);
  });

  it('the stereo image matches the centre-field camera: third base right, first base left, the plate centred, mirrored mics mirrored', () => {
    expect(PAN_SIGN).toBe(1);
    expect(micPan(mic('third'))).toBeGreaterThan(0.3);
    expect(micPan(mic('first'))).toBeLessThan(-0.3);
    expect(micPan(mic('plate'))).toBe(0);
    expect(micPan(mic('wall_cf'))).toBeCloseTo(0, 6);
    for (const [a, b] of [['first', 'third'], ['wall_lf', 'wall_rf'], ['crowd_3b', 'crowd_1b'], ['crowd_lf', 'crowd_rf'], ['house_r', 'house_l']]) expect(micPan(mic(a))).toBeCloseTo(-micPan(mic(b)), 6);
    expect(imageOf(pickups(BASES.third))).toBeGreaterThan(0.2);
    expect(imageOf(pickups(BASES.first))).toBeLessThan(-0.2);
    expect(Math.abs(imageOf(pickups(plate)))).toBeLessThan(0.05);
    expect(panOf({ x: 1000, y: 0, z: 0 })).toBeLessThanOrEqual(0.95);
  });

  it('keeps the k strongest, never splits a mirrored pair, and drops mics far under the strongest', () => {
    expect(pickups(BASES.third, MICS, 3).length).toBe(3);
    // a source on the centre line behind home: the house pair either both or neither
    for (const k of [1, 2, 3, 4]) {
      const ids = pickups({ x: 0, y: 6, z: -30 }, MICS, k).map((p) => p.mic);
      expect(ids.includes('house_l')).toBe(ids.includes('house_r'));
      expect(ids.includes('crowd_lf')).toBe(ids.includes('crowd_rf'));
    }
    const top = pickups(plate, MICS, 16, -12);
    expect(top.every((p) => p.gain >= top[0].gain * Math.pow(10, -12 / 20) - 1e-12)).toBe(true);
  });

  it('the plot is sane: 16 mics, 9 on phones, every mic aimed somewhere, speakers and zones in the stands', () => {
    expect(MICS.length).toBe(16);
    expect(micsFor(true).length).toBe(9);
    expect(new Set(MICS.map((m) => m.id)).size).toBe(MICS.length);
    for (const m of MICS) expect(Math.hypot(m.aim.x - m.pos.x, m.aim.y - m.pos.y, m.aim.z - m.pos.z)).toBeGreaterThan(0.5);
    for (const s of SPEAKERS) expect(s.pos.y).toBeGreaterThan(10);
    for (const z of ZONES) expect(Math.hypot(z.pos.x, z.pos.z)).toBeGreaterThan(29);
    expect(zoneForPan(0.9)).toBe('line_3b');
    expect(zoneForPan(-0.5)).toBe('line_1b');
    expect(zoneForPan(0)).toBe('backstop');
    expect(zoneForPan(0.5, true)).toBe('lf_bleachers');
  });
});

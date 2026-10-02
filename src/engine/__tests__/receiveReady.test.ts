import { describe, expect, it } from 'vitest';
import { readyGlove, receiveReady, type ReadyInput } from '../receiveReady';

const base: ReadyInput = { hint: false, role: 'pitcher', anim: 'idle', hasBall: false, carrier: { role: 'catcher', anim: 'transfer', distance: 18.4 }, liveBall: false };

describe('receiveReady', () => {
  it('a pitcher holds the glove up while his catcher handles the ball', () => {
    expect(receiveReady(base)).toBe(true);
    expect(receiveReady({ ...base, carrier: { role: 'catcher', anim: 'toss', distance: 18.4 } })).toBe(true);
  });
  it('not for a live play, a pitcher with the ball, a windup, or a different carrier', () => {
    expect(receiveReady({ ...base, liveBall: true })).toBe(false);
    expect(receiveReady({ ...base, hasBall: true })).toBe(false);
    expect(receiveReady({ ...base, anim: 'windup' })).toBe(false);
    expect(receiveReady({ ...base, carrier: { role: 'first', anim: 'transfer', distance: 18 } })).toBe(false);
    expect(receiveReady({ ...base, carrier: { role: 'catcher', anim: 'idle', distance: 18 } })).toBe(false);
    expect(receiveReady({ ...base, carrier: null })).toBe(false);
  });
  it('keeps the glove up while the return throw is in the air (a fast ball is not a live play for the pitcher)', () => {
    expect(receiveReady({ ...base, carrier: null, incoming: true, liveBall: true })).toBe(true);
    expect(receiveReady({ ...base, role: 'second', carrier: null, incoming: true })).toBe(false);
  });
  it('the sim hint always wins unless the ball is live', () => {
    expect(receiveReady({ ...base, hint: true, role: 'second', carrier: null })).toBe(true);
    expect(receiveReady({ ...base, hint: true, liveBall: true })).toBe(false);
  });
  it('puts the glove in front of the chest toward the thrower, on the glove side', () => {
    const g = readyGlove({ x: 0, z: 18.4 }, { x: 0, z: 0 }, 'R');
    expect(g.z).toBeLessThan(18.4); // toward the plate
    expect(g.y).toBeGreaterThan(1);
    const gl = readyGlove({ x: 0, z: 18.4 }, { x: 0, z: 0 }, 'L');
    expect(Math.sign(g.x)).toBe(-Math.sign(gl.x));
  });
});

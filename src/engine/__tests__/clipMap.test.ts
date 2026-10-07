import { describe, expect, it } from 'vitest';
import { clipCandidates, stanceYaw } from '../gltfCharacter';
import { CALL_CAPTIONS } from '../hud';
import { readFileSync } from 'node:fs';
import type { AnimHint, PlayerRole } from '../types';

describe('hint → clip mapping with fallbacks', () => {
  it('prefers the dedicated clip and falls back to an older one', () => {
    expect(clipCandidates('trot', 'runner')).toEqual(['trot', 'run']);
    expect(clipCandidates('walk', 'runner')).toEqual(['walk', 'trot', 'run']);
    expect(clipCandidates('catch_jump', 'left')).toEqual(['catch_jump', 'field_catch']);
    expect(clipCandidates('toss', 'short')).toEqual(['throw_casual', 'toss', 'throw']);
    expect(clipCandidates('catch_fly', 'center')).toEqual(['catch_fly', 'field_catch']);
    expect(clipCandidates('field_grounder', 'short')).toEqual(['field_grounder', 'field_catch']);
    expect(clipCandidates('tag_glove', 'first')).toEqual(['tag_glove', 'field_catch']);
    expect(clipCandidates('slide_head', 'runner')).toEqual(['slide_head', 'slide']);
    expect(clipCandidates('dive_back', 'runner')).toEqual(['dive_back', 'slide']);
    expect(clipCandidates('catcher_block', 'catcher')).toEqual(['catcher_block', 'catcher_crouch']);
    expect(clipCandidates('ump_safe', 'umpire')).toEqual(['ump_safe', 'idle']);
  });
  it('every umpire gesture falls back to idle', () => {
    const gestures: AnimHint[] = ['ump_strike', 'ump_strike_swinging', 'ump_ball', 'ump_safe', 'ump_out', 'ump_foul', 'ump_fair', 'ump_homerun', 'ump_time', 'ump_ready'];
    for (const g of gestures) {
      const c = clipCandidates(g, 'umpire');
      expect(c[0]).toBe(g);
      expect(c[c.length - 1]).toBe('idle');
    }
  });
  it('a transfer keeps the role standing pose when it has no clip of its own', () => {
    expect(clipCandidates('transfer', 'short')).toEqual(['transfer', 'field_ready_infield', 'field_ready', 'idle']);
    expect(clipCandidates('transfer', 'center')[1]).toBe('field_ready_outfield');
    expect(clipCandidates('idle', 'catcher')).toEqual(['catcher_crouch']);
    expect(clipCandidates('idle', 'batter')).toEqual(['batting_stance', 'swing']);
  });
  it('batters stand sideways, chest toward the plate, whichever hand', () => {
    expect(Math.sin(stanceYaw('R'))).toBeLessThan(-0.9); // righties (+X) face -X
    expect(Math.sin(stanceYaw('L'))).toBeGreaterThan(0.9); // lefties (-X) face +X
  });
});

describe('umpire captions', () => {
  it('names the calls the way a broadcast would', () => {
    expect(CALL_CAPTIONS.ball).toBe('BALL');
    expect(CALL_CAPTIONS.strike_called).toBe('STRIKE');
    expect(CALL_CAPTIONS.strike_swinging).toBe('STRIKE');
    expect(CALL_CAPTIONS.safe).toBe('SAFE');
    expect(CALL_CAPTIONS.out).toBe('OUT');
    expect(CALL_CAPTIONS.homerun).toBe('HOME RUN');
    expect(CALL_CAPTIONS.strikeout).toBe('STRIKEOUT');
  });
});

describe('every hint resolves to a clip the player files have, in a fitting posture', () => {
  const src = readFileSync(new URL('../types.ts', import.meta.url), 'utf8');
  const union = /export type AnimHint =([^;]+);/.exec(src)![1];
  const hints = [...union.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1] as AnimHint);
  const manifest = JSON.parse(readFileSync(new URL('../../../assets/players/player_manifest.json', import.meta.url), 'utf8')) as { clips: Record<string, unknown> };
  const has = (c: string) => c in manifest.clips;
  const resolve = (h: AnimHint, role: PlayerRole) => clipCandidates(h, role).find(has);
  const roles: PlayerRole[] = ['pitcher', 'catcher', 'first', 'short', 'center', 'batter', 'runner', 'umpire', 'ballkid', 'batboy', 'coach1b', 'bench', 'manager'];
  const SEATED = new Set(['bench_sit', 'ballkid_sit']);

  it('the union was read', () => expect(hints.length).toBeGreaterThan(80));

  it('every hint has an existing clip for every role', () => {
    for (const h of hints) for (const r of roles) expect(resolve(h, r), `${h} / ${r}`).toBeDefined();
  });

  it('a standing hint never falls back to a seated clip (the bat boy sat on thin air with `ballkid_idle` → `ballkid_sit`)', () => {
    for (const h of hints) {
      if (SEATED.has(h) || h === 'bench_stand_up' || h === 'bench_cheer') continue;
      for (const r of roles) expect(SEATED.has(resolve(h, r)!), `${h} / ${r} → ${resolve(h, r)}`).toBe(false);
    }
  });

  it('hints without a clip of their own are only these known stand-ins (a new one must be added here on purpose)', () => {
    const own = hints.filter((h) => !has(h) && resolve(h, 'short') !== h).sort();
    expect(own).toEqual(['ballkid_idle', 'ballkid_run', 'catch', 'catch_ready', 'field', 'toss', 'transfer', 'umpire_brush_plate']);
    expect(resolve('umpire_brush_plate', 'umpire')).toBe('ump_brush_plate');
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Audit guard: the only places the sim draws a *uniform* random number (`next / range / int / pick`; Gaussian noise is `normal`)
 * are listed here, each with why it is not a pre-rolled outcome. A new dice roll anywhere else fails this test and has to be
 * justified (or, better, turned into physics or state).
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'roster.ts': { count: 31, why: 'roster / team generation (before the game starts)' },
  'rng.ts': { count: 7, why: 'the generator itself (normal() and helpers)' },
  'pitchai.ts': { count: 14, why: 'AI mixed strategy for pitch selection / location (aiRng): a decision, not an outcome' },
  'manager.ts': { count: 4, why: 'AI mixed strategy for intentional walk / bunt (aiRng)' },
  'running.ts': { count: 1, why: 'AI pickoff mixed strategy (aiRng)' },
  'handling.ts': { count: 2, why: 'AI casual behaviour: whether the infield tosses the ball around after an out with nobody on (aiRng)' },
  'dugout.ts': { count: 3, why: 'show only: when the on-deck hitter takes his next warm-up swing (propRng, a stream nothing in the physics or decisions reads); which bench players cheer for a hit (propRng, show only)' },
  'staff.ts': { count: 3, why: 'AI: whether a runner takes his base coach\'s call (aiRng, once per runner and play); show only: whether the ball kid tosses a ball to a fan, whether the coach gives signs (propRng)' },
  'tempo.ts': { count: 16, why: 'AI: whether the batter steps out / calls time, whether the pitcher steps off, shakes off the sign, signals the infield, looks at the runner (aiRng, each a decision from the state); show only: how long the rituals last, which one (propRng)' },
  'visits.ts': { count: 9, why: 'AI: whether and who visits the mound (from the pitcher\'s trouble), whether a manager challenges a close call (aiRng); show only: how long they talk, the number of warm-up pitches (propRng)' },
  'breaks.ts': { count: 5, why: 'show only: the length of the inning break and the rhythm of the warm-up tosses (propRng)' },
  'batting.ts': { count: 1, why: 'perception: does the batter recognise the pitch type (noise in what he sees, not what happens)' },
  'pitching.ts': { count: 1, why: 'release lapse: a heavy tail on the pitcher\'s command noise; the pitch\'s flight and result still come from physics' },
  'flow.ts': { count: 2, why: 'direction / speed the ball squirts off the catcher\'s block (physical scatter)' },
  'fielding.ts': { count: 1, why: 'direction the ball spills after a bobble (physical scatter)' },
};

describe('audit: no dice-roll outcomes', () => {
  it('uniform random draws only happen at the audited sites; no Math.random anywhere', () => {
    const dir = path.resolve(__dirname, '..');
    const found: Record<string, number> = {};
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(src.includes('Math.random'), `${f} uses Math.random`).toBe(false);
      const n = (src.match(/\b\w*[rR]ng\.(next|range|int|pick)\(/g) ?? []).length + (f === 'rng.ts' ? (src.match(/this\.next\(\)/g) ?? []).length : 0);
      if (n) found[f] = n;
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.count]));
    expect(found).toEqual(expected);
  });

  it('no outcome table: results never come from a lookup of a probability by pitch / batter outcome', () => {
    // every plate-appearance result is produced by rules.* from physical state: there is no code path that picks a result name
    // from a random draw (walks/strikeouts come from calls on physically flown pitches, hits from fielders vs the ball ...)
    const dir = path.resolve(__dirname, '..');
    const src = fs.readdirSync(dir).filter((n) => n.endsWith('.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(/outcomeTable|OUTCOME_TABLE|rollOutcome|probabilityOf(Hit|Walk|Strikeout|HomeRun)/i.test(src)).toBe(false);
  });
});

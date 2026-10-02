import { describe, expect, it } from 'vitest';
import { umpireCallText, umpireText } from '../../../../src/audio/cues';
import { buildScript, summarize } from '../generate';
import { fill, Rand } from '../slots';
import { TEMPLATES } from '../templates';
import { loadPools } from '../vocab';

const lines = buildScript();
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ');

describe('pools parsed from the sim source', () => {
  const p = loadPools();
  it('are not thin (roster.ts / rules.ts changed shape if this fails)', () => {
    expect(p.first.length).toBeGreaterThan(100);
    expect(p.last.length).toBeGreaterThan(100);
    expect(p.cities.length).toBeGreaterThanOrEqual(30);
    expect(p.abbrevs.length).toBe(p.cities.length);
    expect(p.mascots.length).toBeGreaterThanOrEqual(30);
    expect(p.positions.length).toBe(9);
    expect([p.jerseyMin, p.jerseyMax]).toEqual([1, 99]);
  });
});

describe('script', () => {
  it('has unique ids and clean text', () => {
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
    for (const l of lines) {
      expect(l.text, l.id).not.toMatch(/[{}]/);
      expect(l.normalized, l.id).not.toMatch(/\d/);
      expect(l.session, l.id).toMatch(/^[PCE]\d+$/);
      expect(l.direction.length, l.id).toBeGreaterThan(10);
    }
  });

  it('hits the duration and size targets', () => {
    const [pilot, core, ext] = summarize(lines);
    expect(pilot.lines).toBeGreaterThanOrEqual(110);
    expect(pilot.lines).toBeLessThanOrEqual(150);
    expect(pilot.minutes).toBeGreaterThanOrEqual(9.5);
    expect(pilot.minutes).toBeLessThanOrEqual(13);
    expect(core.lines).toBeGreaterThanOrEqual(550);
    expect(core.lines).toBeLessThanOrEqual(650);
    expect(core.minutes).toBeGreaterThanOrEqual(55);
    expect(core.minutes).toBeLessThanOrEqual(65);
    expect(ext.lines).toBeGreaterThan(800);
  });

  it('gives every multi-speaker id enough core lines', () => {
    const [, core] = summarize(lines);
    for (const sp of [0, 1, 2]) expect(core.perSpeaker[sp] ?? 0, `speaker ${sp}`).toBeGreaterThanOrEqual(90);
    const pilot = summarize(lines)[0];
    for (const sp of [0, 1, 2]) expect(pilot.perSpeaker[sp] ?? 0, `pilot speaker ${sp}`).toBeGreaterThanOrEqual(10);
    // the big calls need their own weight
    expect((core.perStyle.peak ?? 0) + (core.perStyle.excited ?? 0)).toBeGreaterThanOrEqual(100);
  });

  it('keeps sessions short (about 6-15 min of audio) and ordered by tier', () => {
    const bySession = new Map<string, number>();
    for (const l of lines) bySession.set(l.session, (bySession.get(l.session) ?? 0) + l.estSeconds);
    for (const [s, sec] of bySession) {
      expect(sec / 60, s).toBeLessThan(17);
      expect(sec / 60, s).toBeGreaterThan(2);
    }
    const prio = lines.map((l) => l.priority);
    expect([...prio].sort()).toEqual(prio);
  });

  it('covers everything the umpire says in src/audio/cues.ts', () => {
    const all = lines.map((l) => flat(l.text)).join(' | ');
    const said = new Set<string>();
    for (const k of ['ball', 'strikeLooking', 'strikeSwinging', 'foul', 'foulTip', 'hitByPitch', 'infieldFly', 'balk', 'safe', 'out']) for (const [b, s] of [[0, 0], [3, 2]]) {
      const t = umpireText(k, b, s);
      if (t) said.add(t);
    }
    for (const k of ['ball', 'ball_four', 'strike_called', 'strike_swinging', 'strikeout', 'foul', 'foul_tip', 'safe', 'out', 'time']) {
      const t = umpireCallText(k);
      if (t) said.add(t);
    }
    expect(said.size).toBeGreaterThan(8);
    for (const t of said) expect(all, t).toContain(flat(t).trim());
  });

  it('covers every name, team, position and number the sim can say', () => {
    const p = loadPools();
    const words = new Set(lines.flatMap((l) => flat(l.normalized).split(' ')));
    const phrases = lines.map((l) => flat(l.normalized));
    for (const n of [...p.first, ...p.last, ...p.cities]) expect(words.has(n.toLowerCase()), n).toBe(true);
    for (const m of p.mascots) expect(phrases.some((x) => x.includes(m.toLowerCase())), m).toBe(true);
    for (const pos of p.positions) expect(phrases.some((x) => x.includes(pos)), pos).toBe(true);
    for (let n = 0; n <= 130; n++) expect(lines.some((l) => l.text === `${n}.`), String(n)).toBe(true);
    for (let mph = 40; mph <= 110; mph++) expect(lines.some((l) => l.text === `${mph} miles an hour.`), String(mph)).toBe(true);
  });

  it('every template expands without unknown slots', () => {
    const p = loadPools();
    const r = new Rand('t');
    for (const t of TEMPLATES) for (const v of Array.isArray(t.text) ? t.text : [t.text]) expect(fill(v, r, p), t.id).not.toMatch(/[{}]/);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildScript())).toBe(JSON.stringify(lines));
  });
});

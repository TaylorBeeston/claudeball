import { describe, expect, it } from 'vitest';
import { FAN_CAPS, FanBook, type FanSituation } from '../fans';
import type { CrowdFans } from '../../sim/fans';

const fans: CrowdFans = {
  favourites: [
    { id: 'h3', name: 'Tom Ace', kind: 'star', years: 4, pitcher: false },
    { id: 'h5', name: 'Al Old', kind: 'veteran', years: 9, pitcher: false },
    { id: 'hsp', name: 'Sid Arm', kind: 'ace', years: 3, pitcher: true },
  ],
  villains: [{ id: 'a4', name: 'Vic Boo', kind: 'former', years: 2, pitcher: false }],
  rivals: false,
};
const sit = (half: 'top' | 'bottom', inning = 3, o: Partial<FanSituation> = {}): FanSituation => ({ inning, half, score: { home: 1, away: 1 }, runners: [false, false, false], ...o });

/** nine innings of plate appearances, everyone up four times or so: who got a reaction, in order */
function game(book: FanBook) {
  const out: string[] = [];
  for (let inn = 1; inn <= 9; inn++)
    for (const half of ['top', 'bottom'] as const) {
      const side = half === 'top' ? 'a' : 'h';
      for (let k = 1; k <= 4; k++) {
        const r = book.batterUp(`${side}${((inn * 4 + k) % 9) + 1}`, 'X', half === 'top' ? 'hsp' : 'asp', 'P', sit(half, inn));
        if (r.batter) out.push(`${inn}${half[0]} ${r.batter.id} ${r.batter.size}`);
        if (r.pitcher) out.push(`${inn}${half[0]} pitcher ${r.pitcher.id}`);
      }
    }
  return out;
}

describe('fan book: when the crowd reacts to the man announced', () => {
  it('a favourite\'s first time up always gets the full reaction; ordinary batters none', () => {
    const b = new FanBook(fans, { seed: 's1' });
    expect(b.batterUp('h1', 'Joe Plain', 'asp', 'P', sit('bottom')).batter).toBeNull();
    const r = b.batterUp('h3', 'Tom Ace', 'asp', 'P', sit('bottom')).batter!;
    expect(r).toMatchObject({ side: 'favourite', kind: 'star', size: 1, pa: 1 });
    // the visitors' favourite-to-hate, his first time up
    expect(b.batterUp('a4', 'Vic Boo', 'hsp', 'P', sit('top')).batter).toMatchObject({ side: 'villain', kind: 'former', pa: 1 });
    // a home favourite batting for... never: favourites only cheer for the home side, villains only boo the visitors
    expect(b.batterUp('a4', 'Vic Boo', 'hsp', 'P', sit('bottom')).batter).toBeNull();
  });

  it('the home ace gets a hand at his introduction only (the first batter he faces)', () => {
    const b = new FanBook(fans, { seed: 's1' });
    expect(b.batterUp('a1', 'X', 'hsp', 'Sid Arm', sit('top', 1)).pitcher).toMatchObject({ kind: 'ace', pitcher: true });
    expect(b.batterUp('a2', 'X', 'hsp', 'Sid Arm', sit('top', 1)).pitcher).toBeNull();
    expect(b.batterUp('h1', 'X', 'asp', 'Visiting Arm', sit('bottom', 1)).pitcher).toBeNull();
  });

  it('is the same game after game on the same seed, and capped: not every batter, not every time', () => {
    const a = game(new FanBook(fans, { seed: 'g7' }));
    expect(game(new FanBook(fans, { seed: 'g7' }))).toEqual(a);
    const b = new FanBook(fans, { seed: 'g7' });
    game(b);
    expect(b.log.filter((m) => m.side === 'favourite' && !m.pitcher).length).toBeLessThanOrEqual(FAN_CAPS.favourite);
    expect(b.log.filter((m) => m.side === 'villain').length).toBeLessThanOrEqual(FAN_CAPS.villain);
    for (const id of ['h3', 'h5', 'a4']) expect(b.log.filter((m) => m.id === id).length).toBeLessThanOrEqual(FAN_CAPS.perPlayer);
    // ~72 plate appearances, a handful of reactions
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(a.length).toBeLessThan(14);
  });

  it('a visitor who homered gets booed his next time up', () => {
    const b = new FanBook({ ...fans, villains: [] }, { seed: 's2' });
    expect(b.batterUp('a7', 'Big Swing', 'hsp', 'P', sit('top')).batter).toBeNull();
    b.observe({ type: 'homeRun', batterId: 'a7' });
    b.observe({ type: 'runScored', team: 'away' });
    b.observe({ type: 'plateAppearanceEnd', batterId: 'a7', result: 'home run' });
    expect(b.batterUp('a7', 'Big Swing', 'hsp', 'P', sit('top', 5)).batter).toMatchObject({ side: 'villain', kind: 'burned', burnedBy: 'hr' });
    // once is enough: the time after, nothing (he is not a villain of his own)
    expect(b.batterUp('a7', 'Big Swing', 'hsp', 'P', sit('top', 8)).batter).toBeNull();
  });

  it('two runs in on a visitor\'s plate appearance count too; one does not', () => {
    const b = new FanBook({ ...fans, villains: [] }, { seed: 's2' });
    for (const [id, runs] of [['a2', 2], ['a3', 1]] as const) {
      b.batterUp(id, 'X', 'hsp', 'P', sit('top'));
      for (let i = 0; i < runs; i++) b.observe({ type: 'runScored', team: 'away' });
      b.observe({ type: 'plateAppearanceEnd', batterId: id, result: 'double' });
    }
    expect(b.batterUp('a2', 'X', 'hsp', 'P', sit('top', 4)).batter).toMatchObject({ kind: 'burned', burnedBy: 'rbi' });
    expect(b.batterUp('a3', 'X', 'hsp', 'P', sit('top', 4)).batter).toBeNull();
  });

  it('`force` (debug) makes every batter a favourite or a villain; no picks, no reactions', () => {
    const f = new FanBook(null, { seed: 's', force: true });
    expect(f.batterUp('h1', 'X', 'asp', 'P', sit('bottom')).batter?.side).toBe('favourite');
    expect(f.batterUp('a1', 'X', 'hsp', 'P', sit('top')).batter?.side).toBe('villain');
    const none = new FanBook(null, { seed: 's' });
    expect(game(none)).toEqual([]);
  });
});

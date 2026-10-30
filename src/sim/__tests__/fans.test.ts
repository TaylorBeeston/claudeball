import { describe, expect, it } from 'vitest';
import { CITIES, MASCOTS, generateTeam } from '../roster';
import { crowdFans, rivalsOf } from '../fans';
import { buildGameInfo } from '../gameinfo';
import { createGame } from '../game';
import type { Team } from '../types';

const clubs = Array.from({ length: 30 }, (_, i) => ({ abbr: CITIES[i][1], name: `${CITIES[i][0]} ${MASCOTS[(i * 7 + 4) % MASCOTS.length]}` }));
const club = (i: number, side: 'home' | 'away') => generateTeam(`club:${clubs[i].abbr}`, { side, name: clubs[i].name, abbrev: clubs[i].abbr });

describe('crowd favourites and villains', () => {
  it('favourites belong to the home club: the same players whoever the visitors are', () => {
    const a = crowdFans({ home: club(4, 'home'), away: club(9, 'away') });
    const b = crowdFans({ home: club(4, 'home'), away: club(17, 'away') });
    expect(a.favourites).toEqual(b.favourites);
    expect(a.favourites.length).toBeGreaterThanOrEqual(1);
    const home = club(4, 'home');
    for (const f of a.favourites) {
      const p = home.roster.find((x) => x.id === f.id)!;
      expect(p.name).toBe(f.name);
      expect(f.pitcher).toBe(p.isPitcher);
      // never more seasons with the club than he has been a pro
      expect(f.years).toBeGreaterThanOrEqual(1);
      expect(f.years).toBeLessThanOrEqual(Math.max(1, p.age - 21));
      if (!f.pitcher) expect(home.lineup.some((s) => s.playerId === f.id)).toBe(true);
    }
  });

  it('villains belong to the matchup and come from the visitors\' lineup; most visits have none, never more than two', () => {
    const n = [0, 0, 0];
    for (let h = 0; h < 30; h += 3)
      for (let a = 0; a < 30; a++) {
        if (a === h) continue;
        const home = club(h, 'home');
        const away = club(a, 'away');
        const f = crowdFans({ home, away });
        expect(f).toEqual(crowdFans({ home: club(h, 'home'), away: club(a, 'away') }));
        expect(f.rivals).toBe(rivalsOf(away, home));
        n[f.villains.length]++;
        for (const v of f.villains) {
          expect(away.lineup.some((s) => s.playerId === v.id)).toBe(true);
          if (v.kind === 'rival') expect(f.rivals).toBe(true);
        }
      }
    expect(n[0]).toBeGreaterThan(n[1]);
    expect(n[1]).toBeGreaterThan(n[2]);
  });

  it('copes with a club that has no lineup or pitchers listed', () => {
    const t = club(2, 'home');
    const bare: Team = { ...t, lineup: [], rotation: [], bullpen: [], startingPitcherId: 'nobody' };
    expect(crowdFans({ home: bare, away: bare })).toEqual({ favourites: [], villains: [], rivals: rivalsOf(bare, bare) });
  });

  it('is in the game info, and never changes the game (it has streams of its own)', () => {
    const home = club(5, 'home');
    const away = club(11, 'away');
    expect(buildGameInfo(7, { home, away }).fans).toEqual(crowdFans({ home, away }));
    const g = createGame({ seed: 4242, homeTeam: home, awayTeam: away, pace: 0, innings: 3 });
    expect(g.info.fans).toEqual(crowdFans({ home, away }));
  });
});

/**
 * The crowd's favourites and villains over real games, headless: the sim plays a game between two clubs (broadcast tempo), its events go
 * through the same path as in the browser (the cue mapper for the PA's lines, the fan book for the decision, the crowd model for the
 * reaction) on the sim's clock, with the PA's line timed the way the controller times it (the name lands `estimateDuration` into the line).
 * Writes, for each game, who the picks were and every reaction with the crowd level around it, and over all games the average crowd level
 * lined up on the name (favourites, villains, ordinary batters). Nothing here is heard: these are the model's numbers.
 *
 *   npx tsx tools/audio/fans.ts [--games 20] [--out DIR] [--force] [--jobs 4]
 *
 * A broadcast-tempo game takes the sim about a minute and a half headless: `--jobs` plays the games in that many processes (each one
 * `--only i,j,...` writes `raw/game-<i>.json`), then the summary is made from the raw files.
 * Default output: ~/claudeball-audio-renders/fans/ (summary.json, games.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGame } from '../../src/sim';
import { CLUBS, simTeams } from '../../src/ui/clubs';
import { CueMapper } from '../../src/audio/cues';
import { CrowdModel, type CrowdCtx } from '../../src/audio/crowd';
import { FanBook, type FanMoment } from '../../src/audio/fans';
import { mulberry32 } from '../../src/audio/dsp';
import { estimateDuration } from '../../src/audio/broadcast/text';
import type { Cue, MapCtx, RawEvent } from '../../src/audio/types';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const GAMES = Number(opt('games', '20'));
const OUT = opt('out', path.join(os.homedir(), 'claudeball-audio-renders/fans'));
const FORCE = args.includes('--force');
const JOBS = Number(opt('jobs', '1'));
const ONLY = opt('only', '');
const RAW = path.join(OUT, 'raw');
const STEP = 0.1;
/** the window kept around each name: 3 s before to 15 s after */
const PRE = 3;
const POST = 15;

const SITUATION = new Set(['gameStart', 'halfInningStart', 'halfInningEnd', 'batterUp', 'windup', 'call', 'out', 'safe', 'runScored', 'plateAppearanceEnd', 'homeRun', 'walk', 'steal', 'gameEnd']);

type Kind = 'favourite' | 'villain' | 'pitcher' | 'plainHome' | 'plainAway';
interface Pa {
  kind: Kind;
  /** sim time of the name (ordinary batters: where it would be) */
  at: number;
  firstPitch: number | null;
  m: FanMoment | null;
  inning: number;
  half: string;
}

function play(n: number) {
  const r = mulberry32(9100 + n);
  const away = Math.floor(r() * CLUBS.length);
  let home = Math.floor(r() * (CLUBS.length - 1));
  if (home >= away) home++;
  const seed = 7000 + n;
  const g = createGame({ seed, tempo: 'broadcast', ...simTeams({ seed, away, home } as Parameters<typeof simTeams>[0]) });
  const events: RawEvent[] = [];
  let last: CrowdCtx | null = null;
  g.on('*', ((e: RawEvent) => {
    // the situation (a snapshot is not cheap: only the events that can change it take a new one)
    if (!last || SITUATION.has(e.type)) {
      const s = g.getState();
      last = { inning: s.inning, half: s.half, outs: s.outs, balls: s.balls, strikes: s.strikes, score: { home: s.score.home, away: s.score.away }, runners: [!!s.runners.first, !!s.runners.second, !!s.runners.third] };
    }
    events.push({ ...e, _ctx: last });
  }) as never);
  g.simulateToEnd(6 * 3600);
  const teams = g.getTeams();
  const people = new Map<string, { name: string; number: number }>();
  for (const t of [teams.home, teams.away]) for (const p of t.roster) people.set(p.id, { name: p.name, number: p.jersey });

  const book = new FanBook(g.info.fans, { seed: String(seed), force: FORCE });
  const crowd = new CrowdModel({ rng: mulberry32(seed) });
  const mapper = new CueMapper({ detailed: true, crowdCues: false });
  const trace: { t: number; level: number; energy: number; home: number; away: number }[] = [];
  const pas: Pa[] = [];
  let cur: Pa | null = null;
  let t = 0;
  const advance = (to: number) => {
    while (t + STEP <= to) {
      t += STEP;
      const bed = crowd.update(STEP, false);
      trace.push({ t: +t.toFixed(1), level: bed.level, energy: crowd.energy, home: bed.zones.home_side, away: bed.zones.line_1b });
    }
  };
  for (const ev of events) {
    const time = Number(ev.time ?? t);
    advance(time);
    const c = ev._ctx as CrowdCtx;
    crowd.setContext(c);
    let cev = ev;
    if (ev.type === 'batterUp') {
      const mc = { ...c, pos: () => undefined, person: (id: unknown) => people.get(String(id)), teams: { home: teams.home.name, away: teams.away.name } } as unknown as MapCtx;
      const cues = mapper.map(ev, mc);
      const pa = cues.filter((x): x is Extract<Cue, { kind: 'speak' }> => x.kind === 'speak' && x.role === 'pa').map((x) => x.text);
      const bid = String(ev.batterId);
      const pid = String(ev.pitcherId);
      const res = book.batterUp(bid, people.get(bid)?.name ?? '', pid, people.get(pid)?.name ?? '', { inning: c.inning, half: c.half, score: c.score, runners: c.runners });
      // the PA's lines, one after the other: the pitcher's introduction first, then the batter's (a short breath between)
      const pLine = pa.find((x) => x.startsWith('Now pitching'));
      const bLine = pa.find((x) => !x.startsWith('Now pitching')) ?? '';
      const bStart = 0.1 + (pLine ? estimateDuration(pLine, 0.92) + 0.1 : 0);
      const nameIn = (line: string, name: string, start: number) => start + estimateDuration(line.slice(0, Math.max(0, line.lastIndexOf(name))) || 'x', 0.92);
      if (res.pitcher && pLine) {
        pas.push({ kind: 'pitcher', at: time + nameIn(pLine, res.pitcher.name, 0), firstPitch: null, m: res.pitcher, inning: c.inning, half: c.half });
      }
      const name = people.get(bid)?.name ?? '';
      const at = nameIn(bLine, name, bStart);
      if (res.batter?.side === 'favourite') cev = { ...ev, fan: 'favourite' };
      // the crowd hears the new batter first (that ends the last man's reaction), then the PA gets to the name
      crowd.observe(cev, c);
      if (res.pitcher && pLine) crowd.fan(res.pitcher, nameIn(pLine, res.pitcher.name, 0));
      if (res.batter) crowd.fan(res.batter, at);
      cur = { kind: res.batter ? res.batter.side : c.half === 'bottom' ? 'plainHome' : 'plainAway', at: time + at, firstPitch: null, m: res.batter, inning: c.inning, half: c.half };
      pas.push(cur);
      continue;
    }
    book.observe(ev);
    if (ev.type === 'windup' && cur && cur.firstPitch === null) cur.firstPitch = time;
    crowd.observe(cev, c);
  }
  advance(t + POST);
  const log = book.log;
  return { n, seed, home: teams.home.name, away: teams.away.name, fans: g.info.fans, log, trace, pas, score: g.getState().score };
}
type Game = ReturnType<typeof play>;

const at = (tr: { t: number }[], time: number) => Math.min(tr.length - 1, Math.max(0, Math.round(time / STEP) - 1));
fs.mkdirSync(RAW, { recursive: true });
if (ONLY) {
  for (const i of ONLY.split(',').map(Number)) fs.writeFileSync(path.join(RAW, `game-${i}.json`), JSON.stringify(play(i)));
  process.exit(0);
}
if (JOBS > 1) {
  const { spawn } = await import('node:child_process');
  const parts = Array.from({ length: JOBS }, (_, j) => Array.from({ length: GAMES }, (_, i) => i).filter((i) => i % JOBS === j)).filter((x) => x.length);
  await Promise.all(parts.map((ids) => new Promise<void>((res, rej) => {
    const p = spawn(process.execPath, [...process.execArgv, process.argv[1], '--only', ids.join(','), '--out', OUT, ...(FORCE ? ['--force'] : [])], { stdio: 'inherit' });
    p.on('exit', (c) => (c ? rej(new Error(`worker ${ids} exited ${c}`)) : res()));
  })));
} else for (let i = 0; i < GAMES; i++) fs.writeFileSync(path.join(RAW, `game-${i}.json`), JSON.stringify(play(i)));
const games: Game[] = Array.from({ length: GAMES }, (_, i) => JSON.parse(fs.readFileSync(path.join(RAW, `game-${i}.json`), 'utf8')));

// the crowd level lined up on the name, averaged by kind of batter
const curves: Record<Kind, { n: number; level: number[]; energy: number[]; home: number[]; away: number[] }> = Object.fromEntries(
  (['favourite', 'villain', 'pitcher', 'plainHome', 'plainAway'] as Kind[]).map((k) => [k, { n: 0, level: [], energy: [], home: [], away: [] }]),
) as never;
const steps = Math.round((PRE + POST) / STEP);
const pitchAfter: Record<Kind, number[]> = { favourite: [], villain: [], pitcher: [], plainHome: [], plainAway: [] };
for (const g of games)
  for (const p of g.pas) {
    const i0 = at(g.trace, p.at - PRE);
    if (i0 + steps >= g.trace.length) continue;
    const c = curves[p.kind];
    c.n++;
    for (let k = 0; k < steps; k++) {
      const s = g.trace[i0 + k];
      c.level[k] = (c.level[k] ?? 0) + s.level;
      c.energy[k] = (c.energy[k] ?? 0) + s.energy;
      c.home[k] = (c.home[k] ?? 0) + s.home;
      c.away[k] = (c.away[k] ?? 0) + s.away;
    }
    if (p.firstPitch !== null) pitchAfter[p.kind].push(p.firstPitch - p.at);
  }
for (const c of Object.values(curves)) for (const a of [c.level, c.energy, c.home, c.away]) for (let k = 0; k < a.length; k++) a[k] = +(a[k] / Math.max(1, c.n)).toFixed(4);

const per = games.map((g) => ({ fav: g.log.filter((m) => m.side === 'favourite' && !m.pitcher).length, vil: g.log.filter((m) => m.side === 'villain').length, pit: g.log.filter((m) => m.pitcher).length }));
const stat = (xs: number[]) => ({ mean: +(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)).toFixed(2), max: Math.max(0, ...xs), zero: xs.filter((x) => x === 0).length });
const summary = {
  games: GAMES,
  force: FORCE,
  perGame: { favourite: stat(per.map((p) => p.fav)), villain: stat(per.map((p) => p.vil)), pitcher: stat(per.map((p) => p.pit)), all: stat(per.map((p) => p.fav + p.vil + p.pit)) },
  pasPerGame: +(games.reduce((a, g) => a + g.pas.filter((p) => p.kind !== 'pitcher').length, 0) / GAMES).toFixed(1),
  firstPitchAfterName: Object.fromEntries(Object.entries(pitchAfter).map(([k, v]) => [k, stat(v.map((x) => +x.toFixed(1)))])),
  curves: { pre: PRE, post: POST, step: STEP, ...curves },
};
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));

// the readable log: per game the picks, and every reaction with the crowd level 1 s before the name, its peak before the first pitch, 3 s after it
const md: string[] = ['# Crowd favourites and villains: game logs', '', `${GAMES} games, broadcast tempo${FORCE ? ', `force` (every batter)' : ''}. Level: the crowd model's 0..1 bed level (what the stadium loops follow).`, ''];
for (const g of games) {
  md.push(`## Game ${g.n + 1}: ${g.away} at ${g.home} (seed ${g.seed}), final ${g.score.away}-${g.score.home}`, '');
  md.push(`- favourites: ${g.fans.favourites.map((f) => `${f.name} (${f.kind}, ${f.years} season${f.years === 1 ? '' : 's'})`).join(', ') || 'none'}`);
  md.push(`- villains: ${g.fans.villains.map((f) => `${f.name} (${f.kind})`).join(', ') || 'none'}${g.fans.rivals ? ' (rivals)' : ''}`, '');
  const rows = g.pas.filter((p) => p.m);
  if (!rows.length) md.push('No reactions this game.', '');
  else {
    md.push('| inning | who | why | size | PA # | level before | peak (to the 1st pitch) | 3 s after the 1st pitch | 1st pitch after the name |', '|---|---|---|---|---|---|---|---|---|');
    for (const p of rows) {
      const before = g.trace[at(g.trace, p.at - 1)].level;
      const end = p.firstPitch ?? p.at + 12;
      let peak = 0;
      for (let k = at(g.trace, p.at); k <= at(g.trace, end); k++) peak = Math.max(peak, g.trace[k].level);
      const after = g.trace[at(g.trace, end + 3)].level;
      md.push(`| ${p.half === 'top' ? 'T' : 'B'}${p.inning} | ${p.m!.name} | ${p.m!.side} ${p.m!.kind}${p.m!.burnedBy ? ` (${p.m!.burnedBy})` : ''} | ${p.m!.size} | ${p.m!.pa} | ${before.toFixed(2)} | ${peak.toFixed(2)} | ${after.toFixed(2)} | ${p.firstPitch !== null ? `${(p.firstPitch - p.at).toFixed(1)} s` : '-'} |`);
    }
    md.push('');
  }
}
fs.writeFileSync(path.join(OUT, 'games.md'), md.join('\n'));
console.log(JSON.stringify({ ...summary, curves: Object.fromEntries(Object.entries(curves).map(([k, c]) => [k, { n: c.n, peakLevel: Math.max(...c.level), levelAtName: c.level[Math.round(PRE / STEP)] }])) }, null, 1));
console.log(`-> ${OUT}`);

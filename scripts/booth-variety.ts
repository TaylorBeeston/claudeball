/**
 * How often the booth repeats itself: plays chains of whole simulated games through the broadcast booth (no audio, a fake clock, like
 * `booth-transcript.ts`) and counts, per line, template and story, how often each is said and how often the same words come back within a game
 * and across the games of a chain (the user watches one game after another, so a chain shares the booth's memory between games when it has one).
 *
 *   npx tsx scripts/booth-variety.ts [--chains 3] [--games 10] [--seed 101] [--innings 9] [--tempo broadcast] [--memory on|off] [--json out.json] [--top 25]
 *
 * "Exact" repeats compare the words as said; "shape" repeats mask the names (players, clubs, the park, the officials), digits and number words,
 * so "Brooks sets them down in order." in one game and "Silva sets them down in order." in the next are the same line to the listener.
 * Used for docs/announcer-variety.md.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGame } from '../src/sim/index';
import { Booth } from '../src/audio/broadcast/booth';
import { ctxFromRaw } from '../src/audio/broadcast/ctx';
import { mulberry32 } from '../src/audio/dsp';
import { factsFromGame } from '../src/audio/broadcast/facts';
import { estimateDuration } from '../src/audio/broadcast/text';
import { LEX } from '../src/audio/broadcast/lexicon';
import { paWelcome } from '../src/audio/cues';
import { teamInfo } from '../src/engine/realSimAdapter';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Said {
  voice: string;
  text: string;
  tag: string;
  imp: string;
  t: number;
}
interface GameOut {
  seed: number;
  tod: string;
  minutes: number;
  lines: Said[];
  /** words that are names in this game (masked for the shape) */
  names: string[];
  /** the booth looked for a conversation topic and had nothing (null) */
  topicAsks: number;
  topicNone: number;
}

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const TODS = ['night', 'day', 'dusk'] as const;

/** one game through the booth; `memory` (the booth's memory across games, when it has one) is shared along a chain */
function playGame(seed: number, innings: number, tempo: 'quick' | 'standard' | 'broadcast', tod: (typeof TODS)[number], memory: unknown): GameOut {
  const g: any = createGame({ seed, innings, tempo } as never);
  const booth: any = new Booth({ rng: mulberry32(seed * 7 + 1), level: 'normal' });
  if (memory && 'memory' in booth) booth.memory = memory;
  const teams = g.getTeams();
  const facts = factsFromGame(g, String(seed), tod, false, (side) => teamInfo({ name: teams[side].name, abbrev: teams[side].abbrev }, side === 'home' ? 1 : 0));
  const welcome = paWelcome({ teams: { home: teams.home.name, away: teams.away.name }, venue: facts?.venue?.name, tod });
  booth.setFacts(facts, 0.5 + estimateDuration(welcome, 0.92) + 0.8);
  // the names of this game: every player, the clubs, the park, the officials, the managers, the mascot
  const names = new Set<string>();
  const addName = (s?: string) => s && s.split(/[\s,."]+/).filter((w) => /^[A-Z]/.test(w)).forEach((w) => names.add(w.replace(/'s$/, '')));
  for (const side of ['home', 'away'] as const) {
    addName(teams[side].name);
    for (const p of teams[side].roster ?? []) addName(p.name);
  }
  const info = g.info;
  addName(info?.venue?.name);
  addName(info?.venue?.short);
  addName(info?.venue?.city);
  addName(info?.mascot);
  for (const u of info?.umpires ?? []) addName(u.name);
  for (const side of ['home', 'away'] as const) {
    addName(info?.managers?.[side]?.name);
    addName(info?.managers?.[side]?.pitchingCoach);
  }
  let asks = 0;
  let none = 0;
  const nt = booth.nextTopic.bind(booth);
  booth.director.topicSource = () => {
    const r = nt();
    // (only the asks when the booth could have talked: the picker is asked again 1.5 s later when it has nothing)
    if (booth.canTalk && !booth.closed && !booth.trotting && !booth.pendingBreak && booth.pregame !== 'waiting' && booth.pregame !== 'opening') {
      asks++;
      if (!r) none++;
    }
    return r;
  };
  const pending: { ev: any }[] = [];
  g.on('*', (ev: never) => pending.push({ ev }));
  let t = 0;
  let lastPlay = '';
  let phaseNull = false;
  let rs = g.getState();
  const lines: Said[] = [];
  let overAt = -1;
  let fieldUntil = 0;
  while ((overAt < 0 || t - overAt < 60) && t < 4 * 3600) {
    if (rs.gameOver && overAt < 0) overAt = t;
    g.step(1 / 120);
    t += 1 / 120;
    if (Math.round(t * 120) % 6 !== 0) continue; // 20 Hz
    rs = g.getState();
    const c = ctxFromRaw(rs, { lastPlay, crowd: 0.4, game: g });
    for (const { ev } of pending.splice(0)) {
      if (ev.type === 'gameStart') fieldUntil = t + 0.5 + estimateDuration(welcome, 0.92);
      if (ev.type === 'playEnd') lastPlay = String(ev.description ?? '');
      if (ev.type === 'windup' || ev.type === 'contact') phaseNull = true;
      if (ev.type === 'plateAppearanceEnd' || ev.type === 'call' || ev.type === 'halfInningEnd' || ev.type === 'batterUp') phaseNull = false;
      booth.observe(ev, c, t);
    }
    booth.canTalk = !phaseNull;
    for (const a of booth.tick(t, c, { suppressed: false, fieldHold: t < fieldUntil })) {
      if (a.type !== 'start') continue;
      // (a folded count in front of a call is its own line to the ear)
      for (const cl of a.clauses) lines.push({ voice: a.voice, text: cl.text, tag: cl.fold ? 'fold.count' : a.item.tag ?? '?', imp: a.item.importance, t });
    }
  }
  return { seed, tod, minutes: t / 60, lines, names: [...names], topicAsks: asks, topicNone: none };
}

// ---- analysis ----------------------------------------------------------------------------------------------------------------------

const NUMW = /\b(no|zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|once|twice)\b/gi;

export function shapeOf(text: string, names: Set<string>): string {
  return text
    .split(/(\s+)/)
    .map((w) => {
      const core = w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').replace(/'s$/, '');
      return core && names.has(core) ? w.replace(core, '#N') : w;
    })
    .join('')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(NUMW, '#')
    .replace(/(#N[\s,]*)+(and #N)?/g, '#N ')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,!?;:])/g, '$1')
    .trim();
}

const LEX_KEYS = new Set(Object.keys(LEX));
export function category(tag: string, imp: string): 'call' | 'reaction' | 'topic' | 'segment' {
  if (tag === 'fold.count') return 'call';
  if (/^(open|break|close)\./.test(tag)) return 'segment';
  if (tag === 'react' || tag.startsWith('react.') || tag.startsWith('phrase.')) return 'reaction';
  if (LEX_KEYS.has(tag) || tag === 'replay' || imp !== 'could') return 'call';
  return 'topic';
}

interface Row {
  shape: string;
  example: string;
  tag: string;
  cat: string;
  uses: number;
  games: Set<string>;
}

function analyse(chains: GameOut[][], top: number) {
  const cats = ['call', 'reaction', 'topic', 'segment'] as const;
  type Acc = { lines: number; dupExactInGame: number; dupShapeInGame: number; heardShapeBefore: number; heardExactBefore: number; laterLines: number; laterHeard: number };
  const zero = (): Acc => ({ lines: 0, dupExactInGame: 0, dupShapeInGame: 0, heardShapeBefore: 0, heardExactBefore: 0, laterLines: 0, laterHeard: 0 });
  const by: Record<string, Acc> = { all: zero(), nonCall: zero() };
  for (const c of cats) by[c] = zero();
  const rows = new Map<string, Row>();
  const tagUse = new Map<string, { uses: number; shapes: Set<string>; cat: string }>();
  let asks = 0;
  let none = 0;
  let games = 0;
  let minutes = 0;
  const perGameIndex: { lines: number; heard: number }[] = [];
  chains.forEach((chain, ci) => {
    const heardShape = new Set<string>();
    const heardExact = new Set<string>();
    chain.forEach((g, gi) => {
      games++;
      minutes += g.minutes;
      asks += g.topicAsks;
      none += g.topicNone;
      const names = new Set(g.names);
      const inShape = new Set<string>();
      const inExact = new Set<string>();
      const gameShapes: string[] = [];
      const pg = (perGameIndex[gi] ??= { lines: 0, heard: 0 });
      for (const l of g.lines) {
        const cat = category(l.tag, l.imp);
        const shape = shapeOf(l.text, names);
        const accs = [by.all, by[cat], ...(cat === 'call' ? [] : [by.nonCall])];
        for (const a of accs) {
          a.lines++;
          if (inExact.has(l.text)) a.dupExactInGame++;
          if (inShape.has(shape)) a.dupShapeInGame++;
          if (heardShape.has(shape)) a.heardShapeBefore++;
          if (heardExact.has(l.text)) a.heardExactBefore++;
          if (gi >= chain.length / 2) {
            a.laterLines++;
            if (heardShape.has(shape)) a.laterHeard++;
          }
        }
        if (cat !== 'call') {
          pg.lines++;
          if (heardShape.has(shape)) pg.heard++;
        }
        inExact.add(l.text);
        inShape.add(shape);
        gameShapes.push(shape);
        const key = `${cat}|${shape}`;
        const r = rows.get(key) ?? { shape, example: l.text, tag: l.tag, cat, uses: 0, games: new Set<string>() };
        r.uses++;
        r.games.add(`${ci}.${gi}`);
        rows.set(key, r);
        const tu = tagUse.get(l.tag) ?? { uses: 0, shapes: new Set<string>(), cat };
        tu.uses++;
        tu.shapes.add(shape);
        tagUse.set(l.tag, tu);
      }
      for (const s of gameShapes) heardShape.add(s);
      for (const l of g.lines) heardExact.add(l.text);
    });
  });
  const pctf = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : '0.0');
  const out: string[] = [];
  out.push(`${games} games in ${chains.length} chains of ${chains[0]?.length ?? 0}, ${(minutes / games).toFixed(0)} min a game on average, ${(by.all.lines / games).toFixed(0)} lines a game (${(by.nonCall.lines / games).toFixed(0)} not calls)`);
  out.push('');
  out.push('| lines | per game | exact repeat within the game | shape repeat within the game | shape heard in an earlier game of the chain | ... in the second half of the chain |');
  out.push('|---|---|---|---|---|---|');
  for (const k of ['all', 'nonCall', ...cats]) {
    const a = by[k];
    out.push(`| ${k === 'nonCall' ? 'everything but calls' : k} | ${(a.lines / games).toFixed(0)} | ${pctf(a.dupExactInGame, a.lines)} % | ${pctf(a.dupShapeInGame, a.lines)} % | ${pctf(a.heardShapeBefore, a.lines)} % | ${pctf(a.laterHeard, a.laterLines)} % |`);
  }
  out.push('');
  out.push(`Conversation topics: the booth looked for one ${(asks / games).toFixed(0)} times a game and had nothing ${pctf(none, asks)} % of the time.`);
  out.push('');
  out.push('Not-call lines heard before, by game number in the chain (shape): ' + perGameIndex.map((p, i) => `g${i + 1} ${pctf(p.heard, p.lines)} %`).join(', '));
  out.push('');
  const list = [...rows.values()];
  for (const cat of cats) {
    out.push(`Top repeaters (${cat}): uses across all games, games it was heard in`);
    out.push('');
    out.push('| uses | games | tag | line (shape) |');
    out.push('|---|---|---|---|');
    for (const r of list.filter((x) => x.cat === cat).sort((a, b) => b.games.size - a.games.size || b.uses - a.uses).slice(0, top)) out.push(`| ${r.uses} | ${r.games.size}/${games} | ${r.tag} | ${r.shape.replace(/\|/g, '/')} |`);
    out.push('');
  }
  out.push('Thinnest pools (tags by uses per distinct shape, at least 10 uses):');
  out.push('');
  out.push('| tag | category | uses | distinct shapes | uses per shape |');
  out.push('|---|---|---|---|---|');
  for (const [tag, u] of [...tagUse.entries()].filter(([, u]) => u.uses >= 10).sort((a, b) => b[1].uses / b[1].shapes.size - a[1].uses / a[1].shapes.size).slice(0, top * 2)) out.push(`| ${tag} | ${u.cat} | ${u.uses} | ${u.shapes.size} | ${(u.uses / u.shapes.size).toFixed(1)} |`);
  return { text: out.join('\n'), summary: Object.fromEntries(Object.entries(by).map(([k, a]) => [k, { perGame: a.lines / games, exactInGame: a.dupExactInGame / a.lines, shapeInGame: a.dupShapeInGame / a.lines, shapeBefore: a.heardShapeBefore / a.lines, shapeBeforeLate: a.laterHeard / Math.max(1, a.laterLines) }])), topicNone: none / Math.max(1, asks) };
}

// ---- driver: one child process per chain (a chain's games run in order, sharing the booth's memory) ----------------------------------------

async function main() {
  // `--load saved.json [--limit n]`: analyse a saved run again (the first n games of each chain)
  const load = arg('load', '');
  if (load) {
    const saved = JSON.parse(fs.readFileSync(load, 'utf8')) as { games: GameOut[][] };
    const lim = Number(arg('limit', '0')) || Infinity;
    console.log(analyse(saved.games.map((c) => c.slice(0, lim)).slice(0, Number(arg('chains', '0')) || Infinity), Number(arg('top', '25'))).text);
    return;
  }
  const chainsN = Number(arg('chains', '3'));
  const gamesN = Number(arg('games', '10'));
  const seed0 = Number(arg('seed', '101'));
  const innings = Number(arg('innings', '9'));
  const tempo = arg('tempo', 'broadcast');
  const top = Number(arg('top', '25'));
  const self = fileURLToPath(import.meta.url);
  const runs = await Promise.all(
    Array.from({ length: chainsN }, (_, ci) =>
      new Promise<GameOut[]>((res, rej) => {
        const seeds = Array.from({ length: gamesN }, (_, gi) => seed0 + ci * 1000 + gi * 17);
        const p = spawn(process.execPath, [...process.execArgv, self, '--worker', seeds.join(','), '--innings', String(innings), '--tempo', tempo, '--memory', arg('memory', 'on')], { stdio: ['ignore', 'pipe', 'inherit'] });
        let buf = '';
        p.stdout.on('data', (d) => (buf += d));
        p.on('exit', (code) => (code === 0 ? res(JSON.parse(buf)) : rej(new Error(`chain ${ci} exited ${code}`))));
      }),
    ),
  );
  const a = analyse(runs, top);
  console.log(a.text);
  const json = arg('json', '');
  if (json) fs.writeFileSync(json, JSON.stringify({ summary: a.summary, topicNone: a.topicNone, games: runs.map((c) => c.map((g) => ({ seed: g.seed, tod: g.tod, minutes: g.minutes, lines: g.lines, names: g.names, topicAsks: g.topicAsks, topicNone: g.topicNone }))) }));
}

async function worker() {
  const seeds = arg('worker', '').split(',').map(Number);
  const innings = Number(arg('innings', '9'));
  const tempo = arg('tempo', 'broadcast') as 'quick' | 'standard' | 'broadcast';
  // the booth's memory across games, when the booth has one (shared by the games of this chain; `--memory off`: each game starts with a fresh one)
  let memory: unknown = null;
  if (arg('memory', 'on') !== 'off') try {
    const m: any = await import('../src/audio/broadcast/memory');
    memory = new m.BoothMemory();
  } catch {
    memory = null;
  }
  const out: GameOut[] = [];
  seeds.forEach((s, i) => {
    out.push(playGame(s, innings, tempo, TODS[i % TODS.length], memory));
    process.stderr.write(`  seed ${s} done (${i + 1}/${seeds.length})\n`);
  });
  process.stdout.write(JSON.stringify(out));
}

if (process.argv.includes('--worker')) void worker();
else void main();

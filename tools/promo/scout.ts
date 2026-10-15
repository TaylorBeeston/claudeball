/**
 * Headless highlight search for the promo: plays whole games with the real sim (no rendering) and lists the moments worth filming,
 * with the seed and the sim time, so `promo:render` can seek straight to them in the browser (same seed + tempo => the same game).
 *
 *   npm run promo:scout -- [--from 1] [--count 200] [--tempo standard] [--innings 9] [--jobs 8] [--out ~/claudeball-promo/scout.json]
 *
 * Nothing is scripted: every highlight is something the simulation produced on its own. Kinds found:
 *   homeRun (distance, exit velo), walkOff, robbedHomeRun, wallLeap (a leap at the wall, caught or not), insideParkHR, closeAtFirst
 *   (bang-bang play at first, |margin| < 0.10 s), closePlay (any base), strikeoutSwinging / strikeoutLooking (pitch speed / type),
 *   stealSafe (tag avoided / slide kind), caughtStealing, doublePlay, triplePlay, pickoffOut, error.
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGame } from '../../src/sim/game';
import type { GameEvent } from '../../src/sim/types';

export interface Highlight {
  seed: number;
  kind: string;
  /** sim time of the moment itself (the contact, the catch, the call) */
  t: number;
  /** sim time the play started (the pitch / windup before it): a good place to begin a shot */
  playStart: number;
  inning: number;
  half: 'top' | 'bottom';
  score: { home: number; away: number };
  /** 0-100: how good it should look in a trailer */
  score100: number;
  info: Record<string, unknown>;
}

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

export function scoutGame(seed: number, tempo: 'quick' | 'standard' | 'broadcast', innings: number): { highlights: Highlight[]; seconds: number; final: { home: number; away: number }; innings: number } {
  const g = createGame({ seed, tempo, innings });
  const out: Highlight[] = [];
  let inning = 1;
  let half: 'top' | 'bottom' = 'top';
  const score = { home: 0, away: 0 };
  // the current play: from the windup to playEnd
  let playStart = 0;
  let play: GameEvent[] = [];
  let lastPitch: { mph: number; type: string } | null = null;
  const names = new Map<string, string>();
  const nameOf = (id: string) => {
    if (!names.has(id)) {
      const p = g.getState().players.find((q) => q.id === id) as { name?: string } | undefined;
      names.set(id, p?.name ?? id);
    }
    return names.get(id)!;
  };
  const add = (kind: string, t: number, score100: number, info: Record<string, unknown>) =>
    out.push({ seed, kind, t: +t.toFixed(3), playStart: +playStart.toFixed(3), inning, half, score: { ...score }, score100: Math.round(Math.max(0, Math.min(100, score100))), info });

  const endPlay = (t: number) => {
    const outs = play.filter((e) => e.type === 'out') as Extract<GameEvent, { type: 'out' }>[];
    const contact = play.find((e) => e.type === 'contact') as Extract<GameEvent, { type: 'contact' }> | undefined;
    if (outs.length >= 2 && contact) add(outs.length === 3 ? 'triplePlay' : 'doublePlay', outs[1].time, outs.length === 3 ? 100 : 60 + (outs.some((o) => o.closePlay) ? 15 : 0), { outs: outs.map((o) => ({ type: o.outType, base: o.base, t: +o.time.toFixed(2), margin: o.margin })), exitMph: contact.exitMph });
    const hr = play.find((e) => e.type === 'homeRun');
    const batterScored = contact && play.some((e) => e.type === 'runScored' && e.playerId === contact.batterId);
    const err = play.some((e) => e.type === 'error');
    if (contact && batterScored && !hr && !err) add('insideParkHR', play.find((e) => e.type === 'runScored' && e.playerId === contact.batterId)!.time, 95, { batter: nameOf(contact.batterId), exitMph: contact.exitMph });
    play = [];
    void t;
  };

  g.on('*', (e: GameEvent) => {
    switch (e.type) {
      case 'halfInningStart':
        inning = e.inning;
        half = e.half;
        break;
      case 'windup':
        // a new pitch starts a new play (a foul's contact must not carry over to the next pitch)
        playStart = e.time;
        play = [];
        break;
      case 'pitchReleased':
        lastPitch = { mph: e.mph, type: e.pitchType };
        break;
      case 'runScored':
        score.home = e.runsHome;
        score.away = e.runsAway;
        break;
      case 'playEnd':
        endPlay(e.time);
        break;
    }
    play.push(e);
    const contact = play.find((x) => x.type === 'contact') as Extract<GameEvent, { type: 'contact' }> | undefined;
    switch (e.type) {
      case 'homeRun': {
        const ft = e.distance * 3.28084;
        add('homeRun', e.time, 40 + (ft - 360) * 0.5 + (contact ? (contact.exitMph - 100) * 1.5 : 0) + (inning >= 7 ? 8 : 0), { batter: nameOf(e.batterId), ft: Math.round(ft), exitMph: contact?.exitMph, launchDeg: contact?.launchDeg, contactT: contact?.time, aboveWall: e.heightAboveWall });
        break;
      }
      case 'robbedHomeRun':
        add('robbedHomeRun', e.time, 100, { fielder: nameOf(e.fielderId), batter: nameOf(e.batterId), ft: Math.round(e.distance * 3.28084), aboveWall: e.heightAboveWall, contactT: contact?.time });
        break;
      case 'wallLeap':
        add('wallLeap', e.time, 70 + e.ballHeightAboveWall * 20, { fielder: nameOf(e.fielderId), ballAboveWall: e.ballHeightAboveWall, contactT: contact?.time });
        break;
      case 'out':
        if (e.closePlay) add(e.base === 1 ? 'closeAtFirst' : 'closePlay', e.time, 70 + (0.1 - Math.abs(e.margin ?? 0.1)) * 200, { out: true, outType: e.outType, base: e.base, margin: e.margin, runner: nameOf(e.playerId) });
        if (e.outType === 'strikeout') {
          const call = [...play].reverse().find((x) => x.type === 'umpireCall') as Extract<GameEvent, { type: 'umpireCall' }> | undefined;
          const swinging = play.some((x) => x.type === 'swing');
          add(swinging ? 'strikeoutSwinging' : 'strikeoutLooking', e.time, 40 + ((lastPitch?.mph ?? 90) - 90) * 2 + (inning >= 8 ? 10 : 0), { batter: nameOf(e.playerId), mph: lastPitch?.mph, pitch: lastPitch?.type, call: call?.kind });
        }
        if (play.some((x) => x.type === 'pickoffAttempt') && !contact && e.outType !== 'strikeout') add('pickoffOut', e.time, 75, { runner: nameOf(e.playerId), base: e.base, margin: e.margin });
        if (play.some((x) => x.type === 'steal' && x.runnerId === e.playerId)) add('caughtStealing', e.time, 55 + (e.closePlay ? 20 : 0), { runner: nameOf(e.playerId), base: e.base, margin: e.margin });
        break;
      case 'safe':
        if (e.closePlay) add(e.base === 1 ? 'closeAtFirst' : 'closePlay', e.time, 65 + (0.1 - Math.abs(e.margin ?? 0.1)) * 200, { out: false, base: e.base, margin: e.margin, runner: nameOf(e.playerId) });
        if (play.some((x) => x.type === 'steal' && x.runnerId === e.playerId) && !contact) {
          const av = play.find((x) => x.type === 'tagAvoided' && x.runnerId === e.playerId) as Extract<GameEvent, { type: 'tagAvoided' }> | undefined;
          add('stealSafe', e.time, 55 + (av ? 25 : 0) + (e.closePlay ? 10 : 0), { runner: nameOf(e.playerId), base: e.base, margin: e.margin, tagAvoided: av?.slide ?? null });
        }
        break;
      case 'error':
        add('error', e.time, 30, { fielder: nameOf(e.fielderId), kind: e.kind });
        break;
      case 'gameEnd':
        // a walk-off: the home team won with the last run scoring in the bottom of the last inning
        if (e.winner === 'home' && half === 'bottom' && inning >= innings) {
          const hrw = play.find((x) => x.type === 'homeRun');
          add('walkOff', e.time, 90 + (hrw ? 10 : 0), { homeRun: !!hrw, score: `${e.away}-${e.home}` });
        }
        break;
    }
  });
  const seconds = g.simulateToEnd(8 * 3600);
  return { highlights: out, seconds, final: { ...score }, innings: inning };
}

async function main() {
  const from = +opt('from', '1');
  const count = +opt('count', '200');
  const tempo = opt('tempo', 'standard') as 'quick' | 'standard' | 'broadcast';
  const innings = +opt('innings', '9');
  const jobs = Math.max(1, +opt('jobs', String(Math.min(8, os.cpus().length >> 2))));
  const outFile = opt('out', path.join(os.homedir(), 'claudeball-promo/scout.json'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const seeds = Array.from({ length: count }, (_, i) => from + i);
  const t0 = Date.now();
  const games: { seed: number; seconds: number; final: { home: number; away: number }; innings: number }[] = [];
  const all: Highlight[] = [];
  // split the seeds over child processes (the sim is single-threaded)
  const chunks = Array.from({ length: jobs }, (_, j) => seeds.filter((_, i) => i % jobs === j));
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<void>((res, rej) => {
          const child = fork(new URL(import.meta.url).pathname, ['--child', chunk.join(','), '--tempo', tempo, '--innings', String(innings)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--import', 'tsx'] });
          child.on('message', (m: { seed: number; r: ReturnType<typeof scoutGame> }) => {
            games.push({ seed: m.seed, seconds: Math.round(m.r.seconds), final: m.r.final, innings: m.r.innings });
            all.push(...m.r.highlights);
            if (games.length % 10 === 0) console.log(`[scout] ${games.length}/${count} games, ${all.length} highlights, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
          });
          child.on('exit', (c) => (c === 0 ? res() : rej(new Error(`child exited ${c}`))));
        }),
    ),
  );
  all.sort((a, b) => b.score100 - a.score100 || a.seed - b.seed);
  fs.writeFileSync(outFile, JSON.stringify({ tempo, innings, from, count, at: new Date().toISOString(), games: games.sort((a, b) => a.seed - b.seed), highlights: all }, null, 1));
  const byKind = new Map<string, Highlight[]>();
  for (const h of all) byKind.set(h.kind, [...(byKind.get(h.kind) ?? []), h]);
  console.log(`[scout] ${count} games (tempo ${tempo}, ${innings} inn) in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${outFile}`);
  for (const [k, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${k.padEnd(18)} ${String(list.length).padStart(4)}   best: ${list.slice(0, 4).map((h) => `seed ${h.seed} t${h.t.toFixed(0)} (${h.score100}${h.info.ft ? ', ' + h.info.ft + ' ft' : ''})`).join(' | ')}`);
  }
}

if (argv[0] === '--child') {
  const seeds = argv[1].split(',').filter(Boolean).map(Number);
  for (const s of seeds) process.send!({ seed: s, r: scoutGame(s, opt('tempo', 'standard') as 'standard', +opt('innings', '9')) });
  process.exit(0);
} else if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

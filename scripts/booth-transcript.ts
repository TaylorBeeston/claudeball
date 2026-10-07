/**
 * Plays a whole simulated game through the broadcast booth (no audio) with a fake clock and prints what the two voices would say.
 *   npx tsx scripts/booth-transcript.ts [seed=12] [level=normal] [innings=3] [tempo=broadcast] [tod=night] [--opening]
 * `--opening` stops at the first pitch (the pregame: the PA's welcome, the booth's opening, the handoff).
 * Used to tune the wording and the pacing; the same machinery is unit-tested in src/audio/broadcast/__tests__.
 */
import { createGame } from '../src/sim/index';
import { Booth } from '../src/audio/broadcast/booth';
import { ctxFromRaw } from '../src/audio/broadcast/ctx';
import { mulberry32 } from '../src/audio/dsp';
import type { Level } from '../src/audio/broadcast/director';
import { factsFromGame } from '../src/audio/broadcast/facts';
import { estimateDuration } from '../src/audio/broadcast/text';
import { paWelcome } from '../src/audio/cues';
import { teamInfo } from '../src/engine/realSimAdapter';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const openingOnly = process.argv.includes('--opening');
const seed = Number(args[0] ?? 12);
const level = (args[1] ?? 'normal') as Level;
const innings = Number(args[2] ?? 3);
const tempo = (args[3] ?? 'broadcast') as 'quick' | 'standard' | 'broadcast';
const tod = (args[4] ?? 'night') as 'day' | 'dusk' | 'night';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g: any = createGame({ seed, innings, tempo } as never);
const booth = new Booth({ rng: mulberry32(seed * 7 + 1), level });
const teams = g.getTeams();
const facts = factsFromGame(g, String(seed), tod, false, (side) => teamInfo({ name: teams[side].name, abbrev: teams[side].abbrev }, side === 'home' ? 1 : 0));
const welcome = paWelcome({ teams: { home: teams.home.name, away: teams.away.name }, venue: facts?.venue?.name, tod });
booth.setFacts(facts, 0.5 + estimateDuration(welcome, 0.92) + 0.8);
const pending: { ev: { type: string } & Record<string, unknown>; t: number }[] = [];
let t = 0;
g.on('*', (ev: never) => pending.push({ ev, t }));
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
let lastPlay = '';
let phaseNull = false;
let rs = g.getState();
const lines: string[] = [];
let lastEnd = 0;
const stats = { pxp: 0, color: 0, words: 0, must: 0, should: 0, could: 0, cuts: 0 };
let firstPitch = -1;
let fieldUntil = 0; // the PA / umpire speaking (browser voices: the booth waits)
while (!rs.gameOver && t < 3600 && !(openingOnly && firstPitch >= 0)) {
  g.step(1 / 120);
  t += 1 / 120;
  if (Math.round(t * 120) % 6 !== 0) continue; // 20 Hz
  rs = g.getState();
  const c = ctxFromRaw(rs, { lastPlay, crowd: 0.4 });
  for (const { ev } of pending.splice(0)) {
    if (ev.type === 'gameStart') {
      lines.push(`${fmt(t + 0.5)} PA      ${welcome}`);
      fieldUntil = t + 0.5 + estimateDuration(welcome, 0.92);
    }
    if (ev.type === 'breakStart') lines.push(`${fmt(t)} ---     ${ev.pregame ? 'pregame' : 'break'} ${Number(ev.sec).toFixed(1)} s`);
    if (ev.type === 'umpireCall' && ev.kind === 'play_ball') lines.push(`${fmt(t)} UMP     Play ball!`);
    if (ev.type === 'batterUp' && openingOnly) lines.push(`${fmt(t)} PA      Now batting ... ${rs.batter?.info?.name ?? ''}`);
    if (ev.type === 'pitchReleased' && firstPitch < 0) {
      firstPitch = t;
      lines.push(`${fmt(t)} ---     first pitch`);
    }
    if (ev.type === 'playEnd') lastPlay = String(ev.description ?? '');
    if (ev.type === 'windup' || ev.type === 'contact') phaseNull = true;
    if (ev.type === 'plateAppearanceEnd' || ev.type === 'call' || ev.type === 'halfInningEnd' || ev.type === 'batterUp') phaseNull = false;
    booth.observe(ev as never, c, t);
  }
  booth.canTalk = !phaseNull;
  for (const a of booth.tick(t, c, { suppressed: false, fieldHold: t < fieldUntil })) {
    if (a.type === 'cut') {
      stats.cuts++;
      lines.push(`${fmt(a.at)}   ✂ ${a.voice} cut (${a.reason})`);
      continue;
    }
    const text = a.clauses.map((x) => (x.fold ? `(${x.text})` : x.text)).join(' ');
    const gap = a.at - lastEnd;
    stats[a.voice]++;
    stats[a.item.importance]++;
    stats.words += text.split(/\s+/).length;
    lastEnd = Math.max(lastEnd, a.at + a.est);
    lines.push(`${fmt(a.at)} ${a.voice === 'pxp' ? 'PXP  ' : 'COLOR'} ${a.item.excited ? '!' : ' '} ${text}   [${a.item.importance}${a.item.tag ? ' ' + a.item.tag : ''}${gap > 0 ? ` gap ${gap.toFixed(1)}s` : ' overlap'}]`);
  }
}
console.log(lines.join('\n'));
console.log(`\n${fmt(t)} game time, ${stats.pxp + stats.color} utterances (${stats.pxp} pxp, ${stats.color} colour), ${stats.words} words, must/should/could = ${stats.must}/${stats.should}/${stats.could}, cuts ${stats.cuts}`);
console.log(`one utterance per ${(t / Math.max(1, stats.pxp + stats.color)).toFixed(1)} s on average; director stats`, JSON.stringify(booth.director.stats));

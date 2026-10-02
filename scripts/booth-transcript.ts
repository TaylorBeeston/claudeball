/**
 * Plays a whole simulated game through the broadcast booth (no audio) with a fake clock and prints what the two voices would say.
 *   npx tsx scripts/booth-transcript.ts [seed=12] [level=normal] [innings=3]
 * Used to tune the wording and the pacing; the same machinery is unit-tested in src/audio/broadcast/__tests__.
 */
import { createGame } from '../src/sim/index';
import { Booth } from '../src/audio/broadcast/booth';
import { ctxFromRaw } from '../src/audio/broadcast/ctx';
import { mulberry32 } from '../src/audio/dsp';
import type { Level } from '../src/audio/broadcast/director';

const seed = Number(process.argv[2] ?? 12);
const level = (process.argv[3] ?? 'normal') as Level;
const innings = Number(process.argv[4] ?? 3);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g: any = createGame({ seed, innings } as never);
const booth = new Booth({ rng: mulberry32(seed * 7 + 1), level });
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
while (!rs.gameOver && t < 3600) {
  g.step(1 / 120);
  t += 1 / 120;
  if (Math.round(t * 120) % 6 !== 0) continue; // 20 Hz
  rs = g.getState();
  const c = ctxFromRaw(rs, { lastPlay, crowd: 0.4 });
  for (const { ev } of pending.splice(0)) {
    if (ev.type === 'playEnd') lastPlay = String(ev.description ?? '');
    if (ev.type === 'windup' || ev.type === 'contact') phaseNull = true;
    if (ev.type === 'plateAppearanceEnd' || ev.type === 'call' || ev.type === 'halfInningEnd' || ev.type === 'batterUp') phaseNull = false;
    booth.observe(ev as never, c, t);
  }
  booth.canTalk = !phaseNull;
  for (const a of booth.tick(t, c, { suppressed: false })) {
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

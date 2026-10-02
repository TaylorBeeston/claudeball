/**
 * Samples 30 game situations from a simulated game for the tiny-LM evaluation: a compact facts object (what a prompt would carry) plus what
 * the template grammar says for the same moment. Output: JSON on stdout.   npx tsx scripts/lm/contexts.ts [seed=12]
 */
import { createGame } from '../../src/sim/index';
import { ctxFromRaw } from '../../src/audio/broadcast/ctx';
import { Booth } from '../../src/audio/broadcast/booth';
import { mulberry32 } from '../../src/audio/dsp';
import { lastNameOf } from '../../src/audio/broadcast/ctx';
import { factsFor } from '../../src/audio/broadcast/lm';

const seed = Number(process.argv[2] ?? 12);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g: any = createGame({ seed, innings: 9 } as never);
const booth = new Booth({ rng: mulberry32(5), level: 'high' });
const pending: { type: string }[] = [];
g.on('*', (e: never) => pending.push(e));
let t = 0;
const recent: string[] = [];
const samples: unknown[] = [];
let sinceSample = 0;
let rs = g.getState();
while (!rs.gameOver && t < 3000 && samples.length < 30) {
  g.step(1 / 120);
  t += 1 / 120;
  if (Math.round(t * 120) % 6 !== 0) continue;
  rs = g.getState();
  const c = ctxFromRaw(rs, { crowd: 0.4 });
  for (const ev of pending.splice(0)) booth.observe(ev as never, c, t);
  booth.canTalk = true;
  const acts = booth.tick(t, c, { suppressed: false });
  for (const a of acts) if (a.type === 'start') {
    recent.push(a.clauses.map((x) => x.text).join(' '));
    if (recent.length > 6) recent.shift();
    if (a.item.tag && !['ball', 'strike.called', 'strike.swinging', 'strike.foul', 'strike.foul.two'].includes(a.item.tag)) sinceSample++;
    if (a.item.importance === 'could' && a.voice === 'color' && sinceSample >= 4 && samples.length < 30) {
      sinceSample = 0;
      samples.push({ facts: factsFor(c, booth.log, recent.slice(0, -1)), grammar: a.item.text, tag: a.item.tag });
    }
  }
}
console.log(JSON.stringify(samples, null, 1));
void lastNameOf;

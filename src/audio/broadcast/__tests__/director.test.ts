import { describe, expect, it } from 'vitest';
import { Director, type Action, type Item, type Level, type StartAction, type Topic } from '../director';
import { mulberry32 } from '../../dsp';
import { clauses, clauseEnds, estimateDuration } from '../text';

function rig(level: Level = 'normal', seed = 1, topicSource?: (t: number) => Topic | null) {
  const d = new Director({ rng: mulberry32(seed), level, topicSource });
  const log: (Action & { t: number })[] = [];
  let t = 0;
  const run = (secs: number, step = 0.05) => {
    const end = t + secs;
    while (t < end - 1e-9) {
      t = Math.round((t + step) * 1000) / 1000;
      for (const a of d.tick(t)) log.push({ ...a, t });
    }
  };
  const submit = (o: Partial<Item> & { text: string; importance: Item['importance'] }) => d.submit({ speaker: 'pxp', ttl: 5, ...o }, t);
  const starts = () => log.filter((a): a is StartAction & { t: number } => a.type === 'start');
  return { d, log, run, submit, starts, now: () => t };
}
const say = (r: ReturnType<typeof rig>, text: string) => r.starts().find((s) => s.clauses.some((c) => c.text.includes(text)));

describe('text helpers', () => {
  it('splits into clauses and estimates time', () => {
    expect(clauses('Ground ball to short, he throws... in time! One away.')).toEqual(['Ground ball to short,', 'he throws...', 'in time!', 'One away.']);
    const e = clauseEnds('Ground ball to short, one away.');
    expect(e).toHaveLength(2);
    expect(e[1]).toBeGreaterThan(e[0]);
    expect(estimateDuration('Strike!')).toBeLessThan(estimateDuration('A much longer line with many more words in it, really.'));
  });
});

describe('SHOULD: calls are never said over a line in progress', () => {
  it('a ball call that arrives during a colour line does not interrupt it, and the count is folded into the next line', () => {
    const r = rig();
    // a long colour line is running; the play-by-play voice is free but one person talks at a time
    r.submit({ importance: 'could', speaker: 'color', text: 'He has been mixing his changeup in all night, and that has kept the hitters off the fastball completely.' });
    r.run(1);
    expect(r.d.voices.color.item).toBeTruthy();
    r.submit({ importance: 'should', text: 'Fastball, low and away.', fold: { key: 'count', epoch: 1, render: () => 'That makes it two and one.' } });
    r.run(0.3);
    r.submit({ importance: 'should', text: 'Called strike two.', fold: { key: 'count', epoch: 1, render: () => 'And that is strike two.' } });
    r.run(0.5);
    // nothing was said over the colour line and nobody was cut
    expect(r.log.filter((a) => a.type === 'cut')).toHaveLength(0);
    expect(say(r, 'Called strike two')).toBeUndefined();
    expect(say(r, 'Fastball, low')).toBeUndefined();
    expect(r.d.voices.color.item?.text).toContain('changeup');
    // after the colour line, a batted-ball call (foldable) carries the newest missed count in front of it
    r.run(12);
    r.submit({ importance: 'should', text: 'Fly ball to left field...', foldable: true });
    r.run(2);
    const call = say(r, 'Fly ball')!;
    expect(call).toBeTruthy();
    expect(call.clauses[0]).toEqual({ text: 'And that is strike two.', fold: true });
    expect(r.d.stats.foldedIn).toBe(1);
  });

  it('is said when a voice is free within about 0.7 s', () => {
    const r = rig();
    r.submit({ importance: 'should', text: 'Strike one.' });
    r.run(1);
    expect(say(r, 'Strike one')!.t).toBeLessThanOrEqual(1);
  });

  it('a SHOULD with nothing to fold is dropped when it cannot be said in time', () => {
    const r = rig();
    r.submit({ importance: 'must', text: 'Base hit to right field and the runner will hold at first, a long line to keep the voice busy.' });
    r.run(0.1);
    r.submit({ importance: 'should', text: 'Ball one.' });
    r.run(8);
    expect(say(r, 'Ball one')).toBeUndefined();
    expect(r.d.stats.shouldDropped).toBe(1);
  });

  it('a newer count replaces an older unspoken one', () => {
    const r = rig();
    r.submit({ importance: 'must', text: 'Deep drive to left field, and it is... caught at the wall, what a play by the left fielder there.' });
    r.run(0.1);
    r.submit({ importance: 'should', text: 'Ball one.', fold: { key: 'count', epoch: 1, render: () => 'One and oh.' } });
    r.run(0.1);
    r.submit({ importance: 'should', text: 'Ball two.', fold: { key: 'count', epoch: 1, render: () => 'Two and oh.' } });
    r.run(10);
    r.submit({ importance: 'must', foldable: true, text: 'Strikes him out.' });
    r.run(2);
    const m = say(r, 'Strikes him out')!;
    expect(m.clauses.filter((c) => c.fold).map((c) => c.text)).toEqual(['Two and oh.']);
  });

  it('a fold that is no longer current is not spoken', () => {
    const r = rig();
    r.submit({ importance: 'must', text: 'Long line to keep the voice busy for a while with many words in it here and there.' });
    r.run(0.1);
    r.submit({ importance: 'should', text: 'Ball two.', fold: { key: 'count', epoch: 1, render: () => null } });
    r.run(10);
    r.submit({ importance: 'must', foldable: true, text: 'Strikes him out.' });
    r.run(2);
    expect(say(r, 'Strikes him out')!.clauses).toHaveLength(1);
    expect(r.d.stats.foldDropped).toBe(1);
  });
});

describe('MUST', () => {
  const FILLER = 'He is a hitter who has really started to see the ball well over the last few weeks, and you can tell it in the way he waits back, stays on the ball, and lets it travel.';

  it('a home run cuts filler at the next clause', () => {
    const r = rig();
    r.submit({ importance: 'could', speaker: 'pxp', text: FILLER });
    r.run(1.0);
    expect(r.d.voices.pxp.item?.text).toBe(FILLER);
    r.submit({ importance: 'must', text: 'Deep drive to left... gone! Home run!', excited: true });
    r.run(3);
    const cut = r.log.find((a) => a.type === 'cut')!;
    expect(cut).toBeTruthy();
    expect(cut.reason).toBe('must');
    const clauseTimes = clauseEnds(FILLER).map((e) => e); // relative to the start of the filler (started near 0)
    // cut happens at (about) a clause boundary, no later than 1.5 s after the home run call
    expect(cut.t).toBeLessThanOrEqual(1.0 + 1.55);
    const start = say(r, 'Home run')!;
    expect(start.t).toBeGreaterThan(cut.at);
    expect(start.t - cut.at).toBeLessThan(0.4);
    void clauseTimes;
  });

  it('lets a line finish when it has less than 1.2 s left', () => {
    const r = rig();
    r.submit({ importance: 'could', speaker: 'pxp', text: 'He has had a really nice night so far.' });
    r.run(0.1);
    const end = r.d.voices.pxp.end;
    r.run(end - 0.6 - r.now()); // 0.6 s left
    r.submit({ importance: 'must', text: 'Base hit!' });
    r.run(2);
    expect(r.log.filter((a) => a.type === 'cut')).toHaveLength(0);
    expect(say(r, 'Base hit')!.t).toBeGreaterThanOrEqual(end);
  });

  it('never cuts another MUST: it waits for it', () => {
    const r = rig();
    r.submit({ importance: 'must', text: 'Fly ball to left field, he drifts back, back, to the track, and he makes the catch at the wall.' });
    r.run(0.5);
    r.submit({ importance: 'must', text: 'That is the third out.' });
    r.run(14);
    expect(r.log.filter((a) => a.type === 'cut')).toHaveLength(0);
    const first = say(r, 'Fly ball')!;
    const second = say(r, 'third out')!;
    expect(second.t).toBeGreaterThanOrEqual(first.t + first.est - 0.01);
    expect(second.t - (first.t + first.est)).toBeLessThan(0.5);
  });

  it('MUSTs are said in order and none is dropped, however late', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.submit({ importance: 'must', text: `Play number ${i} is a long enough line to take a while to say.`, ttl: 0.1 });
    r.run(40);
    expect(r.starts().map((s) => s.item.text.match(/number (\d)/)![1])).toEqual(['0', '1', '2', '3', '4']);
  });

  it('cuts a running SHOULD line too', () => {
    const r = rig();
    r.submit({ importance: 'should', text: 'Fastball, ninety-four miles an hour, down and away, the catcher barely moved his glove at all.' });
    r.run(0.5);
    r.submit({ importance: 'must', text: 'Strike three called!' });
    r.run(3);
    expect(r.log.some((a) => a.type === 'cut')).toBe(true);
    expect(say(r, 'Strike three')).toBeTruthy();
  });
});

describe('one person talks at a time', () => {
  it('a SHOULD is not said over the colour voice, and a MUST makes the colour voice yield at a clause', () => {
    const r = rig();
    r.submit({ importance: 'could', speaker: 'color', text: 'It is a long colour comment, with several clauses, that keeps going for a good while yet.' });
    r.run(0.5);
    r.submit({ importance: 'must', text: 'Swing and a miss! Strike three!', excited: true });
    r.run(3);
    const cut = r.log.find((a) => a.type === 'cut')!;
    expect(cut.voice).toBe('color');
    const must = say(r, 'Strike three')!;
    expect(must.t).toBeGreaterThanOrEqual(cut.at);
    expect(must.t - cut.at).toBeLessThan(0.5);
  });
});

describe('conversation', () => {
  const topic = (id: number, turns: Topic['turns']): Topic => ({ id, tag: `t${id}`, turns });
  const TURNS: Topic['turns'] = [
    { speaker: 'color', text: 'I like how he is using the changeup there, it keeps the hitter honest.' },
    { speaker: 'pxp', text: 'It is the first one he has shown tonight.' },
    { speaker: 'color', text: 'Right, and that tells you something.', interject: false },
  ];

  it('plays the turns in order with a 0.2-0.6 s beat between them, then breathes', () => {
    let given = 0;
    const r = rig('normal', 3, () => (given++ === 0 ? topic(1, TURNS) : null));
    r.run(30);
    const s = r.starts();
    expect(s.map((x) => x.voice)).toEqual(['color', 'pxp', 'color']);
    for (let i = 1; i < s.length; i++) {
      const gap = s[i].t - (s[i - 1].t + s[i - 1].est);
      expect(gap).toBeGreaterThanOrEqual(0.15);
      expect(gap).toBeLessThanOrEqual(0.75);
    }
  });

  it('breathes between topics (at least the minimum for the level)', () => {
    let n = 0;
    const r = rig('normal', 4, () => topic(++n, [{ speaker: 'color', text: `Topic ${n} line one.` }]));
    r.run(60);
    const s = r.starts();
    expect(s.length).toBeGreaterThan(3);
    for (let i = 1; i < s.length; i++) expect(s[i].t - (s[i - 1].t + s[i - 1].est)).toBeGreaterThanOrEqual(3.9);
    // High talks more than Normal
    let m = 0;
    const hi = rig('high', 4, () => topic(++m, [{ speaker: 'color', text: `Topic ${m} line one.` }]));
    hi.run(60);
    expect(hi.starts().length).toBeGreaterThan(s.length);
  });

  it('chatter Low: only calls, no topics', () => {
    const r = rig('low', 5, () => topic(1, TURNS));
    r.submit({ importance: 'could', speaker: 'color', text: 'Some filler.' });
    r.run(60);
    expect(r.starts()).toHaveLength(0);
    r.submit({ importance: 'must', text: 'Strike three called!' });
    r.run(3);
    expect(r.starts()).toHaveLength(1);
  });

  it('a MUST preempts a topic: its remaining turns are dropped', () => {
    const r = rig('normal', 6, (() => { let g = 0; return () => (g++ === 0 ? topic(7, TURNS) : null); })());
    r.run(2);
    expect(r.starts().length).toBeGreaterThanOrEqual(1);
    r.submit({ importance: 'must', text: 'Deep drive to left... gone! Home run!', excited: true });
    r.run(40);
    const texts = r.starts().map((x) => x.item.text);
    expect(texts.some((x) => x.includes('Home run'))).toBe(true);
    expect(texts.filter((x) => x.startsWith('It is the first one')).length).toBe(0); // turn 2 never came
    expect(r.d.stats.topicsAborted).toBe(1);
  });

  it('a short interjection may start over the last 0.4 s of the other voice', () => {
    const r = rig();
    r.submit({ importance: 'could', speaker: 'pxp', text: 'He drives that one deep to the gap in right center field.' });
    r.run(0.1);
    const end = r.d.voices.pxp.end;
    r.submit({ importance: 'could', speaker: 'color', text: 'Ooh!', interject: true });
    r.run(end - r.now() + 0.5);
    const oh = say(r, 'Ooh')!;
    expect(oh.t).toBeLessThan(end);
    expect(oh.t).toBeGreaterThanOrEqual(end - 0.45);
    expect(r.d.voices.color.lastEnd).toBeDefined();
  });

  it('interjections never start earlier than 0.4 s before the end', () => {
    const r = rig();
    r.submit({ importance: 'could', speaker: 'pxp', text: 'A long line of play by play with a good number of words in it to say.' });
    r.run(0.1);
    r.submit({ importance: 'could', speaker: 'color', text: 'Wow!', interject: true });
    r.run(1);
    expect(say(r, 'Wow')).toBeUndefined();
  });
});

describe('suppression (2x and above, fast-forward)', () => {
  it('produces no output at all and silences running lines', () => {
    const r = rig();
    r.submit({ importance: 'could', speaker: 'pxp', text: 'A line that is running right now with plenty of words in it.' });
    r.run(0.5);
    const acts = r.d.setSuppressed(true, r.now());
    expect(acts.some((a) => a.type === 'cut')).toBe(true);
    const n = r.log.length;
    r.submit({ importance: 'must', text: 'Home run!' });
    r.run(10);
    expect(r.log.length).toBe(n);
    r.d.setSuppressed(false, r.now());
    r.submit({ importance: 'must', text: 'Strike three called!' });
    r.run(2);
    expect(say(r, 'Strike three')).toBeTruthy();
  });
});

describe('determinism', () => {
  it('same seed, same schedule', () => {
    const go = () => {
      let n = 0;
      const r = rig('normal', 9, () => ({ id: ++n, tag: 'x', turns: [{ speaker: n % 2 ? 'pxp' : 'color', text: `Line ${n} of the conversation goes here.` }] as Topic['turns'] }));
      r.submit({ importance: 'should', text: 'Strike one.' });
      r.run(40);
      return r.starts().map((s) => `${s.voice}@${s.t.toFixed(2)}:${s.item.text}`);
    };
    expect(go()).toEqual(go());
  });
});

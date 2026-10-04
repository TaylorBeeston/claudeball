import { describe, expect, it } from 'vitest';
import { CaptionModel, DEFAULT_TIMING, SIZE_SCALE, captionKind, captioned, normalizeSpeech } from '../captionModel';
import { DEFAULT_SETTINGS, STORAGE_KEY, loadSaved, parseParams, resolve, saveSettings, shareQuery } from '../settings';

const T = DEFAULT_TIMING;
const pbp = (id: number, text = 'Strike one on the corner.', extra = {}) => ({ id, channel: 'booth', speaker: 'play-by-play', text, ...extra });

describe('caption kinds and modes', () => {
  it('maps speakers (and channels) to kinds', () => {
    expect(captionKind({ speaker: 'play-by-play' })).toBe('pbp');
    expect(captionKind({ speaker: 'pbp' })).toBe('pbp');
    expect(captionKind({ speaker: 'Color commentator' })).toBe('color');
    expect(captionKind({ speaker: 'PA' })).toBe('pa');
    expect(captionKind({ speaker: 'umpire' })).toBe('umpire');
    expect(captionKind({ channel: 'booth' })).toBe('pbp');
    expect(captionKind({ channel: 'pa' })).toBe('pa');
    expect(captionKind({ speaker: 'crowd guy' })).toBe('other');
  });

  it('off captions nothing, booth the two booth voices, all everything', () => {
    for (const k of ['pbp', 'color', 'pa', 'umpire', 'other'] as const) expect(captioned(k, 'off')).toBe(false);
    expect(['pbp', 'color', 'pa', 'umpire'].map((k) => captioned(k as never, 'booth'))).toEqual([true, true, false, false]);
    expect(['pbp', 'color', 'pa', 'umpire', 'other'].map((k) => captioned(k as never, 'all'))).toEqual([true, true, true, true, true]);
  });

  it('normalizes raw audio events into starts and ends, ignoring junk', () => {
    expect(normalizeSpeech({ id: 1, speaker: 'pa', text: 'Now batting', channel: 'pa', startMs: 5, expectedDurationMs: 900 })).toEqual({ kind: 'start', ev: { id: 1, speaker: 'pa', text: 'Now batting', channel: 'pa', startMs: 5, expectedDurationMs: 900 } });
    expect(normalizeSpeech({ type: 'speechEnd', id: 1, truncatedAt: 4 })).toEqual({ kind: 'end', ev: { id: 1, truncatedAt: 4 } });
    expect(normalizeSpeech({ type: 'speech_end', id: 'a' })).toEqual({ kind: 'end', ev: { id: 'a', truncatedAt: undefined } });
    expect(normalizeSpeech({ id: 2, truncatedAt: 3 })?.kind).toBe('end');
    expect(normalizeSpeech(null)).toBeNull();
    expect(normalizeSpeech({ text: 'no id' })).toBeNull();
    expect(normalizeSpeech({ id: 3 })).toBeNull();
  });
});

describe('caption queue', () => {
  it('shows a line when the voice starts and not for filtered voices or empty text', () => {
    const m = new CaptionModel('booth', 2);
    expect(m.start({ id: 1, speaker: 'pa', text: 'Now batting' }, 0)).toBe(false);
    expect(m.start(pbp(2, '   '), 0)).toBe(false);
    expect(m.start(pbp(3), 100)).toBe(true);
    expect(m.lines()).toMatchObject([{ id: 3, kind: 'pbp', label: 'PLAY-BY-PLAY', text: 'Strike one on the corner.', phase: 'on' }]);
    const off = new CaptionModel('off', 2);
    expect(off.start(pbp(1), 0)).toBe(false);
    expect(off.lines()).toEqual([]);
  });

  it('keeps a line until shortly after its voice ends, then fades and removes it', () => {
    const m = new CaptionModel('all', 2);
    m.start(pbp(1, 'Hello there.', { expectedDurationMs: 2000 }), 0);
    m.end({ id: 1 }, 2000);
    expect(m.next()).toBe(2000 + T.lingerMs);
    expect(m.advance(2000 + T.lingerMs - 1)).toBe(false);
    expect(m.advance(2000 + T.lingerMs)).toBe(true);
    expect(m.lines()[0].phase).toBe('out');
    expect(m.next()).toBe(2000 + T.lingerMs + T.fadeMs);
    expect(m.advance(2000 + T.lingerMs + T.fadeMs)).toBe(true);
    expect(m.lines()).toEqual([]);
    expect(m.next()).toBeNull();
  });

  it('never removes a line before the minimum show time, even when the voice ends at once', () => {
    const m = new CaptionModel('all', 2);
    m.start(pbp(1, 'Ball.'), 1000);
    m.end({ id: 1 }, 1010);
    expect(m.next()).toBe(1000 + T.minShowMs);
  });

  it('falls back to the expected duration plus a grace when no end event arrives', () => {
    const m = new CaptionModel('all', 2);
    m.start(pbp(1, 'x'.repeat(100), { expectedDurationMs: 3000 }), 0);
    expect(m.next()).toBe(3000 + T.graceMs);
    const n = new CaptionModel('all', 2);
    n.start(pbp(1, 'Hi.'), 0); // no expected duration: floor
    expect(n.next()).toBe(T.minExpectedMs + T.graceMs);
  });

  it('truncates a cut-off line and clears it sooner; an index past the end is not a cut', () => {
    const m = new CaptionModel('all', 2);
    m.start(pbp(1, 'That ball is hit deep to left field'), 0);
    expect(m.end({ id: 1, truncatedAt: 13 }, 1500)).toBe(true);
    expect(m.lines()[0]).toMatchObject({ text: 'That ball is…', truncated: true });
    expect(m.next()).toBe(1500 + T.lingerCutMs);
    const k = new CaptionModel('all', 2);
    k.start(pbp(1, 'Short.'), 0);
    expect(k.end({ id: 1, truncatedAt: 999 }, 500)).toBe(false);
    expect(k.lines()[0].text).toBe('Short.');
    expect(k.end({ id: 42 }, 500)).toBe(false); // unknown id
  });

  it('limits how many lines show at once: the oldest fades first', () => {
    const m = new CaptionModel('all', 2);
    m.start(pbp(1, 'one'), 0);
    m.start({ id: 2, speaker: 'pa', text: 'two' }, 10);
    m.start(pbp(3, 'three'), 20);
    expect(m.lines().map((l) => [l.id, l.phase])).toEqual([[1, 'out'], [2, 'on'], [3, 'on']]);
    m.advance(20 + T.fadeMs);
    expect(m.lines().map((l) => l.id)).toEqual([2, 3]);
    // a phone shows one
    expect(m.setMaxLines(1, 400)).toBe(true);
    expect(m.lines().find((l) => l.id === 2)!.phase).toBe('out');
  });

  it('restarting the same id updates the line; switching the mode drops lines that are no longer captioned', () => {
    const m = new CaptionModel('all', 2);
    m.start(pbp(1, 'first'), 0);
    m.start(pbp(1, 'second'), 100);
    expect(m.lines()).toMatchObject([{ id: 1, text: 'second', phase: 'on' }]);
    m.start({ id: 2, speaker: 'umpire', text: 'Strike!' }, 120);
    expect(m.setMode('booth')).toBe(true);
    expect(m.lines().map((l) => l.id)).toEqual([1]);
    expect(m.setMode('booth')).toBe(false);
    expect(m.clear()).toBe(true);
    expect(m.clear()).toBe(false);
  });

  it('size settings scale the font monotonically', () => {
    expect(SIZE_SCALE.S).toBeLessThan(SIZE_SCALE.M);
    expect(SIZE_SCALE.M).toBe(1);
    expect(SIZE_SCALE.L).toBeLessThan(SIZE_SCALE.XL);
  });
});

describe('subtitle settings', () => {
  const mem = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  it('default to off, translucent, M, labels on, bottom', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ subtitles: 'off', subtitleSize: 'M', subtitleBg: 'translucent', subtitleLabels: true, subtitlePos: 'bottom' });
  });
  it('persist and drop invalid saved values', () => {
    const st = mem();
    saveSettings(st, { ...DEFAULT_SETTINGS, subtitles: 'booth', subtitleSize: 'XL', subtitleBg: 'solid', subtitleLabels: false, subtitlePos: 'top' });
    expect(loadSaved(st)).toMatchObject({ subtitles: 'booth', subtitleSize: 'XL', subtitleBg: 'solid', subtitleLabels: false, subtitlePos: 'top' });
    st.setItem(STORAGE_KEY, JSON.stringify({ subtitles: 'maybe', subtitleSize: 'XXL', subtitleBg: 'glass', subtitleLabels: 'yes', subtitlePos: 'left' }));
    expect(loadSaved(st)).toEqual({});
  });
  it('?subtitles= parses (off / booth / all, 1 and on mean all), beats saved, invalid ignored', () => {
    expect(parseParams('?subtitles=booth').settings).toEqual({ subtitles: 'booth' });
    expect(parseParams('?subtitles=ALL').settings.subtitles).toBe('all');
    expect(parseParams('?subtitles=1').settings.subtitles).toBe('all');
    expect(parseParams('?subtitles=on').settings.subtitles).toBe('all');
    expect(parseParams('?subtitles=0').settings.subtitles).toBe('off');
    expect(parseParams('?subtitles=loud').settings).toEqual({});
    expect(parseParams('?subtitles=loud').fromUrl.size).toBe(0);
    expect(parseParams('?subtitles=booth&subtitlesize=xl').settings).toEqual({ subtitles: 'booth', subtitleSize: 'XL' });
    expect(resolve('?subtitles=all', mem({ [STORAGE_KEY]: JSON.stringify({ subtitles: 'booth' }) }), false).settings.subtitles).toBe('all');
    expect(resolve('', null, true).settings.subtitles).toBe('off');
    expect(shareQuery({ seed: 1, away: -1, home: -1 }, { ...DEFAULT_SETTINGS, subtitles: 'all' })).toBe('seed=1'); // subtitles are a personal setting, not part of a game link
  });
});

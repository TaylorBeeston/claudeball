import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicDirector, type MusicCtx, type MusicDecision } from '../director';
import { ParkMusic, type MusicBackend } from '../player';
import { TRIGGERS, buildManifest, parseFileName, parseManifest, pickTrack, type TrackInfo, type Trigger } from '../manifest';
import { mulberry32 } from '../../dsp';

const trk = (trigger: Trigger, n: number, over: Partial<TrackInfo> = {}): TrackInfo => ({ id: `${trigger}-${n}`, file: `${trigger}-${n}.ogg`, trigger, weight: 1, durationMs: (TRIGGERS[trigger].dur[0] + 1) * 1000, loop: TRIGGERS[trigger].loop, gain: 1, ...over });
const ALL: TrackInfo[] = (Object.keys(TRIGGERS) as Trigger[]).flatMap((t) => [1, 2, 3].map((n) => trk(t, n)));
const ctx = (o: Partial<MusicCtx> = {}): MusicCtx => ({ inning: 4, half: 'bottom', score: { home: 1, away: 1 }, ...o });
const plays = (d: MusicDecision[]) => d.filter((x): x is Extract<MusicDecision, { kind: 'play' }> => x.kind === 'play');
const stops = (d: MusicDecision[]) => d.filter((x) => x.kind === 'stop');
const mk = (tracks = ALL, seed = 1) => new MusicDirector({ rng: mulberry32(seed), tracks: () => tracks });

describe('park music files and manifest', () => {
  it('reads <trigger>-<n>.ogg names and rejects the rest', () => {
    expect(parseFileName('homeRun-2.ogg')).toEqual({ trigger: 'homeRun', n: 2, ext: 'ogg' });
    expect(parseFileName('inningBreak-12.mp3')).toMatchObject({ trigger: 'inningBreak', n: 12 });
    expect(parseFileName('homerun-1.ogg')).toBeNull();
    expect(parseFileName('walkUp.ogg')).toBeNull();
    expect(parseFileName('notATrigger-1.ogg')).toBeNull();
  });

  it('a manifest from the network is validated: bad entries, duplicates and paths outside the folder are dropped, never thrown on', () => {
    expect(parseManifest(null).tracks).toEqual([]);
    expect(parseManifest({ tracks: 'nope' }).tracks).toEqual([]);
    const m = parseManifest({
      tracks: [
        { file: 'homeRun-1.ogg', trigger: 'homeRun', durationMs: 19000, gain: 9, weight: -2 },
        { file: 'homeRun-1.ogg', trigger: 'homeRun' },
        { file: '../evil.ogg', trigger: 'homeRun' },
        { file: 'https://evil.example/x.ogg', trigger: 'homeRun' },
        { file: 'x-1.ogg', trigger: 'nothing' },
        { trigger: 'walkUp' },
        { file: 'inningBreak-1.ogg', trigger: 'inningBreak', durationMs: 70000 },
      ],
    });
    expect(m.tracks.map((t) => t.id)).toEqual(['homeRun-1', 'inningBreak-1']);
    expect(m.tracks[0].gain).toBe(2); // clamped
    expect(m.tracks[0].weight).toBeGreaterThan(0);
    expect(m.tracks[1].loop).toBe(true); // from the trigger
  });

  it('picks variants by weight and does not repeat the last ones while there are others', () => {
    const t = [trk('walkUp', 1), trk('walkUp', 2), trk('walkUp', 3)];
    const rng = mulberry32(3);
    const seq: string[] = [];
    for (let i = 0; i < 12; i++) {
      const p = pickTrack(t, 'walkUp', rng, seq.slice(-2))!;
      expect(seq.slice(-2)).not.toContain(p.id);
      seq.push(p.id);
    }
    expect(pickTrack(t, 'homeRun', rng)).toBeNull();
    expect(pickTrack([trk('homeRun', 1)], 'homeRun', rng, ['homeRun-1'])!.id).toBe('homeRun-1'); // the only one
    const heavy = [trk('runScored', 1, { weight: 100 }), trk('runScored', 2, { weight: 1 })];
    let first = 0;
    for (let i = 0; i < 200; i++) if (pickTrack(heavy, 'runScored', rng)!.id === 'runScored-1') first++;
    expect(first).toBeGreaterThan(170);
  });

  it('the index keeps hand-tuned gain / weight and warns about sizes, lengths, names and missing variants', () => {
    const prev = { version: 1 as const, tracks: [trk('homeRun', 1, { gain: 0.6, weight: 3 })] };
    const r = buildManifest(
      [
        { file: 'homeRun-1.ogg', bytes: 900000, durationMs: 19000, channels: 2, sampleRate: 44100 },
        { file: 'homeRun-2.ogg', bytes: 1500000, durationMs: 40000, channels: 2, sampleRate: 48000 },
        { file: 'readme.txt', bytes: 10, durationMs: 0 },
        { file: 'inningBreak-1.ogg', bytes: 1000000, durationMs: 75000, channels: 2, sampleRate: 44100 },
      ],
      prev,
    );
    expect(r.manifest.tracks.map((t) => t.id)).toEqual(['homeRun-1', 'homeRun-2', 'inningBreak-1']);
    expect(r.manifest.tracks[0]).toMatchObject({ gain: 0.6, weight: 3, durationMs: 19000 });
    const w = r.warnings.join('\n');
    expect(w).toMatch(/readme.txt: not named/);
    expect(w).toMatch(/homeRun-2.ogg: 40.0 s, wanted 15-25/);
    expect(w).toMatch(/homeRun-2.ogg: 1.43 MB, over/);
    expect(w).toMatch(/homeRun-2.ogg: 48000 Hz/);
    expect(w).toMatch(/walkUp: no track/);
    expect(w).toMatch(/homeRun: 2 of 3 wanted variants/);
    const big = buildManifest(Array.from({ length: 15 }, (_, i) => ({ file: `walkUp-${i + 1}.ogg`, bytes: 1100000, durationMs: 15000 })));
    expect(big.warnings.join('\n')).toMatch(/total .* MB, over the 14 MB/);
  });
});

describe('park music director', () => {
  it('a home run, a run and the like get music only for the home team; the visitors get silence', () => {
    const d = mk();
    expect(plays(d.observe({ type: 'homeRun' }, ctx({ half: 'top' }), 10))).toHaveLength(0);
    expect(plays(d.observe({ type: 'runScored', team: 'away' }, ctx({ half: 'top' }), 12))).toHaveLength(0);
    const hr = plays(d.observe({ type: 'homeRun' }, ctx(), 20))[0];
    expect(hr.trigger).toBe('homeRun');
    expect(hr.track?.trigger).toBe('homeRun');
    expect(hr.delayMs).toBeGreaterThan(0); // after the crowd's first reaction
  });

  it('priority: a home run is not cut by a run, a run is cut by a home run, nothing overlaps (the old track fades out first)', () => {
    const d = mk();
    plays(d.observe({ type: 'homeRun' }, ctx(), 10));
    expect(d.observe({ type: 'runScored', team: 'home' }, ctx(), 12)).toEqual([]); // the home run plays on
    const e = mk();
    const first = plays(e.observe({ type: 'runScored', team: 'home' }, ctx(), 10))[0];
    expect(first.trigger).toBe('runScored');
    const next = e.observe({ type: 'homeRun' }, ctx(), 11);
    expect(next[0]).toMatchObject({ kind: 'stop' });
    expect(plays(next)[0].delayMs).toBeGreaterThanOrEqual((next[0] as { fadeMs: number }).fadeMs); // starts after the fade
    // a walk-up never cuts a run stinger
    const f = mk();
    plays(f.observe({ type: 'runScored', team: 'home' }, ctx(), 10));
    expect(plays(f.observe({ type: 'batterUp' }, ctx(), 12))).toHaveLength(0);
  });

  it('cooldowns: a run stinger is not repeated within 10 s, a home run within 20 s', () => {
    const d = mk();
    expect(plays(d.observe({ type: 'runScored', team: 'home' }, ctx(), 10))).toHaveLength(1);
    d.ended(18);
    expect(plays(d.observe({ type: 'runScored', team: 'home' }, ctx({ inning: 5 }), 15))).toHaveLength(0);
    expect(plays(d.observe({ type: 'runScored', team: 'home' }, ctx({ inning: 6 }), 25))).toHaveLength(1);
  });

  it('two runs in a half inning (or a big hit with runners on) start a rally once per half inning', () => {
    const d = mk();
    const r1 = plays(d.observe({ type: 'runScored', team: 'home' }, ctx({ inning: 6 }), 100));
    expect(r1[0].trigger).toBe('runScored');
    d.ended(108);
    const r2 = plays(d.observe({ type: 'runScored', team: 'home' }, ctx({ inning: 6 }), 112));
    expect(r2[0].trigger).toBe('rally');
    d.ended(135);
    expect(plays(d.observe({ type: 'runScored', team: 'home' }, ctx({ inning: 6 }), 140))[0].trigger).toBe('runScored'); // not a second rally
    const e = mk();
    expect(plays(e.observe({ type: 'plateAppearanceEnd', result: 'double' }, ctx(), 10))[0].trigger).toBe('rally');
    expect(plays(e.observe({ type: 'plateAppearanceEnd', result: 'single' }, ctx({ inning: 5 }), 100))).toHaveLength(0);
  });

  it('the home batter walks up to music that stops at the windup; visitors get none', () => {
    const d = mk();
    expect(plays(d.observe({ type: 'batterUp' }, ctx({ half: 'top' }), 5))).toHaveLength(0);
    expect(plays(d.observe({ type: 'batterUp' }, ctx(), 20))[0].trigger).toBe('walkUp');
    const s = d.observe({ type: 'windup' }, ctx(), 24);
    expect(s).toEqual([{ kind: 'stop', fadeMs: 900, reason: 'the pitch' }]);
    expect(d.playing).toBeNull();
  });

  it('the break plays low for its length (not under 14 s), is cut when the next batter is called, and skips the stretch', () => {
    const d = mk();
    expect(d.observe({ type: 'breakStart', inning: 3, half: 'top', sec: 9 }, ctx(), 0)).toEqual([]);
    const b = plays(d.observe({ type: 'breakStart', inning: 3, half: 'bottom', sec: 40 }, ctx(), 10))[0];
    expect(b.trigger).toBe('inningBreak');
    expect(b.maxMs).toBeLessThanOrEqual(40000);
    expect(b.fadeInMs).toBeGreaterThan(500);
    const out = d.observe({ type: 'batterUp' }, ctx(), 30);
    expect(out[0]).toEqual({ kind: 'stop', fadeMs: 1500, reason: 'the next batter is called' });
    expect(plays(out)[0].trigger).toBe('walkUp'); // the home batter, after the fade
    expect(plays(out)[0].delayMs).toBeGreaterThanOrEqual(1500);
    const s = mk();
    expect(s.observe({ type: 'breakStart', inning: 7, half: 'top', sec: 40 }, ctx({ inning: 7, half: 'top' }), 0)).toEqual([]);
    expect(s.observe({ type: 'halfInningEnd', half: 'top' }, ctx({ inning: 7, half: 'top' }), 1)).toEqual([]);
    // an engine with no break events: the half-inning end starts it
    const m = mk();
    expect(plays(m.observe({ type: 'halfInningEnd', half: 'top' }, ctx({ half: 'top' }), 0))[0].trigger).toBe('inningBreak');
    // and a break that has run its course fades out
    const t = mk();
    t.observe({ type: 'breakStart', inning: 3, half: 'bottom', sec: 30 }, ctx(), 0);
    expect(t.tick(10)).toEqual([]);
    expect(t.tick(40)).toEqual([{ kind: 'stop', fadeMs: 1500, reason: 'the break is over' }]);
  });

  it('game start, a pitching change (quieter for the visitors) and the final: the win gets a long one, the loss a short one, a tie nothing', () => {
    const d = mk();
    expect(plays(d.observe({ type: 'gameStart' }, ctx({ inning: 1, half: 'top' }), 0))[0].trigger).toBe('gameStart');
    const home = mk();
    expect(plays(home.observe({ type: 'pitchingChange' }, ctx({ half: 'top' }), 0))[0].level).toBe(1);
    const away = mk();
    expect(plays(away.observe({ type: 'pitchingChange' }, ctx({ half: 'bottom' }), 0))[0].level).toBeLessThan(1);
    expect(plays(mk().observe({ type: 'gameEnd', winner: 'home' }, ctx({ inning: 9 }), 0))[0].trigger).toBe('finalWin');
    expect(plays(mk().observe({ type: 'gameEnd', winner: 'away' }, ctx({ inning: 9 }), 0))[0].trigger).toBe('finalLoss');
    expect(plays(mk().observe({ type: 'gameEnd', winner: 'tie' }, ctx({ inning: 9 }), 0))).toHaveLength(0);
    // the final cuts anything
    const f = mk();
    plays(f.observe({ type: 'homeRun' }, ctx({ inning: 9 }), 0));
    const e = f.observe({ type: 'gameEnd', winner: 'home' }, ctx({ inning: 9 }), 5);
    expect(stops(e)).toHaveLength(1);
    expect(plays(e)[0].trigger).toBe('finalWin');
  });

  it('a walk-off run has no stinger (the final music follows); the music stops at the pitch except the opener and the final', () => {
    const d = mk();
    expect(plays(d.observe({ type: 'runScored', team: 'home', runsHome: 4, runsAway: 3 }, ctx({ inning: 9 }), 0))).toHaveLength(0);
    const e = mk();
    plays(e.observe({ type: 'gameStart' }, ctx({ inning: 1, half: 'top' }), 0));
    expect(e.observe({ type: 'windup' }, ctx(), 3)).toEqual([]);
    const f = mk();
    plays(f.observe({ type: 'homeRun' }, ctx(), 0));
    expect(stops(f.observe({ type: 'pitchReleased' }, ctx(), 8))).toHaveLength(1);
  });

  it('no files: every decision has no track (the organ plays), nothing is "covered", and the plan for the next variant is used', () => {
    const d = mk([]);
    expect(plays(d.observe({ type: 'homeRun' }, ctx(), 0))[0].track).toBeNull();
    expect(d.covered(['homeRun'], 1)).toBe(false);
    const e = mk();
    const planned = e.peek('runScored');
    expect(plays(e.observe({ type: 'runScored', team: 'home' }, ctx(), 0))[0].track).toBe(planned);
    expect(e.covered(['runScored'], 1)).toBe(true);
    expect(e.covered(['runScored'], 20)).toBe(false);
  });
});

describe('park music player', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function backend() {
    const log: string[] = [];
    const started: { url: string; o: Parameters<MusicBackend['start']>[1] }[] = [];
    const b: MusicBackend & { log: string[]; started: typeof started; ok: boolean } = {
      log,
      started,
      ok: true,
      ready: () => b.ok,
      start: (url, o) => {
        started.push({ url, o });
        log.push(`start ${url}`);
        return { stop: (f) => log.push(`stop ${f}`) };
      },
    };
    return b;
  }
  const fetcher = (body: unknown, type = 'application/json', ok = true) => vi.fn(async (_url: string) => ({ ok, headers: { get: () => type }, json: async () => body, arrayBuffer: async () => new ArrayBuffer(1) }) as unknown as Response);
  const manifest = { version: 1, tracks: ALL.map((t) => ({ ...t })) };

  async function make(over: { body?: unknown; type?: string; ok?: boolean } = {}) {
    const b = backend();
    const f = fetcher(over.body ?? manifest, over.type, over.ok);
    const fallbacks: Trigger[] = [];
    const m = new ParkMusic({ backend: b, base: '/g/audio/music/', rng: mulberry32(2), fetcher: f as unknown as typeof fetch, onFallback: (t) => fallbacks.push(t) });
    await m.load();
    return { m, b, f, fallbacks };
  }

  it('loads the manifest once, plays a decided track after its delay with the right url, and stops with a fade', async () => {
    const { m, b, f } = await make();
    expect(m.manifest.tracks.length).toBe(ALL.length);
    await m.load();
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith('manifest.json'))).toHaveLength(1);
    m.observe({ type: 'homeRun' }, ctx(), 10);
    expect(b.started).toHaveLength(0); // after the crowd's first reaction
    vi.advanceTimersByTime(1300);
    expect(b.started).toHaveLength(1);
    expect(b.started[0].url).toMatch(/^\/g\/audio\/music\/homeRun-\d\.ogg$/);
    expect(m.playingNow).toBe('homeRun');
    expect(m.active).toBe(true);
    m.observe({ type: 'windup' }, ctx(), 12);
    expect(b.log[b.log.length - 1]).toBe('stop 900');
    expect(m.active).toBe(false);
  });

  it('two callers asking for the manifest at once both get it (one fetch)', async () => {
    const b = backend();
    const f = fetcher(manifest);
    const m = new ParkMusic({ backend: b, base: '/g/', fetcher: f as unknown as typeof fetch });
    const first = m.load();
    await m.load();
    expect(m.manifest.tracks.length).toBe(ALL.length);
    await first;
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith('manifest.json'))).toHaveLength(1);
  });

  it('an event that arrives while the manifest is still on its way (the opening of a game) is decided when it lands', async () => {
    const b = backend();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async (_u: string) => {
      await gate;
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => manifest, arrayBuffer: async () => new ArrayBuffer(1) } as unknown as Response;
    });
    const m = new ParkMusic({ backend: b, base: '/g/', fetcher: f as unknown as typeof fetch, rng: mulberry32(1) });
    m.observe({ type: 'gameStart' }, ctx({ inning: 1, half: 'top' }), 0);
    expect(b.started).toHaveLength(0);
    release();
    await m.load();
    vi.advanceTimersByTime(600);
    expect(b.started).toHaveLength(1);
    expect(b.started[0].url).toMatch(/gameStart-\d\.ogg$/);
  });

  it('no manifest, a page instead of JSON, or no network: no tracks and no errors; the organ is simply not suppressed', async () => {
    for (const o of [{ type: 'text/html' }, { ok: false }, { body: { tracks: [] } }]) {
      const { m, b } = await make(o);
      m.observe({ type: 'homeRun' }, ctx(), 0);
      vi.advanceTimersByTime(3000);
      expect(b.started).toHaveLength(0);
      expect(m.covered(['homeRun'], 1)).toBe(false);
    }
  });

  it('a file that fails is never tried again and the organ stinger of that moment plays instead', async () => {
    const { m, b, fallbacks } = await make();
    m.observe({ type: 'runScored', team: 'home' }, ctx(), 10);
    vi.advanceTimersByTime(800);
    const first = b.started[0];
    first.o.onError();
    expect(fallbacks).toEqual(['runScored']);
    expect(m.stats.failed).toBe(1);
    m.observe({ type: 'runScored', team: 'home' }, ctx(), 40);
    vi.advanceTimersByTime(800);
    expect(b.started).toHaveLength(2);
    expect(b.started[1].url).not.toBe(first.url);
  });

  it('is silent while paused, skipping, fast or muted: the music stops and nothing starts; and it is not started when audio is not running', async () => {
    const { m, b } = await make();
    m.observe({ type: 'breakStart', inning: 3, half: 'bottom', sec: 40 }, ctx(), 0);
    vi.advanceTimersByTime(1000);
    expect(m.breakPlaying).toBe(true);
    m.tick(5, true); // paused
    expect(b.log[b.log.length - 1]).toBe('stop 700');
    m.observe({ type: 'homeRun' }, ctx(), 6);
    vi.advanceTimersByTime(3000);
    expect(b.started).toHaveLength(1); // nothing new while silent
    m.tick(8, false);
    const c = await make();
    c.b.ok = false;
    c.m.observe({ type: 'gameStart' }, ctx({ inning: 1, half: 'top' }), 0);
    vi.advanceTimersByTime(2000);
    expect(c.b.started).toHaveLength(0);
  });

  it('a loop is cut at the end of its break; a track that ends by itself frees the slot', async () => {
    const { m, b } = await make();
    m.observe({ type: 'breakStart', inning: 3, half: 'bottom', sec: 30 }, ctx(), 0);
    vi.advanceTimersByTime(1000);
    expect(b.started[0].o.loop).toBe(true);
    vi.advanceTimersByTime(29000); // maxMs = 28.5 s
    expect(b.log.some((l) => l === 'stop 1500')).toBe(true);
    m.observe({ type: 'runScored', team: 'home' }, ctx(), 50);
    vi.advanceTimersByTime(800);
    b.started[b.started.length - 1].o.onEnded();
    expect(m.active).toBe(false);
  });

  it('fetches only the next likely files ahead (two on a phone), and none on data saver', async () => {
    const full = await make();
    const heads = full.f.mock.calls.map((c) => String(c[0])).filter((u) => !u.endsWith('manifest.json'));
    expect(heads.length).toBeGreaterThanOrEqual(3);
    expect(heads.length).toBeLessThanOrEqual(4);
    const b = backend();
    const f = fetcher(manifest);
    const lite = new ParkMusic({ backend: b, base: '/m/', lowPower: true, fetcher: f as unknown as typeof fetch });
    await lite.load();
    expect(f.mock.calls.filter((c) => !String(c[0]).endsWith('manifest.json')).length).toBeLessThanOrEqual(2);
    vi.stubGlobal('navigator', { connection: { saveData: true } });
    const g = fetcher(manifest);
    const saver = new ParkMusic({ backend: b, base: '/m/', fetcher: g as unknown as typeof fetch });
    await saver.load();
    expect(g.mock.calls.filter((c) => !String(c[0]).endsWith('manifest.json'))).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

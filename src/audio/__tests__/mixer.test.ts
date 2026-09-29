import { describe, expect, it, vi } from 'vitest';
import { MAX_VOICES, Mixer, DEFAULT_SETTINGS } from '../mixer';
import { SFX_DEFS, renderSfx, renderCrowd } from '../synth';

/** Minimal AudioContext double: records nodes, connections, starts and disconnects. */
function fakeCtx(state: 'running' | 'suspended' = 'running') {
  const live = new Set<object>();
  const node = (extra: object = {}) => {
    const n: any = {
      connect: vi.fn(function (this: any, to: any) { return to; }),
      disconnect: vi.fn(() => live.delete(n)),
      ...extra,
    };
    live.add(n);
    return n;
  };
  const param = () => ({ value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const ctx: any = {
    state,
    sampleRate: 44100,
    currentTime: 1,
    destination: node(),
    resume: vi.fn(async () => { ctx.state = 'running'; }),
    close: vi.fn(async () => {}),
    createGain: () => node({ gain: param() }),
    createDynamicsCompressor: () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createAnalyser: () => node({ fftSize: 2048, getFloatTimeDomainData: (a: Float32Array) => a.fill(0.1) }),
    createBiquadFilter: () => node({ frequency: param(), type: '' }),
    createConvolver: () => node({ buffer: null }),
    createStereoPanner: () => node({ pan: param() }),
    createBuffer: (ch: number, len: number, sr: number) => ({ numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: () => new Float32Array(len), copyToChannel: () => {} }),
    createBufferSource: () => {
      const s: any = node({ buffer: null, loop: false, playbackRate: param(), start: vi.fn(), stop: vi.fn(), onended: null });
      ctx.sources.push(s);
      return s;
    },
    sources: [] as any[],
  };
  return { ctx, live };
}

async function readyMixer() {
  const f = fakeCtx();
  const m = new Mixer({ ...DEFAULT_SETTINGS }, () => f.ctx);
  expect(await m.unlock()).toBe(true);
  await new Promise<void>((res) => {
    const t = setInterval(() => m.ready && (clearInterval(t), res()), 5);
  });
  return { m, f };
}

describe('synth recipes', () => {
  it('render finite, non-silent, in-range audio for every sound', () => {
    for (const id of Object.keys(SFX_DEFS) as (keyof typeof SFX_DEFS)[]) {
      const d = SFX_DEFS[id];
      for (let b = 0; b < d.buckets; b++) {
        const r = renderSfx(id, b, 0);
        let peak = 0;
        for (const c of r.ch) for (const v of c) {
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, Math.abs(v));
        }
        expect(peak, `${id}/${b}`).toBeGreaterThan(0.3);
        expect(peak, `${id}/${b}`).toBeLessThanOrEqual(1);
        expect(r.ch[0].length / r.sr, id).toBeLessThan(2.5);
      }
    }
  });

  it('is deterministic per variant', () => {
    expect(Array.from(renderSfx('bat_crack', 2, 1).ch[0].slice(0, 200))).toEqual(Array.from(renderSfx('bat_crack', 2, 1).ch[0].slice(0, 200)));
  });

  it('crowd one-shots are stereo and audible', () => {
    const r = renderCrowd('roar_med');
    expect(r.ch).toHaveLength(2);
    expect(Math.max(...r.ch[0].slice(20000, 30000).map(Math.abs))).toBeGreaterThan(0.1);
  });
});

describe('mixer', () => {
  it('is a silent no-op with no context or a suspended one', async () => {
    const m = new Mixer({ ...DEFAULT_SETTINGS }, () => { throw new Error('no audio'); });
    expect(await m.unlock()).toBe(false);
    expect(m.playSfx({ kind: 'sfx', id: 'bat_crack', imp: 2 })).toBe(false);
    expect(m.playCrowd('roar_big')).toBe(false);
    expect(m.level()).toEqual({ rms: 0, peak: 0 });
  });

  it('plays a cue, disconnects its nodes when it ends, and does not leak', async () => {
    const { m, f } = await readyMixer();
    const baseline = f.live.size;
    expect(m.playSfx({ kind: 'sfx', id: 'bat_crack', bucket: 2, pos: { x: 0, y: 1, z: 0 }, gain: 1, imp: 2 })).toBe(true);
    expect(m.voiceCount).toBe(1);
    const src = f.ctx.sources.at(-1);
    expect(src.start).toHaveBeenCalled();
    src.onended();
    expect(m.voiceCount).toBe(0);
    expect(f.live.size).toBe(baseline);
    expect(m.played.bat_crack).toBe(1);
  });

  it('caps concurrent voices and keeps important ones', async () => {
    const { m } = await readyMixer();
    let ok = 0;
    for (let i = 0; i < MAX_VOICES + 10; i++) if (m.playSfx({ kind: 'sfx', id: 'wall_thud', imp: 0 })) ok++;
    expect(m.voiceCount).toBeLessThanOrEqual(MAX_VOICES);
    expect(ok).toBe(MAX_VOICES);
    expect(m.droppedVoices).toBe(10);
    expect(m.playSfx({ kind: 'sfx', id: 'bat_crack', imp: 3 })).toBe(true); // steals a low-importance voice
    expect(m.voiceCount).toBeLessThanOrEqual(MAX_VOICES);
    expect(m.stolenVoices).toBe(1);
  });

  it('rate-limits rapid repeats of the same sound', async () => {
    const { m } = await readyMixer();
    expect(m.playSfx({ kind: 'sfx', id: 'footstep', imp: 0 })).toBe(true);
    expect(m.playSfx({ kind: 'sfx', id: 'footstep', imp: 0 })).toBe(false);
  });

  it('slow motion replay makes new effects slower and ducks the bus; mute zeroes the master', async () => {
    const { m, f } = await readyMixer();
    m.setMode({ replay: true });
    m.playSfx({ kind: 'sfx', id: 'bat_crack', imp: 2 });
    expect(f.ctx.sources.at(-1).playbackRate.value).toBeLessThan(0.7);
    m.settings.muted = true;
    m.applySettings();
    expect(m.master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, expect.any(Number), expect.any(Number));
  });
});

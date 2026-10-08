/**
 * The audio render thread's load from a Chrome trace (`webaudio` category): every render quantum (128 frames) is one
 * `RealtimeAudioDestinationHandler::Render` event; its duration against the wall time of a window is the share of the audio thread the graph
 * needs (1.0 = it cannot keep up: glitches). With `disabled-by-default-webaudio.audionode` the per-node-type `*Handler::Process` events say where it
 * goes (heavy: attribution runs only). Windows come from the probe's `probe:start:<scene>` / `probe:end:<scene>` user-timing marks.
 */
import type { CDPSession } from 'playwright-core';

export const AUDIO_TRACE_CATEGORIES = 'webaudio,blink.user_timing';
export const AUDIO_NODE_CATEGORY = 'disabled-by-default-webaudio.audionode';

interface Ev { name: string; cat: string; ph: string; ts: number; dur?: number; tid: number; pid: number }

export async function audioTraceStart(cdp: CDPSession, nodes: boolean): Promise<Ev[]> {
  const buf: Ev[] = [];
  cdp.on('Tracing.dataCollected', (d) => {
    for (const e of d.value as unknown as Ev[]) if (e.cat && (e.cat.includes('webaudio') || e.cat.includes('user_timing'))) buf.push(e);
  });
  await cdp.send('Tracing.start', { categories: nodes ? `${AUDIO_TRACE_CATEGORIES},${AUDIO_NODE_CATEGORY}` : AUDIO_TRACE_CATEGORIES, transferMode: 'ReportEvents' } as never);
  return buf;
}

export async function audioTraceStop(cdp: CDPSession) {
  const done = new Promise<void>((res) => cdp.once('Tracing.tracingComplete', () => res()));
  await cdp.send('Tracing.end');
  await done;
}

export interface AudioLoad {
  /** share of wall time the audio thread spent rendering (sum of quantum render times / window) */
  load: number;
  /** render quanta per second (48 kHz / 128 = 375) */
  quantaPerSec: number;
  /** quantum render time, microseconds */
  quantumUsMedian: number;
  quantumUsP99: number;
  quantumUsMax: number;
  /** quanta that took longer than their own duration (128 / sampleRate): the device callback is then at risk */
  overBudget: number;
  /** ms of audio-thread CPU per second, by node handler (only with the audionode category) */
  byHandler?: Record<string, number>;
}

/** per scene: the audio thread's load between the probe marks */
export function audioLoads(events: Ev[], sampleRate = 48000): Record<string, AudioLoad> {
  const marks = events.filter((e) => e.cat.includes('user_timing') && /^probe:(start|end):/.test(e.name));
  const renders = events.filter((e) => e.name === 'RealtimeAudioDestinationHandler::Render' && e.ph === 'X');
  const handlers = events.filter((e) => /Handler::Process$/.test(e.name) && e.ph === 'X');
  const budgetUs = (128 / sampleRate) * 1e6;
  const out: Record<string, AudioLoad> = {};
  for (const s of marks.filter((m) => m.name.startsWith('probe:start:'))) {
    const scene = s.name.slice('probe:start:'.length);
    const e = marks.find((m) => m.name === `probe:end:${scene}` && m.ts > s.ts);
    if (!e) continue;
    const win = (e.ts - s.ts) / 1e6;
    const r = renders.filter((x) => x.ts >= s.ts && x.ts < e.ts).map((x) => x.dur ?? 0).sort((a, b) => a - b);
    const q = (p: number) => (r.length ? r[Math.min(r.length - 1, Math.floor(p * (r.length - 1) + 0.5))] : 0);
    const sum = r.reduce((a, b) => a + b, 0);
    const res: AudioLoad = {
      load: +(sum / 1e6 / win).toFixed(4),
      quantaPerSec: +(r.length / win).toFixed(1),
      quantumUsMedian: +q(0.5).toFixed(0),
      quantumUsP99: +q(0.99).toFixed(0),
      quantumUsMax: +(r[r.length - 1] ?? 0).toFixed(0),
      overBudget: r.filter((d) => d > budgetUs).length,
    };
    if (handlers.length) {
      const by: Record<string, number> = {};
      for (const h of handlers) if (h.ts >= s.ts && h.ts < e.ts) by[h.name.replace('Handler::Process', '')] = (by[h.name.replace('Handler::Process', '')] ?? 0) + (h.dur ?? 0);
      res.byHandler = Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / 1000 / win).toFixed(2)]));
    }
    out[scene] = res;
  }
  return out;
}

/**
 * Micro-benchmark of Web Audio node costs in this browser (offline rendering, ms of CPU per second of audio per node), used to budget
 * the venue graph. `npx tsx tools/audio/render.ts --bench` runs it.
 */
import { stadiumIR } from '../../src/audio/venue/ir';

type Kind = 'conv1' | 'conv16' | 'convmono' | 'gain' | 'biquad' | 'biquad2' | 'delay' | 'panner' | 'comp' | 'shaper' | 'shaper2x' | 'conv' | 'source' | 'source16k' | 'none';

export async function bench(kinds: Kind[] = ['none', 'gain', 'biquad', 'biquad2', 'delay', 'panner', 'comp', 'shaper', 'shaper2x', 'conv', 'source', 'source16k'], n = 40, secs = 10): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const sr = 48000;
  for (const k of kinds) {
    const count = k.startsWith('conv') ? 4 : n;
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: sr * secs, sampleRate: sr });
    const noise = ctx.createBuffer(1, sr * 2, sr);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 0.2 - 0.1;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    src.connect(mono);
    src.start();
    const sum = ctx.createGain();
    sum.gain.value = 0.01;
    sum.connect(ctx.destination);
    for (let i = 0; i < count; i++) {
      let node: AudioNode;
      switch (k) {
        case 'none':
          continue;
        case 'gain':
          node = ctx.createGain();
          break;
        case 'biquad':
        case 'biquad2': {
          const b = ctx.createBiquadFilter();
          b.frequency.value = 1000 + i;
          node = b;
          break;
        }
        case 'delay': {
          const dl = ctx.createDelay(1);
          dl.delayTime.value = 0.01 + i * 0.003;
          node = dl;
          break;
        }
        case 'panner': {
          const p = ctx.createStereoPanner();
          p.pan.value = 0.3;
          node = p;
          break;
        }
        case 'comp':
          node = ctx.createDynamicsCompressor();
          break;
        case 'shaper':
        case 'shaper2x': {
          const w = ctx.createWaveShaper();
          w.curve = new Float32Array([-1, 0, 1]);
          w.oversample = k === 'shaper2x' ? '2x' : 'none';
          node = w;
          break;
        }
        case 'conv1':
        case 'conv16':
        case 'convmono':
        case 'conv': {
          const c = ctx.createConvolver();
          c.normalize = false;
          const ir = stadiumIR(sr, 'normal');
          const len = k === 'conv1' ? sr : k === 'conv16' ? Math.floor(sr * 1.6) : ir.ch[0].length;
          const b = ctx.createBuffer(k === 'convmono' ? 1 : 2, len, sr);
          b.copyToChannel(ir.ch[0].subarray(0, len) as Float32Array<ArrayBuffer>, 0);
          if (k !== 'convmono') b.copyToChannel(ir.ch[1].subarray(0, len) as Float32Array<ArrayBuffer>, 1);
          c.buffer = b;
          node = c;
          break;
        }
        case 'source':
        case 'source16k': {
          const r = k === 'source' ? sr : 16000;
          const b = ctx.createBuffer(1, r * 3, r);
          const x = b.getChannelData(0);
          for (let j = 0; j < x.length; j++) x[j] = Math.random() * 0.1;
          const s = ctx.createBufferSource();
          s.buffer = b;
          s.loop = true;
          s.start();
          s.connect(sum);
          continue;
        }
      }
      (k === 'biquad2' ? src : mono).connect(node);
      node.connect(sum);
    }
    const t0 = performance.now();
    await ctx.startRendering();
    out[k] = (performance.now() - t0) / secs;
  }
  const base = out.none ?? 0;
  for (const k of Object.keys(out)) if (k !== 'none') out[k] = +((out[k] - base) / (k.startsWith('conv') ? 4 : n)).toFixed(3);
  return out;
}

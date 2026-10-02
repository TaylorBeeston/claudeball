/**
 * Browser smoke test page: loads the voice pack the way the game does (URL loader + the real PackSynth worker + onnxruntime-web) and
 * synthesises one line per style. Results go to window.__result for the Playwright runner (web_test.ts).
 */
import { HD_VOICES } from '../../../../src/audio/neural';
import { loadPackFromUrl } from '../../../../src/audio/voice/pack';
import { PackSynth } from '../../../../src/audio/voice/packSynth';
import { SynthCore } from '../../../../src/audio/voice/synthCore';

const LINES: [string, keyof typeof HD_VOICES, number][] = [
  ['Now batting, number twenty-three, Aaron Abbott.', 'pa', 0],
  ['Ninety-four miles an hour, low and away, strike one.', 'pbp', 0.1],
  ['Swing and a drive, back, back, back... and it is gone!', 'pbp', 0.95],
  ['He is hitting two forty-one on the season, with twelve home runs.', 'color', 0.2],
];

const out: Record<string, unknown> = { lines: [] as unknown[] };
(window as unknown as { __result: unknown }).__result = out;
const log = (s: string) => ((document.getElementById('log') as HTMLElement).textContent += `\n${s}`);

async function main() {
  const pack = await loadPackFromUrl('/pack/');
  pack.manifest.runtime = { ortUrl: '/ort/ort.wasm.min.mjs' };
  out.pack = { name: pack.manifest.name, default: pack.manifest.default, mb: +(pack.model.byteLength / 1e6).toFixed(1), speakers: pack.manifest.speakers };
  let excitement = 0;
  const synth = new PackSynth(pack, () => excitement);
  const t0 = performance.now();
  await synth.init('gpu', () => {});
  out.loadMs = Math.round(performance.now() - t0);
  for (const [text, role, ex] of LINES) {
    excitement = ex;
    const t = performance.now();
    try {
      const r = await synth.generate(text, HD_VOICES[role], 1);
      const secs = r.samples.length / r.sr;
      let sum = 0;
      for (const v of r.samples) sum += v * v;
      (out.lines as unknown[]).push({ text, role, style: synth.stats.lastStyle, seconds: +secs.toFixed(2), rms: +Math.sqrt(sum / r.samples.length).toFixed(4), rtf: +((performance.now() - t) / 1000 / secs).toFixed(3) });
    } catch (e) {
      (out.lines as unknown[]).push({ text, error: String((e as Error).message) });
    }
  }
  synth.dispose();
  // WebGPU probe in the page (the game's worker uses the WASM provider; this tells whether WebGPU would be an option on this machine)
  const gpu: Record<string, unknown> = { available: !!(navigator as { gpu?: unknown }).gpu };
  if (gpu.available) {
    try {
      const webgpuUrl = '/ort/ort.webgpu.min.mjs';
      const ort = await import(/* @vite-ignore */ webgpuUrl);
      ort.env.wasm.wasmPaths = '/ort/';
      const fp32 = new Uint8Array(await (await fetch('/pack/' + (pack.manifest.models.fp32?.file ?? pack.manifest.models[pack.manifest.default]!.file))).arrayBuffer());
      const session = await ort.InferenceSession.create(fp32, { executionProviders: ['webgpu'] });
      const core = new SynthCore(ort, session, pack.manifest);
      await core.synth(LINES[1][0], 'calm'); // warm-up compiles the shaders
      const t = performance.now();
      const r = await core.synth(LINES[2][0], 'peak');
      gpu.rtf = +((performance.now() - t) / 1000 / (r.samples.length / r.sr)).toFixed(3);
    } catch (e) {
      gpu.error = String((e as Error).message ?? e).slice(0, 200);
    }
  }
  out.webgpu = gpu;
  out.done = true;
  log(JSON.stringify(out, null, 1));
}
main().catch((e) => {
  out.error = String((e as Error).stack ?? e);
  out.done = true;
  log(String(out.error));
});

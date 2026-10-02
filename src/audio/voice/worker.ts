/**
 * Worker for the opt-in custom announcer voice: runs the owner's Piper/VITS model with onnxruntime-web.
 *
 * Nothing here is bundled with the game. onnxruntime-web is imported at run time from a pinned jsDelivr URL (or whatever the voice pack's
 * `runtime.ortUrl` says), only after the user turned the custom voice on; the model bytes arrive from the page (downloaded from the
 * owner's own host, or read from a local file).
 */
import { SynthCore, type OrtLike, type SessionLike } from './synthCore';
import { DEFAULT_ORT_URL, type StyleName, type VoiceManifest } from './pack';

const ctx = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };
let core: SynthCore | null = null;

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: string; id?: number; manifest?: VoiceManifest; model?: ArrayBuffer; ortUrl?: string; text?: string; style?: StyleName; gpu?: boolean };
  if (m.type === 'init') {
    try {
      const url = m.ortUrl || DEFAULT_ORT_URL;
      const ort = await import(/* @vite-ignore */ url);
      // the wasm files sit next to the script; one thread unless the page is cross-origin isolated (SharedArrayBuffer)
      ort.env.wasm.wasmPaths = url.replace(/[^/]*$/, '');
      ort.env.wasm.numThreads = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      const session = await ort.InferenceSession.create(new Uint8Array(m.model!), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      core = new SynthCore(ort as OrtLike, session as unknown as SessionLike, m.manifest!);
      ctx.postMessage({ type: 'ready' });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
  } else if (m.type === 'gen') {
    try {
      if (!core) throw new Error('not ready');
      const a = await core.synth(m.text!, m.style ?? 'calm');
      ctx.postMessage({ type: 'audio', id: m.id, samples: a.samples, sr: a.sr }, [a.samples.buffer]);
    } catch (err) {
      ctx.postMessage({ type: 'audio', id: m.id, error: String((err as Error)?.message ?? err) });
    }
  }
};

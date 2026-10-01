/**
 * Worker for the optional "HD voices": Kokoro-82M (Apache-2.0) text-to-speech through onnxruntime in the browser.
 *
 * Nothing here is bundled with the game. The kokoro-js library (and with it transformers.js, onnxruntime-web and a phonemizer that
 * embeds eSpeak NG, which is GPL) is imported at run time from a pinned jsDelivr URL, and the model weights are downloaded from the
 * Hugging Face Hub, only after the user opts in. transformers.js keeps the downloaded files in the browser Cache API.
 */
const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

interface Tts {
  generate(text: string, o: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
}
let tts: Tts | null = null;

const ctx = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: string; id?: number; device?: string; dtype?: string; text?: string; voice?: string; speed?: number };
  if (m.type === 'init') {
    try {
      const mod = await import(/* @vite-ignore */ KOKORO_URL);
      tts = await mod.KokoroTTS.from_pretrained(MODEL, {
        dtype: m.dtype,
        device: m.device,
        progress_callback: (p: unknown) => ctx.postMessage({ type: 'progress', p }),
      });
      ctx.postMessage({ type: 'ready' });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
  } else if (m.type === 'gen') {
    try {
      if (!tts) throw new Error('not ready');
      const a = await tts.generate(m.text!, { voice: m.voice!, speed: m.speed ?? 1 });
      const samples = new Float32Array(a.audio);
      ctx.postMessage({ type: 'audio', id: m.id, samples, sr: a.sampling_rate }, [samples.buffer]);
    } catch (err) {
      ctx.postMessage({ type: 'audio', id: m.id, error: String((err as Error)?.message ?? err) });
    }
  }
};

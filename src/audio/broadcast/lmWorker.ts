/**
 * Worker for the optional tiny language model (EXPERIMENTAL, see lm.ts). Nothing here is bundled with the game: transformers.js is
 * imported at run time from a pinned jsDelivr URL and the model weights come from the Hugging Face Hub, only when the player opts in.
 */
const TJS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm';

interface Gen {
  (messages: { role: string; content: string }[], o: Record<string, unknown>): Promise<{ generated_text: { content: string }[] }[]>;
}
let gen: Gen | null = null;
const ctx = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void };

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: string; id?: number; model?: string; dtype?: string; system?: string; user?: string; maxNew?: number };
  if (m.type === 'init') {
    try {
      const tf = await import(/* @vite-ignore */ TJS_URL);
      gen = (await tf.pipeline('text-generation', m.model, {
        device: 'webgpu',
        dtype: m.dtype,
        progress_callback: (p: unknown) => ctx.postMessage({ type: 'progress', p }),
      })) as Gen;
      ctx.postMessage({ type: 'ready' });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
    }
  } else if (m.type === 'gen') {
    try {
      if (!gen) throw new Error('not ready');
      const out = await gen(
        [
          { role: 'system', content: m.system ?? '' },
          { role: 'user', content: m.user ?? '' },
        ],
        { max_new_tokens: m.maxNew ?? 48, do_sample: true, temperature: 0.7, top_p: 0.9 },
      );
      ctx.postMessage({ type: 'text', id: m.id, text: String(out[0].generated_text.at(-1)?.content ?? '').trim() });
    } catch (err) {
      ctx.postMessage({ type: 'text', id: m.id, error: String((err as Error)?.message ?? err) });
    }
  }
};

export {};

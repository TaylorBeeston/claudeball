/** Worker client for the experimental tiny LM (lazy: only imported with `?lm=1`). Models and library come from the network at run time. */
import { LM_MODEL, LmColour } from './lm';

export async function startLm(onProgress?: (pct: number) => void): Promise<LmColour> {
  const w = new Worker(new URL('./lmWorker.ts', import.meta.url), { type: 'module' });
  const jobs = new Map<number, { res: (t: string) => void; rej: (e: Error) => void }>();
  let seq = 1;
  await new Promise<void>((resolve, reject) => {
    const files = new Map<string, { l: number; t: number }>();
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'ready') resolve();
      else if (m.type === 'error') reject(new Error(m.message));
      else if (m.type === 'progress' && m.p?.file) {
        files.set(m.p.file, { l: m.p.loaded ?? m.p.total ?? 0, t: m.p.total ?? 0 });
        let l = 0;
        let t = 0;
        for (const f of files.values()) {
          l += f.l;
          t += f.t;
        }
        if (t > 0) onProgress?.(Math.min(99, Math.round((l / t) * 100)));
      } else if (m.type === 'text') {
        const j = jobs.get(m.id);
        if (!j) return;
        jobs.delete(m.id);
        if (m.error) j.rej(new Error(m.error));
        else j.res(m.text);
      }
    };
    w.onerror = (e) => reject(new Error(e.message || 'worker failed'));
    w.postMessage({ type: 'init', model: LM_MODEL.id, dtype: LM_MODEL.dtype });
  });
  return new LmColour({
    generate: (system, user) =>
      new Promise<string>((res, rej) => {
        const id = seq++;
        jobs.set(id, { res, rej });
        w.postMessage({ type: 'gen', id, system, user, maxNew: 48 });
      }),
  });
}

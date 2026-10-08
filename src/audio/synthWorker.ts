/** Start-up sound synthesis off the main thread (see `synthJobs.ts`): one job at a time, each result transferred back as it is done. */
import { runJob, type SynthJob } from './synthJobs';

self.onmessage = (e: MessageEvent<{ n: number; job: SynthJob; sr: number }>) => {
  const { n, job, sr } = e.data;
  try {
    const r = runJob(job, sr);
    const ch = r.ch.map((c) => (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice()));
    (self as unknown as Worker).postMessage({ n, sr: r.sr, ch }, ch.map((c) => c.buffer as ArrayBuffer));
  } catch (err) {
    (self as unknown as Worker).postMessage({ n, error: String(err) });
  }
};

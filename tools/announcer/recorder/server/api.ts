/**
 * The recorder's tiny local API (Node, no dependencies). It reads the script and reads/writes the user's private voice folder
 * (`CB_VOICE_DIR`, default `~/claudeball-voice`): `wavs/<id>.wav`, `roomtone.wav`, `meta.json`. Nothing is ever sent anywhere else.
 *
 * Hardening, since this writes files on the user's machine: ids are `[a-z0-9_-]{1,64}` (no path separators, ever), only `localhost`/`127.0.0.1`
 * Host headers are served (DNS rebinding), cross-origin writes are refused, bodies are capped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const ID_RE = /^[a-z0-9_-]{1,64}$/;
const MAX_BODY = 64 * 1024 * 1024;

export interface ApiOptions {
  voiceDir?: string;
  scriptPath: string;
}

export const defaultVoiceDir = () => process.env.CB_VOICE_DIR || path.join(os.homedir(), 'claudeball-voice');

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Write via a temp file + rename so a crash never leaves half a take. */
function atomicWrite(file: string, data: Buffer | string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const isWav = (b: Buffer) => b.length > 44 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE';

export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.replace(/:\d+$/, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

export function createApi(opts: ApiOptions) {
  const dir = () => opts.voiceDir ?? defaultVoiceDir();
  const wavDir = () => path.join(dir(), 'wavs');
  const metaFile = () => path.join(dir(), 'meta.json');
  const readMeta = (): { takes: Record<string, unknown>; config: Record<string, unknown> } => {
    try {
      const m = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
      return { takes: m.takes ?? {}, config: m.config ?? {} };
    } catch {
      return { takes: {}, config: {} };
    }
  };
  const writeMeta = (m: { takes: Record<string, unknown>; config: Record<string, unknown> }) => atomicWrite(metaFile(), JSON.stringify(m, null, 1));

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next ? next() : json(res, 404, { error: 'not found' });
    try {
      if (!hostAllowed(req.headers.host)) return json(res, 403, { error: 'host not allowed' });
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && !hostAllowed(new URL(origin).host)) return json(res, 403, { error: 'cross-origin write refused' });
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) return json(res, 403, { error: 'cross-site write refused' });
      }
      const parts = url.pathname.split('/').filter(Boolean).slice(1); // after /api
      const [kind, id] = parts;

      if (method === 'GET' && kind === 'info') return json(res, 200, { voiceDir: dir(), wavDir: wavDir(), platform: process.platform });

      if (method === 'GET' && kind === 'script') {
        const lines = fs.readFileSync(opts.scriptPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        return json(res, 200, { lines });
      }

      if (kind === 'meta') {
        if (method === 'GET') {
          const m = readMeta();
          // a wav on disk without a meta row still counts as done (imported by hand)
          let files: string[] = [];
          try {
            files = fs.readdirSync(wavDir()).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4));
          } catch {
            /* no folder yet */
          }
          return json(res, 200, { ...m, files, roomTone: fs.existsSync(path.join(dir(), 'roomtone.wav')) });
        }
        if (method === 'PUT' && id === 'config') {
          const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8'));
          const m = readMeta();
          m.config = { ...m.config, ...body };
          writeMeta(m);
          return json(res, 200, { ok: true, config: m.config });
        }
        if (method === 'PUT' && id && ID_RE.test(id)) {
          const body = JSON.parse((await readBody(req, 1 << 20)).toString('utf8'));
          const m = readMeta();
          m.takes[id] = { ...(m.takes[id] as object | undefined), ...body, updated: new Date().toISOString() };
          writeMeta(m);
          return json(res, 200, { ok: true });
        }
        return json(res, 400, { error: 'bad meta request' });
      }

      if (kind === 'wav') {
        if (!id || !ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
        const file = path.join(wavDir(), `${id}.wav`);
        if (method === 'PUT') {
          const body = await readBody(req);
          if (!isWav(body)) return json(res, 400, { error: 'not a WAV' });
          atomicWrite(file, body);
          return json(res, 200, { ok: true, bytes: body.length });
        }
        if (method === 'GET') {
          if (!fs.existsSync(file)) return json(res, 404, { error: 'no take' });
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Cache-Control', 'no-store');
          res.end(fs.readFileSync(file));
          return;
        }
        if (method === 'DELETE') {
          fs.rmSync(file, { force: true });
          const m = readMeta();
          delete m.takes[id];
          writeMeta(m);
          return json(res, 200, { ok: true });
        }
      }

      if (kind === 'roomtone') {
        const file = path.join(dir(), 'roomtone.wav');
        if (method === 'PUT') {
          const body = await readBody(req);
          if (!isWav(body)) return json(res, 400, { error: 'not a WAV' });
          atomicWrite(file, body);
          return json(res, 200, { ok: true });
        }
        if (method === 'GET') {
          if (!fs.existsSync(file)) return json(res, 404, { error: 'no room tone' });
          res.setHeader('Content-Type', 'audio/wav');
          res.end(fs.readFileSync(file));
          return;
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (!res.headersSent) json(res, status, { error: String((e as Error).message ?? e) });
    }
  };
}

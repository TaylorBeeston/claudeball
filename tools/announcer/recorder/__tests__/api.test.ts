import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../server/api';
import { encodeWav } from '../src/dsp';

let server: http.Server;
let base = '';
let dir = '';
const wav = () => Buffer.from(encodeWav(new Float32Array(2000).fill(0.1), 48000, 16));

async function call(method: string, p: string, body?: Buffer | string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const u = new URL(base + p);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const c: Buffer[] = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbvoice-'));
  const script = path.join(dir, 'script.jsonl');
  fs.writeFileSync(script, '{"id":"p0001","text":"Strike!","normalized":"Strike!"}\n');
  const api = createApi({ voiceDir: path.join(dir, 'voice'), scriptPath: script });
  server = http.createServer((req, res) => void api(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recorder api', () => {
  it('serves the script', async () => {
    const r = await call('GET', '/api/script');
    expect(JSON.parse(r.body.toString()).lines[0].id).toBe('p0001');
  });
  it('stores a take, its meta and the room tone, and lists them', async () => {
    expect((await call('PUT', '/api/wav/p0001', wav())).status).toBe(200);
    expect((await call('PUT', '/api/meta/p0001', JSON.stringify({ status: 'done', takes: 1 }))).status).toBe(200);
    expect((await call('PUT', '/api/roomtone', wav())).status).toBe(200);
    expect((await call('PUT', '/api/meta/config', JSON.stringify({ rate: 48000, bits: 24 }))).status).toBe(200);
    const m = JSON.parse((await call('GET', '/api/meta')).body.toString());
    expect(m.files).toEqual(['p0001']);
    expect(m.takes.p0001.status).toBe('done');
    expect(m.config).toEqual({ rate: 48000, bits: 24 });
    expect(m.roomTone).toBe(true);
    expect((await call('GET', '/api/wav/p0001')).body.length).toBe(wav().length);
    expect(fs.existsSync(path.join(dir, 'voice', 'wavs', 'p0001.wav'))).toBe(true);
  });
  it('refuses path traversal and odd ids', async () => {
    for (const id of ['..%2f..%2fevil', '%2e%2e', 'a.b', 'A1', 'x'.repeat(65)]) expect([400, 404], id).toContain((await call('PUT', `/api/wav/${id}`, wav())).status);
    expect(fs.existsSync(path.join(dir, 'evil.wav'))).toBe(false);
  });
  it('refuses non-WAV bodies', async () => {
    expect((await call('PUT', '/api/wav/p0002', Buffer.from('hello world, definitely not a wav file at all......'))).status).toBe(400);
  });
  it('refuses foreign Host and cross-origin writes (DNS rebinding / CSRF)', async () => {
    expect((await call('GET', '/api/script', undefined, { Host: 'evil.example.com' })).status).toBe(403);
    expect((await call('PUT', '/api/wav/p0003', wav(), { Origin: 'http://evil.example.com' })).status).toBe(403);
    expect((await call('PUT', '/api/wav/p0003', wav(), { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  });
  it('deletes a take', async () => {
    expect((await call('DELETE', '/api/wav/p0001')).status).toBe(200);
    expect(JSON.parse((await call('GET', '/api/meta')).body.toString()).files).toEqual([]);
  });
});

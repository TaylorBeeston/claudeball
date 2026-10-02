/** Where takes live. The default is the local server (writes to ~/claudeball-voice); the File System Access API is an alternative backend. */
import type { Qc } from './dsp';

export interface ScriptLine {
  id: string;
  text: string;
  normalized: string;
  style: string;
  speaker: number;
  direction: string;
  session: string;
  priority: number;
  tier: string;
  kind: string;
  source: string;
  estSeconds: number;
}

export interface TakeMeta {
  status: 'done' | 'skipped' | 'flag';
  qc?: Qc;
  durationS?: number;
  rate?: number;
  bits?: number;
  takes?: number;
  imported?: boolean;
  updated?: string;
}

export interface MetaSnapshot {
  takes: Record<string, TakeMeta>;
  config: { rate?: number; bits?: number };
  files: string[];
  roomTone: boolean;
}

export interface Store {
  readonly label: string;
  script(): Promise<ScriptLine[]>;
  meta(): Promise<MetaSnapshot>;
  putWav(id: string, wav: ArrayBuffer): Promise<void>;
  getWav(id: string): Promise<ArrayBuffer | null>;
  putMeta(id: string, m: Partial<TakeMeta>): Promise<void>;
  putConfig(c: Record<string, unknown>): Promise<void>;
  putRoomTone(wav: ArrayBuffer): Promise<void>;
  getRoomTone(): Promise<ArrayBuffer | null>;
  deleteTake(id: string): Promise<void>;
}

async function ok(r: Response): Promise<Response> {
  if (!r.ok) throw new Error(`${r.url}: ${r.status} ${await r.text().catch(() => '')}`);
  return r;
}

export class ServerStore implements Store {
  label = 'local server folder';
  async script() {
    return ((await (await ok(await fetch('/api/script'))).json()) as { lines: ScriptLine[] }).lines;
  }
  async meta() {
    return (await (await ok(await fetch('/api/meta'))).json()) as MetaSnapshot;
  }
  async putWav(id: string, wav: ArrayBuffer) {
    await ok(await fetch(`/api/wav/${id}`, { method: 'PUT', body: wav, headers: { 'Content-Type': 'audio/wav' } }));
  }
  async getWav(id: string) {
    const r = await fetch(`/api/wav/${id}`);
    return r.ok ? r.arrayBuffer() : null;
  }
  async putMeta(id: string, m: Partial<TakeMeta>) {
    await ok(await fetch(`/api/meta/${id}`, { method: 'PUT', body: JSON.stringify(m), headers: { 'Content-Type': 'application/json' } }));
  }
  async putConfig(c: Record<string, unknown>) {
    await ok(await fetch('/api/meta/config', { method: 'PUT', body: JSON.stringify(c), headers: { 'Content-Type': 'application/json' } }));
  }
  async putRoomTone(wav: ArrayBuffer) {
    await ok(await fetch('/api/roomtone', { method: 'PUT', body: wav, headers: { 'Content-Type': 'audio/wav' } }));
  }
  async getRoomTone() {
    const r = await fetch('/api/roomtone');
    return r.ok ? r.arrayBuffer() : null;
  }
  async deleteTake(id: string) {
    await ok(await fetch(`/api/wav/${id}`, { method: 'DELETE' }));
  }
}

/** Same layout, written straight into a folder the user picks (Chromium's File System Access API). The script still comes from the server. */
export class FsaStore implements Store {
  label: string;
  constructor(private root: FileSystemDirectoryHandle, private base: ServerStore) {
    this.label = `folder "${root.name}" (browser)`;
  }
  private async wavs() {
    return this.root.getDirectoryHandle('wavs', { create: true });
  }
  private async write(dir: FileSystemDirectoryHandle, name: string, data: ArrayBuffer | string) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
  private async readJson(): Promise<{ takes: Record<string, TakeMeta>; config: Record<string, unknown> }> {
    try {
      const f = await (await this.root.getFileHandle('meta.json')).getFile();
      const m = JSON.parse(await f.text());
      return { takes: m.takes ?? {}, config: m.config ?? {} };
    } catch {
      return { takes: {}, config: {} };
    }
  }
  script() {
    return this.base.script();
  }
  async meta(): Promise<MetaSnapshot> {
    const m = await this.readJson();
    const files: string[] = [];
    const d = await this.wavs();
    for await (const [name] of d.entries()) if (name.endsWith('.wav')) files.push(name.slice(0, -4));
    let roomTone = false;
    try {
      await this.root.getFileHandle('roomtone.wav');
      roomTone = true;
    } catch {
      /* none */
    }
    return { takes: m.takes, config: m.config as MetaSnapshot['config'], files, roomTone };
  }
  async putWav(id: string, wav: ArrayBuffer) {
    await this.write(await this.wavs(), `${id}.wav`, wav);
  }
  async getWav(id: string) {
    try {
      return await (await (await (await this.wavs()).getFileHandle(`${id}.wav`)).getFile()).arrayBuffer();
    } catch {
      return null;
    }
  }
  async putMeta(id: string, m: Partial<TakeMeta>) {
    const j = await this.readJson();
    j.takes[id] = { ...(j.takes[id] as object), ...m, updated: new Date().toISOString() } as TakeMeta;
    await this.write(this.root, 'meta.json', JSON.stringify(j, null, 1));
  }
  async putConfig(c: Record<string, unknown>) {
    const j = await this.readJson();
    j.config = { ...j.config, ...c };
    await this.write(this.root, 'meta.json', JSON.stringify(j, null, 1));
  }
  async putRoomTone(wav: ArrayBuffer) {
    await this.write(this.root, 'roomtone.wav', wav);
  }
  async getRoomTone() {
    try {
      return await (await (await this.root.getFileHandle('roomtone.wav')).getFile()).arrayBuffer();
    } catch {
      return null;
    }
  }
  async deleteTake(id: string) {
    try {
      await (await this.wavs()).removeEntry(`${id}.wav`);
    } catch {
      /* already gone */
    }
    const j = await this.readJson();
    delete j.takes[id];
    await this.write(this.root, 'meta.json', JSON.stringify(j, null, 1));
  }
}

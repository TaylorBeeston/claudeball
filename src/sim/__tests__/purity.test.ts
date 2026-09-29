import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The sim runs in the browser as well as in Node: it must not touch Node-only globals (a stray `process.env` debug print
// once crashed the whole game in the renderer).
describe('sim purity', () => {
  it('uses no Node-only globals', () => {
    const dir = path.resolve(__dirname, '..');
    const bad: string[] = [];
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
      if (/\b(process|require|__dirname|Buffer)\b\s*[.(]/.test(src)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});

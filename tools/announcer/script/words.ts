/**
 * Every word the voice might be asked to say: the recording script, the name pools, and every multi-word string literal in src/audio
 * (so commentary added later is picked up). Written to data/vocab.txt (one lower-case word per line); the lexicon builder phonemizes these.
 * Run: npm run announcer:vocab
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeForSpeech, wordsOf } from '../../../src/audio/voice/normalize';
import { buildScript } from './generate';
import { loadPools } from './vocab';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

/** Words from string literals in src/audio/*.ts: template parts around `${}` count as separate sentences. */
export function audioSourceWords(): Set<string> {
  const out = new Set<string>();
  const dir = path.join(root, 'src/audio');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const parts = m[2].split(/\$\{[^}]*\}/);
      for (const part of parts) {
        if (!/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(part) || /[_{}()=<>/\\]/.test(part)) continue;
        for (const w of wordsOf(normalizeForSpeech(part))) out.add(w);
      }
    }
  }
  return out;
}

export function allWords(): string[] {
  const words = new Set<string>();
  for (const l of buildScript()) for (const w of wordsOf(l.normalized)) words.add(w);
  const p = loadPools();
  for (const n of [...p.first, ...p.last, ...p.cities, ...p.mascots, ...p.positions]) for (const w of wordsOf(n)) words.add(w);
  for (const w of audioSourceWords()) words.add(w);
  return [...words].sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const w = allWords();
  fs.writeFileSync(path.join(here, 'data/vocab.txt'), w.join('\n') + '\n');
  console.log(`${w.length} words -> tools/announcer/script/data/vocab.txt`);
}

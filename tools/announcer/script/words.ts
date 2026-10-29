/**
 * Every word the voice might be asked to say: the recording script, the name pools, every multi-word string literal in src/audio and its
 * folders (so commentary added later is picked up, the booth's templates included) and the generated parks, officials and managers. Written to data/vocab.txt (one lower-case word per line); the lexicon builder phonemizes these.
 * Run: npm run announcer:vocab
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeForSpeech, wordsOf } from '../../../src/audio/voice/normalize';
import { buildScript } from './generate';
import { loadPools } from './vocab';
import { clockWords } from '../../../src/audio/broadcast/pregame';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

/** the .ts files under a folder, tests left out */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : sources(path.join(dir, e.name))) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

/**
 * The literal text of every string in a source file: quoted strings whole, template literals as their literal chunks (the `${...}` parts are
 * code, and may hold more strings and template literals of their own, which are read too). A small scanner rather than a regex, so nested
 * template literals and quotes inside expressions do not cut a string short.
 */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const skipComment = () => {
    if (src.startsWith('//', i)) i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
    else if (src.startsWith('/*', i)) i = src.indexOf('*/', i + 2) < 0 ? src.length : src.indexOf('*/', i + 2) + 2;
    else return false;
    return true;
  };
  const quoted = (q: string) => {
    let t = '';
    i++;
    while (i < src.length && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\') {
        t += src[i + 1] === 'n' ? ' ' : src[i + 1];
        i += 2;
      } else t += src[i++];
    }
    i++;
    out.push(t);
  };
  // a template literal from its opening backtick; `${...}` expressions are scanned as code until their closing brace
  const template = () => {
    i++;
    let t = '';
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') {
        t += src[i + 1];
        i += 2;
      } else if (src.startsWith('${', i)) {
        out.push(t);
        t = '';
        i += 2;
        code('}');
        i++;
      } else t += src[i++];
    }
    i++;
    out.push(t);
  };
  const code = (stop: string | null) => {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (skipComment()) continue;
      if (ch === "'" || ch === '"') quoted(ch);
      else if (ch === '`') template();
      else if (ch === '{') {
        depth++;
        i++;
      } else if (ch === '}') {
        if (depth === 0 && stop === '}') return;
        depth--;
        i++;
      } else i++;
    }
  };
  code(null);
  return out;
}

/**
 * Words from string literals in src/audio and its folders (the booth's templates in src/audio/broadcast too). A booth template's choices
 * (`{a|b}`, `[opt]`) and slots (`$name`) are taken apart, so every word any expansion can say is listed. In the booth's folder every literal
 * counts (names like 'Dupree', a lone 'Yeah'); elsewhere only phrases of two words or more (single words there are mostly identifiers).
 */
export function audioSourceWords(): Set<string> {
  const out = new Set<string>();
  for (const file of sources(path.join(root, 'src/audio'))) {
    const booth = file.includes(`${path.sep}broadcast${path.sep}`);
    for (const raw of stringLiterals(fs.readFileSync(file, 'utf8'))) {
      const part = raw.replace(/\$[A-Za-z0-9_]+/g, ' ').replace(/[{}|[\]]/g, ' ');
      if (/[_()=<>/\\]/.test(part) || !/[A-Za-z]{2,}/.test(part)) continue;
      if (!booth && !/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(part)) continue;
      if (booth && !/\s/.test(part.trim()) && !/^[A-Z][a-z]+$|^[A-Za-z]+'[a-z]+$/.test(part.trim())) continue;
      for (const w of wordsOf(normalizeForSpeech(part))) out.add(w);
    }
  }
  return out;
}

/** forms the booth builds from names and numbers: "Anderson's", "the 29-year-old", "seven-oh-five" */
export function derivedWords(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of names) for (const w of wordsOf(normalizeForSpeech(n))) out.add(`${w}'s`);
  for (let age = 16; age <= 50; age++) for (const w of wordsOf(normalizeForSpeech(`the ${age}-year-old`))) out.add(w);
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) for (const w of wordsOf(clockWords(h, m))) out.add(w);
  return out;
}

/** the generated who-and-where the booth reads out (src/sim/gameinfo.ts: parks, features, officials, managers, mascots, dates) */
export function gameInfoWords(): Set<string> {
  const src = fs.readFileSync(path.join(root, 'src/sim/gameinfo.ts'), 'utf8');
  const out = new Set<string>();
  for (const name of ['MONTHS', 'WEEKDAYS', 'PARK_A', 'PARK_B', 'FEATURES', 'OFF_FIRST', 'OFF_LAST', 'MASCOT_NAMES']) {
    const m = src.match(new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\];`));
    for (const x of m ? m[1].matchAll(/'((?:\\'|[^'])+)'/g) : []) for (const w of wordsOf(normalizeForSpeech(x[1].replace(/\\'/g, "'")))) out.add(w);
  }
  return out;
}

export function allWords(): string[] {
  const words = new Set<string>();
  for (const l of buildScript()) for (const w of wordsOf(l.normalized)) words.add(w);
  const p = loadPools();
  for (const n of [...p.first, ...p.last, ...p.cities, ...p.mascots, ...p.positions]) for (const w of wordsOf(n)) words.add(w);
  for (const w of audioSourceWords()) words.add(w);
  const info = gameInfoWords();
  for (const w of info) words.add(w);
  for (const w of derivedWords([...p.first, ...p.last, ...p.cities, ...p.mascots, ...info])) words.add(w);
  return [...words].sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const w = allWords();
  fs.writeFileSync(path.join(here, 'data/vocab.txt'), w.join('\n') + '\n');
  console.log(`${w.length} words -> tools/announcer/script/data/vocab.txt`);
}

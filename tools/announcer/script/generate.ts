/**
 * Generates the recording script: `tools/announcer/script/data/*.jsonl` (machine-readable) and `SCRIPT.md` (readable / printable).
 * Run with `npm run announcer:script`. Deterministic: same game sources + same templates = same script.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeForSpeech, wordsOf } from '../../../src/audio/voice/normalize';
import { CHATTER, SENTENCES } from './chatter';
import { fill, Rand } from './slots';
import { TEMPLATES } from './templates';
import { LINE_PAD_S, STYLES, STYLE_SPEAKER, STYLE_WPS, type Kind, type ScriptLine, type Style, type Tier } from './types';
import { INNING_WORDS, loadPools, type Pools } from './vocab';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Minutes of finished audio per session: a session of ~12 min audio is ~25-30 min at the mic once retakes and breaks are counted. */
export const SESSION_AUDIO_MIN = 12;
const TIER_PRIORITY: Record<Tier, 1 | 2 | 3> = { pilot: 1, core: 2, extended: 3 };

interface Raw {
  tier: Tier;
  kind: Kind;
  style: Style;
  direction: string;
  text: string;
  source: string;
}

export function estimateSeconds(normalized: string, style: Style): number {
  return wordsOf(normalized).length / STYLE_WPS[style] + LINE_PAD_S;
}

function expandTemplates(p: Pools): Raw[] {
  const out: Raw[] = [];
  for (const t of TEMPLATES) {
    const variants = Array.isArray(t.text) ? t.text : [t.text];
    const r = new Rand(`tpl:${t.id}`);
    const seen = new Set<string>();
    const tiers: Tier[] = ['pilot', 'core', 'extended'];
    let vi = 0;
    for (let ti = 0; ti < 3; ti++) {
      for (let i = 0; i < t.n[ti]; i++) {
        let text = '';
        for (let tries = 0; tries < 60; tries++) {
          text = fill(variants[vi % variants.length], r, p);
          vi++;
          if (!seen.has(text)) break;
        }
        if (seen.has(text)) continue; // a fixed line that has no more variants
        seen.add(text);
        out.push({ tier: tiers[ti], kind: t.kind, style: t.style, direction: t.direction, text, source: t.id });
      }
    }
  }
  return out;
}

/** Chatter and plain sentences: first few -> pilot, next -> core, the rest extended. Names/slots are filled deterministically. */
function expandFree(p: Pools): Raw[] {
  const out: Raw[] = [];
  const r = new Rand('free');
  const pilotChat = 6, coreChat = 62;
  CHATTER.forEach((c, i) => {
    const tier: Tier = i < pilotChat ? 'pilot' : i < pilotChat + coreChat ? 'core' : 'extended';
    out.push({ tier, kind: 'chatter', style: c.style, direction: c.style === 'building' ? 'Start low, let it build sentence by sentence; the last line is the loudest.' : c.style === 'calm' ? 'Warm and unhurried, like painting the scene for the radio listener.' : 'Dry and a little amused, like thinking out loud. Almost no rise; land each sentence soft.', text: fill(c.text, r, p), source: 'chatter' });
  });
  const pilotSent = 10, coreSent = 64;
  SENTENCES.forEach((s, i) => {
    const tier: Tier = i < pilotSent ? 'pilot' : i < pilotSent + coreSent ? 'core' : 'extended';
    out.push({ tier, kind: 'sentence', style: 'calm', direction: 'Plain, natural reading at a relaxed broadcast pace. No performance.', text: s, source: 'sentences' });
  });
  return out;
}

/** The vocabulary pass: every name, team, position, number and speed, in carrier phrases and in isolation. All extended. */
function expandVocabulary(p: Pools): Raw[] {
  const out: Raw[] = [];
  const add = (kind: Kind, style: Style, direction: string, text: string, source: string) => out.push({ tier: 'extended', kind, style, direction, text, source });
  const DN = 'Clear and full, like a stadium PA name; a little drop at the end.';
  const r = new Rand('vocab');
  const nPairs = Math.max(p.first.length, p.last.length);
  const fs = r.shuffle(p.first), ls = r.shuffle(p.last);
  const at = <T,>(a: T[], i: number) => a[i % a.length];
  // carrier A: PA line, carrier B: play-by-play line, with different partner names so every name is heard in two contexts
  for (let i = 0; i < nPairs; i++) {
    add('name', 'crisp', DN, `Now batting, number ${r.int(p.jerseyMin, p.jerseyMax)}, ${at(fs, i)} ${at(ls, i)}.`, 'names-pa');
  }
  for (let i = 0; i < nPairs; i++) {
    const verb = r.pick(['singles to left field.', 'grounds out, six-three.', 'strikes out swinging.', 'doubles down the right-field line.', 'flies out to center field.', 'walks.', 'steals second.']);
    add('name', 'calm', 'Easy play-by-play; stress the name lightly, fall on the end.', `${at(fs, i + 17)} ${at(ls, i + 5)} ${verb}`, 'names-pbp');
  }
  for (const f of p.first) add('name', 'crisp', DN, `${f}.`, 'names-first');
  for (const l of p.last) add('name', 'crisp', DN, `${l}.`, 'names-last');
  // teams and positions
  const cs = r.shuffle(p.cities), ms = r.shuffle(p.mascots);
  for (let i = 0; i < Math.max(cs.length, ms.length); i++) add('team', 'crisp', 'PA voice: even, lean on the mascot, fall at the end.', `The ${at(cs, i)} ${at(ms, i)}.`, 'teams');
  for (const c of p.cities) add('team', 'crisp', DN, `${c}.`, 'teams-city');
  for (const m of p.mascots) add('team', 'crisp', DN, `${m}.`, 'teams-mascot');
  p.abbrevs.forEach((a) => add('team', 'deadpan', 'Spell it out clearly, letter by letter, as on the scoreboard.', `${a}`, 'teams-abbrev'));
  for (const pos of p.positions) {
    add('name', 'calm', DN, `${pos}.`, 'positions');
    add('name', 'calm', 'Easy, conversational, fall at the end.', `Ground ball to the ${pos}.`, 'positions-carrier');
  }
  // numbers
  for (let n = 0; n <= 130; n++) add('number', 'calm', 'Say it clearly with the broadcast fall at the end.', `${n}.`, 'numbers');
  for (let n = 1; n <= 99; n++) add('number', 'crisp', 'PA voice: even, fall at the end.', `Number ${n}.`, 'numbers-jersey');
  for (let n = 1; n <= 12; n++) {
    add('number', 'calm', 'Easy, then settle on the inning.', `The ${INNING_WORDS[n - 1]} inning.`, 'innings');
    add('number', 'calm', 'Easy, then settle on the inning.', `Top of the ${INNING_WORDS[n - 1]}.`, 'innings');
    add('number', 'calm', 'Easy, then settle on the inning.', `Bottom of the ${INNING_WORDS[n - 1]}.`, 'innings');
  }
  for (let n = 40; n <= 110; n++) add('number', 'deadpan', 'Flat, matter-of-fact; the number crisp, last word falls.', `${n} miles an hour.`, 'speeds');
  for (let n = 250; n <= 480; n += 5) add('number', 'deadpan', 'Flat, matter-of-fact; the number crisp, last word falls.', `${n} feet.`, 'distances');
  for (let n = 150; n <= 400; n += 5) add('number', 'deadpan', 'Flat, matter-of-fact.', `Batting .${n}.`, 'averages');
  for (let n = 100; n <= 650; n += 25) add('number', 'deadpan', 'Flat, matter-of-fact.', `An ERA of ${(n / 100).toFixed(2)}.`, 'era');
  for (let n = 10; n <= 90; n += 10) add('number', 'deadpan', 'Flat, matter-of-fact.', `${n}%.`, 'percent');
  return out;
}

function pickTiers(raw: Raw[]): Raw[] {
  // exact duplicates (same text) keep their first and highest tier
  const seen = new Map<string, Raw>();
  for (const x of raw) if (!seen.has(x.text)) seen.set(x.text, x);
  return [...seen.values()];
}

const STYLE_ORDER = new Map(STYLES.map((s, i) => [s, i]));

/** Spread lines of one tier over sessions of ~SESSION_AUDIO_MIN minutes, each with a similar style mix, ordered calm -> peak inside a session. */
function assignSessions(lines: Omit<ScriptLine, 'session'>[], tier: Tier, prefix: string, perSessionSec: number, minSessions = 1): Record<string, string> {
  const mine = lines.filter((l) => l.tier === tier);
  const total = mine.reduce((a, l) => a + l.estSeconds, 0);
  const nSessions = Math.max(minSessions, Math.round(total / perSessionSec));
  const map: Record<string, string> = {};
  if (tier === 'extended') {
    // extended sessions follow the content (names together, numbers together) so each session is one kind of reading
    const order = [...mine].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    let acc = 0, s = 1;
    const per = total / nSessions;
    for (const l of order) {
      if (acc > per * s && s < nSessions) s++;
      map[l.id] = `${prefix}${s}`;
      acc += l.estSeconds;
    }
    return map;
  }
  // round-robin per style so every session has the whole style mix
  const buckets = new Map<Style, typeof mine>();
  for (const l of mine) {
    const b = buckets.get(l.style) ?? [];
    b.push(l);
    buckets.set(l.style, b);
  }
  let k = 0;
  for (const s of STYLES) {
    for (const l of buckets.get(s) ?? []) {
      map[l.id] = `${prefix}${(k % nSessions) + 1}`;
      k++;
    }
  }
  return map;
}

export function buildScript(): ScriptLine[] {
  const pools = loadPools();
  const raw = pickTiers([...expandTemplates(pools), ...expandFree(pools), ...expandVocabulary(pools)]);
  const base: Omit<ScriptLine, 'session'>[] = [];
  const tierOrder: Tier[] = ['pilot', 'core', 'extended'];
  const used = new Set<string>();
  /** Ids are a hash of the text, not a counter: regenerating the script (new commentary, new templates) never renumbers lines you have already recorded. */
  const idOf = (text: string) => {
    for (let len = 8; ; len++) {
      const id = createHash('sha1').update(text).digest('hex').slice(0, len);
      if (!used.has(id)) return id;
    }
  };
  for (const tier of tierOrder) {
    for (const x of raw.filter((q) => q.tier === tier)) {
      const normalized = normalizeForSpeech(x.text);
      const id = idOf(x.text);
      used.add(id);
      base.push({
        id,
        text: x.text,
        normalized,
        style: x.style,
        speaker: STYLE_SPEAKER[x.style],
        direction: x.direction,
        priority: TIER_PRIORITY[tier],
        tier,
        kind: x.kind,
        source: x.source,
        estSeconds: Math.round(estimateSeconds(normalized, x.style) * 10) / 10,
      });
    }
  }
  const per = SESSION_AUDIO_MIN * 60;
  const sess = { ...assignSessions(base, 'pilot', 'P', 6 * 60, 2), ...assignSessions(base, 'core', 'C', per), ...assignSessions(base, 'extended', 'E', per) };
  const lines: ScriptLine[] = base.map((l) => ({ ...l, session: sess[l.id] }));
  // order: tier, session number, style order inside the session, then source (so similar lines sit together), then id
  const sn = (s: string) => Number(s.slice(1));
  lines.sort((a, b) => a.priority - b.priority || sn(a.session) - sn(b.session) || (a.tier === 'extended' ? 0 : (STYLE_ORDER.get(a.style)! - STYLE_ORDER.get(b.style)!)) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || (a.id < b.id ? -1 : 1));
  return lines;
}

export interface Summary {
  tier: Tier;
  lines: number;
  minutes: number;
  perStyle: Record<string, number>;
  perSpeaker: Record<number, number>;
}

export function summarize(lines: ScriptLine[]): Summary[] {
  return (['pilot', 'core', 'extended'] as Tier[]).map((tier) => {
    const l = lines.filter((x) => x.tier === tier);
    const perStyle: Record<string, number> = {};
    const perSpeaker: Record<number, number> = {};
    for (const x of l) {
      perStyle[x.style] = (perStyle[x.style] ?? 0) + 1;
      perSpeaker[x.speaker] = (perSpeaker[x.speaker] ?? 0) + 1;
    }
    return { tier, lines: l.length, minutes: Math.round((l.reduce((a, x) => a + x.estSeconds, 0) / 60) * 10) / 10, perStyle, perSpeaker };
  });
}

export function toMarkdown(lines: ScriptLine[]): string {
  const sums = summarize(lines);
  const out: string[] = [];
  out.push('# Claudeball announcer: recording script', '');
  out.push('_Generated by `npm run announcer:script` from the game\'s own vocabulary. Read the **bold** text out loud; the grey text is how the game writes it. Do not read the direction; do what it says._', '');
  out.push('| set | lines | est. audio | sessions |', '|---|---:|---:|---|');
  const tierSessions = (t: Tier) => [...new Set(lines.filter((l) => l.tier === t).map((l) => l.session))].join(', ');
  for (const s of sums) out.push(`| ${s.tier.toUpperCase()} | ${s.lines} | ${s.minutes} min | ${tierSessions(s.tier)} |`);
  out.push('', 'Styles: **calm** easy descriptive, **building** rising tension, **excited**, **peak** the big call, **deadpan** dry colour commentary, **crisp** PA / umpire, **deflated** the groan.', '');
  let session = '';
  for (const l of lines) {
    if (l.session !== session) {
      session = l.session;
      const sl = lines.filter((x) => x.session === session);
      const mins = Math.round(sl.reduce((a, x) => a + x.estSeconds, 0) / 6) / 10;
      out.push('', `## Session ${session}  (${l.tier}, ${sl.length} lines, about ${mins} min of audio)`, '');
    }
    out.push(`- \`${l.id}\` _${l.style}_ **${l.normalized}**${l.normalized !== l.text ? `  <sub>(${l.text})</sub>` : ''}  \n  <sub>${l.direction}</sub>`);
  }
  return out.join('\n') + '\n';
}

export function writeAll(outDir = path.join(here, 'data')): ScriptLine[] {
  const lines = buildScript();
  fs.mkdirSync(outDir, { recursive: true });
  const j = (ls: ScriptLine[]) => ls.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'all.jsonl'), j(lines));
  for (const t of ['pilot', 'core', 'extended'] as Tier[]) fs.writeFileSync(path.join(outDir, `${t}.jsonl`), j(lines.filter((l) => l.tier === t)));
  fs.writeFileSync(path.join(here, 'SCRIPT.md'), toMarkdown(lines));
  return lines;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const lines = writeAll();
  for (const s of summarize(lines)) console.log(`${s.tier.padEnd(8)} ${String(s.lines).padStart(5)} lines  ${String(s.minutes).padStart(6)} min  styles ${JSON.stringify(s.perStyle)}  speakers ${JSON.stringify(s.perSpeaker)}`);
}

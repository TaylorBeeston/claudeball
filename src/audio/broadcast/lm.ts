/**
 * Optional tiny language model for the colour voice (EXPERIMENTAL, off by default, nothing in the default experience depends on it).
 *
 * This file is the pure part: the compact facts a prompt carries, the prompt itself, and the validator that decides whether a model's
 * line may be spoken. A line is only used when every number and name in it is in the facts, it is not repetitive, and it contains no
 * wrong pronouns (players are he / him / his); anything else falls back instantly to the template grammar (`stories.ts`). See the README for the evaluation.
 */
import type { BoothCtx } from './ctx';
import { lastNameOf } from './ctx';
import type { GameLog } from './gamelog';
import { pitchName } from '../commentary';
import { wordCount } from './text';

export interface LmFacts {
  situation: string;
  outs: number;
  count: string;
  runners: string;
  score: string;
  batter?: { name: string; bats: string; tonight: string; power?: number; speed?: number };
  pitcher?: { name: string; throws: string; pitches: number; strikeouts: number; hits: number; walks: number; mix: string };
  thisAtBat: string[];
  lastPlay?: string;
  recentLines: string[];
}

const pct = (a: number, b: number) => Math.round((a / Math.max(1, b)) * 100);

/** the compact facts for a prompt (a few hundred characters: prefill is the budget problem on small devices) */
export function factsFor(c: BoothCtx, log: GameLog, recentLines: string[]): LmFacts {
  const bat = c.batter;
  const pit = c.pitcher;
  const mix = pit ? log.mix(pit.id) : null;
  const names = ['first', 'second', 'third'];
  const on = c.runners.map((r, i) => (r ? names[i] : '')).filter(Boolean);
  const bl = bat?.bat;
  return {
    situation: `${c.half} of the ${c.inning}`,
    outs: c.outs,
    count: `${c.balls}-${c.strikes}`,
    runners: on.length ? on.join(' and ') : 'none',
    score: `${c.teams.away} ${c.score.away}, ${c.teams.home} ${c.score.home}`,
    batter: bat ? { name: lastNameOf(bat.name), bats: bat.hand === 'L' ? 'left' : bat.hand === 'R' ? 'right' : 'switch', tonight: bl ? `${bl.h}-for-${bl.ab}${bl.hr ? `, ${bl.hr} HR` : ''}${bl.so ? `, ${bl.so} K` : ''}` : 'no at-bats yet', power: bat.ratings?.power === undefined ? undefined : Math.round(bat.ratings.power / 5) * 5, speed: bat.ratings?.speed === undefined ? undefined : Math.round(bat.ratings.speed / 5) * 5 } : undefined,
    pitcher: pit
      ? {
          name: lastNameOf(pit.name), throws: pit.hand === 'L' ? 'left' : 'right', pitches: pit.pit?.pitches ?? 0, strikeouts: pit.pit?.so ?? 0, hits: pit.pit?.h ?? 0, walks: pit.pit?.bb ?? 0,
          mix: mix && mix.total ? Object.entries(mix.by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${pitchName(t)} ${pct(n, mix.total)}%`).join(', ') : 'none yet',
        }
      : undefined,
    thisAtBat: log.pitchesInPa().map((p) => `${pitchName(p.type)} ${p.mph}${p.result ? ' ' + p.result : ''}`),
    lastPlay: c.lastPlay,
    recentLines: recentLines.slice(-3),
  };
}

export const STYLE_GUIDE =
  'You are the colour analyst in a baseball TV booth, chatting with the play-by-play announcer. Say ONE short, natural remark (8 to 25 words) about what is happening. ' +
  'Use ONLY the facts in the JSON: never invent a name, a number, a stat or an event. Do not use he, she, his or her for players: use their last name. ' +
  'Do not repeat the recent lines. No emoji, no quotation marks. Reply with the remark only.';

export function buildPrompt(f: LmFacts): { system: string; user: string } {
  return { system: STYLE_GUIDE, user: JSON.stringify(f) };
}

const SMALL = ['no', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
/** players are all he / him / his; any other gendered word for a player is wrong */
const PRON = /\b(she|her|hers|herself)\b/i;
const COMMON_CAPS = new Set(['I', 'The', 'A', 'An', 'That', 'This', 'It', 'Strike', 'Ball', 'Fastball', 'Slider', 'Curveball', 'Changeup', 'Cutter', 'Sinker', 'Sweeper', 'Splitter', 'Two', 'One', 'Three', 'Home', 'Run', 'First', 'Second', 'Third', 'Top', 'Bottom', 'Full', 'And', 'But', 'So', 'With', 'On', 'In', 'At', 'No', 'Not', 'Good', 'Great', 'Nice', 'Oh', 'Wow', 'Well', 'Yes', 'Right']);

export interface Verdict {
  ok: boolean;
  reason?: string;
}

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
const jaccard = (a: string, b: string) => {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  let i = 0;
  for (const t of x) if (y.has(t)) i++;
  return i / Math.max(1, x.size + y.size - i);
};

/** may this model line be spoken? every number and name must come from the facts */
export function validateLine(text: string, f: LmFacts): Verdict {
  const t = text.trim();
  const words = wordCount(t);
  if (words < 4) return { ok: false, reason: 'too short' };
  if (words > 36) return { ok: false, reason: 'too long' };
  if ((t.match(/[.!?]+(\s|$)/g) ?? []).length > 3) return { ok: false, reason: 'too many sentences' };
  if (PRON.test(t)) return { ok: false, reason: 'pronoun' };
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t) || /https?:|www\./i.test(t) || /["`*#{}[\]<>]/.test(t)) return { ok: false, reason: 'symbols' };
  if (/\bas an? (ai|language model)\b/i.test(t)) return { ok: false, reason: 'meta' };
  const factsText = JSON.stringify(f);
  const allowedNums = new Set<number>((factsText.match(/\d+/g) ?? []).map(Number));
  for (const n of [...allowedNums]) {
    if (SMALL[n]) allowedNums.add(n);
  }
  // numbers written as digits
  for (const m of t.match(/\d+/g) ?? []) if (!allowedNums.has(Number(m))) return { ok: false, reason: `number ${m} not in the facts` };
  // numbers written as words
  const numWords = new Set<string>();
  for (const n of allowedNums) {
    if (SMALL[n]) numWords.add(SMALL[n]);
    if (ORD[n]) numWords.add(ORD[n]);
  }
  for (const w of tokens(t)) {
    const si = SMALL.indexOf(w);
    if (si >= 2 && !numWords.has(w) && !(si <= 3 && /(outs?|count)/.test(factsText))) return { ok: false, reason: `number word "${w}" not in the facts` };
    const oi = ORD.indexOf(w);
    if (oi >= 1 && !numWords.has(w) && !numWords.has(SMALL[oi] ?? '')) return { ok: false, reason: `ordinal "${w}" not in the facts` };
  }
  // names: capitalised words that are not at the start of a sentence must be names or teams from the facts
  const allowedNames = new Set<string>();
  for (const part of [f.batter?.name, f.pitcher?.name, f.score]) for (const w of String(part ?? '').split(/[\s,]+/)) if (w && /^[A-Z]/.test(w)) allowedNames.add(w);
  for (const sentence of t.split(/(?<=[.!?])\s+/)) {
    const ws = sentence.split(/\s+/);
    for (let i = 1; i < ws.length; i++) {
      const w = ws[i].replace(/[^A-Za-z']/g, '');
      if (/^[A-Z][a-z]/.test(w) && !allowedNames.has(w.replace(/'s$/, '')) && !COMMON_CAPS.has(w)) return { ok: false, reason: `name "${w}" not in the facts` };
    }
  }
  for (const r of f.recentLines) if (jaccard(t, r) >= 0.6) return { ok: false, reason: 'repeats a recent line' };
  return { ok: true };
}

// ---- the plumbing (behind a flag) -------------------------------------------------------------------------------------------

/** model used when the experiment is switched on (`?lm=1`); see the README for why it is not recommended */
export const LM_MODEL = { id: 'onnx-community/LFM2-700M-ONNX', dtype: 'q4' } as const;

export interface LmSource {
  /** a validated line ready to be said by the colour voice, or null (the template grammar then speaks instead, instantly) */
  take(): string | null;
  /** start generating the next line for these facts (ignored while a generation is running) */
  prepare(f: LmFacts): void;
}

export interface LmClientOpts {
  /** the model call: system + user prompt in, text out (a worker in the app, a fake in tests) */
  generate(system: string, user: string): Promise<string>;
  now?: () => number;
  /** give up on a generation after this long (ms) */
  budgetMs?: number;
  /** a ready line is dropped after this long (the game has moved on) */
  staleMs?: number;
}

/**
 * Precomputes the next colour line while the game is busy, validates it, and hands it over only when it is good; never blocks speech.
 * Any failure, late answer or invalid line is dropped silently (the template grammar speaks instead).
 */
export class LmColour implements LmSource {
  readonly stats = { asked: 0, ok: 0, rejected: 0, late: 0, failed: 0, reasons: {} as Record<string, number> };
  private busy = false;
  private ready: { text: string; at: number } | null = null;
  private now: () => number;

  constructor(private o: LmClientOpts) {
    this.now = o.now ?? (() => performance.now());
  }

  prepare(f: LmFacts) {
    if (this.busy || this.ready) return;
    this.busy = true;
    this.stats.asked++;
    const t0 = this.now();
    const p = buildPrompt(f);
    this.o
      .generate(p.system, p.user)
      .then((raw) => {
        const text = raw.trim().replace(/^["'“”]+|["'“”]+$/g, '');
        const late = this.now() - t0 > (this.o.budgetMs ?? 8000);
        const v = validateLine(text, f);
        if (late) this.stats.late++;
        if (!v.ok) {
          this.stats.rejected++;
          const k = (v.reason ?? '?').replace(/".*"|\d+/g, '#');
          this.stats.reasons[k] = (this.stats.reasons[k] ?? 0) + 1;
        } else if (!late) {
          this.stats.ok++;
          this.ready = { text, at: this.now() };
        }
      })
      .catch(() => {
        this.stats.failed++;
      })
      .finally(() => {
        this.busy = false;
      });
  }

  take(): string | null {
    const r = this.ready;
    this.ready = null;
    if (!r) return null;
    return this.now() - r.at <= (this.o.staleMs ?? 30000) ? r.text : null;
  }
}

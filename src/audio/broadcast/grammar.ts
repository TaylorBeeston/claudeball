/**
 * A tiny text grammar for the booth's wording.
 *
 *   {a|b|c}     pick one (may nest: {well, {that|this} is|so})
 *   [text]      optional (about half the time; may contain choices)
 *   $name       a slot filled from the facts; a template whose slot is missing yields null (never an invented fact)
 *
 * Deterministic for a given rng. `expand` also tidies the result (spacing, a capital first letter).
 */
export type Slots = Record<string, string | number | undefined | null>;

type Node = { t: 'lit'; v: string } | { t: 'slot'; v: string } | { t: 'choice'; v: Node[][] } | { t: 'opt'; v: Node[] };

function parse(src: string): Node[] {
  let i = 0;
  const seq = (stop: string): Node[] => {
    const out: Node[] = [];
    let lit = '';
    const flush = () => {
      if (lit) out.push({ t: 'lit', v: lit });
      lit = '';
    };
    while (i < src.length) {
      const ch = src[i];
      if (stop.includes(ch)) break;
      if (ch === '{') {
        flush();
        i++;
        const alts: Node[][] = [seq('|}')];
        while (src[i] === '|') {
          i++;
          alts.push(seq('|}'));
        }
        i++; // }
        out.push({ t: 'choice', v: alts });
      } else if (ch === '[') {
        flush();
        i++;
        const inner = seq(']');
        i++;
        out.push({ t: 'opt', v: inner });
      } else if (ch === '$') {
        flush();
        i++;
        let name = '';
        while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) name += src[i++];
        out.push({ t: 'slot', v: name });
      } else {
        lit += ch;
        i++;
      }
    }
    flush();
    return out;
  };
  return seq('');
}

const cache = new Map<string, Node[]>();

/** Expand a template; null when a slot it uses has no value. */
export function expand(template: string, slots: Slots, rng: () => number): string | null {
  let ast = cache.get(template);
  if (!ast) cache.set(template, (ast = parse(template)));
  let missing = false;
  const run = (nodes: Node[]): string =>
    nodes
      .map((n) => {
        if (n.t === 'lit') return n.v;
        if (n.t === 'slot') {
          const v = slots[n.v];
          if (v === undefined || v === null || v === '') {
            missing = true;
            return '';
          }
          return String(v);
        }
        if (n.t === 'choice') return run(n.v[Math.floor(rng() * n.v.length)]);
        return rng() < 0.5 ? run(n.v) : '';
      })
      .join('');
  const raw = run(ast);
  if (missing) return null;
  return tidy(raw);
}

export function tidy(s: string): string {
  let t = s.replace(/\s+/g, ' ').replace(/\s+([,.!?;:…])/g, '$1').replace(/([,.!?;:])\1+/g, '$1').replace(/,\s*([.!?])/g, '$1').trim();
  t = t.replace(/(^|[.!?…]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  return t;
}

/** Number of distinct strings a template can produce (upper bound; slots count as one). */
export function variants(template: string): number {
  let ast = cache.get(template);
  if (!ast) cache.set(template, (ast = parse(template)));
  const count = (nodes: Node[]): number => nodes.reduce((a, n) => a * (n.t === 'choice' ? n.v.reduce((s, alt) => s + count(alt), 0) : n.t === 'opt' ? 1 + count(n.v) : 1), 1);
  return count(ast);
}

/** pick the first template (in random order) that expands */
export function say(templates: string[], slots: Slots, rng: () => number): string | null {
  const order = templates.map((t, i) => [rng(), i] as const).sort((a, b) => a[0] - b[0]);
  for (const [, i] of order) {
    const r = expand(templates[i], slots, rng);
    if (r) return r;
  }
  return null;
}

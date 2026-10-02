/**
 * Text normaliser for the custom announcer voice: turns what the game writes ("Now batting, number 23", "6-4-3", "94 miles an hour",
 * ".241") into what a person says out loud. The recording script, the training metadata and the in-game synthesiser all go through this
 * one function, so the model hears at run time exactly the kind of text it was trained on. Pure, no DOM, no dependencies.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORD_ONES = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];
const ORD_TENS = ['', '', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];

/** 0..99 as words ("ninety-four"). */
function under100(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
}

/** Cardinal number in words: 94 -> "ninety-four", 412 -> "four hundred and twelve", 1500 -> "one thousand five hundred". */
export function cardinal(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  n = Math.floor(n);
  if (n < 100) return under100(n);
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return r ? `${ONES[h]} hundred and ${under100(r)}` : `${ONES[h]} hundred`;
  }
  if (n < 1_000_000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    const head = `${cardinal(th)} thousand`;
    if (!r) return head;
    return r < 100 ? `${head} and ${under100(r)}` : `${head} ${cardinal(r)}`;
  }
  return String(n).split('').map((d) => ONES[Number(d)]).join(' ');
}

/** Ordinal in words: 9 -> "ninth", 21 -> "twenty-first". */
export function ordinalWord(n: number): string {
  n = Math.floor(n);
  if (n < 20) return ORD_ONES[n] ?? String(n);
  if (n < 100) {
    const o = n % 10;
    return o ? `${TENS[Math.floor(n / 10)]}-${ORD_ONES[o]}` : ORD_TENS[Math.floor(n / 10)];
  }
  const c = cardinal(n);
  return `${c}th`;
}

/** Digits read one at a time: "643" -> "six four three". */
const digitWords = (s: string) => s.split('').map((d) => ONES[Number(d)]).join('-');

/** Batting-average style: ".241" -> "two forty-one", ".300" -> "three hundred", ".305" -> "three-oh-five", ".075" -> "oh seventy-five". */
export function averageWords(three: string): string {
  const a = Number(three[0]);
  const rest = Number(three.slice(1));
  if (a === 0) return rest === 0 ? 'zero' : `oh ${under100(rest)}`;
  if (rest === 0) return `${ONES[a]} hundred`;
  if (rest < 10) return `${ONES[a]}-oh-${ONES[rest]}`;
  return `${ONES[a]} ${under100(rest)}`;
}

/** Abbreviations the game or a broadcast would say as words or letters. Keys are matched case-sensitively as whole tokens. */
const ABBREV: Record<string, string> = {
  'Jr.': 'junior', 'Sr.': 'senior', mph: 'miles an hour', ERA: 'E R A', RBI: 'R B I', RBIs: 'R B I', HR: 'home run', HRs: 'home runs',
  OPS: 'O P S', OBP: 'on base percentage', 'vs.': 'versus', 'St.': 'Saint', 'Mt.': 'Mount', IBB: 'intentional walk', DH: 'D H',
  '1B': 'first base', '2B': 'second base', '3B': 'third base', SS: 'shortstop', LF: 'left field', CF: 'center field', RF: 'right field',
};

/** Three-letter team abbreviations are spelled out ("POR" -> "P O R"). */
const spell = (s: string) => s.split('').join(' ');

/** Normalise one string for speech. Idempotent on already-spoken text. */
export function normalizeForSpeech(input: string): string {
  let s = input.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/–|—/g, ', ');
  // ordinals "9th" "21st"
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, d: string) => ordinalWord(Number(d)));
  // fielder chains "6-4-3", "5-3", "1-3": digit by digit
  s = s.replace(/\b(\d)(?:-(\d)){1,3}\b/g, (m) => m.split('-').map((d) => ONES[Number(d)]).join('-'));
  // averages ".241" / "0.241" (exactly three decimals) and 1.000
  s = s.replace(/(^|[^\d])0?\.(\d{3})\b/g, (_m, pre: string, d: string) => `${pre}${averageWords(d)}`);
  s = s.replace(/\b1\.000\b/g, 'one thousand');
  // ERA-like "3.45" (two decimals): "three forty-five"; one decimal "94.5": "ninety-four point five"
  s = s.replace(/\b(\d+)\.(\d{2})\b/g, (_m, i: string, d: string) => `${cardinal(Number(i))} ${d[0] === '0' ? `oh ${ONES[Number(d[1])]}` : under100(Number(d))}`);
  s = s.replace(/\b(\d+)\.(\d)\b/g, (_m, i: string, d: string) => `${cardinal(Number(i))} point ${ONES[Number(d)]}`);
  // percentages and "N-for-M" stat lines
  s = s.replace(/(\d+)\s?%/g, (_m, d: string) => `${cardinal(Number(d))} percent`);
  s = s.replace(/\b(\d+)-for-(\d+)\b/g, (_m, a: string, b: string) => `${cardinal(Number(a))} for ${cardinal(Number(b))}`);
  // plain numbers, with thousands separators
  s = s.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => cardinal(Number(m.replace(/,/g, ''))));
  s = s.replace(/\b\d+\b/g, (m) => cardinal(Number(m)));
  // abbreviations and spelled-out letters
  s = s.replace(/\b(?:Jr|Sr|vs|St|Mt)\./g, (m) => ABBREV[m]);
  s = s.replace(/\b[A-Za-z0-9]+\b/g, (m) => ABBREV[m] ?? m);
  s = s.replace(/\b[A-Z]{3}\b/g, spell);
  s = s.replace(/&/g, ' and ');
  // the sim says "flies out to pitcher" / "an error by shortstop": a person says "the"
  s = s.replace(/\b(to|by|toward|from) (pitcher|catcher|first baseman|second baseman|third baseman|shortstop|left fielder|center fielder|right fielder)\b/g, '$1 the $2');
  // tidy
  return s.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

/** Words of a normalised string, lower-cased, punctuation stripped (apostrophes and hyphens inside words stay). */
export function wordsOf(normalized: string): string[] {
  return normalized.toLowerCase().match(/[a-z]+(?:['-][a-z]+)*/g) ?? [];
}

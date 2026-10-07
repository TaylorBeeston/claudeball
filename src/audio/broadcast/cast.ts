/**
 * The broadcast cast: the two booth voices and the stadium PA announcer. Fictional people (no real broadcaster's name, voice or catchphrase), with a
 * point of view the templates keep for the whole game: the play-by-play man calls it straight, loves his scorebook and the ballpark's history and
 * teases his partner; the analyst is a former backup catcher who sees the game through the catcher's mask, is quick to laugh at his own career and
 * now and then disagrees.
 *
 * Used by: the templates (names, how they address each other, catchphrases, running jokes), the captions (`label`), the voices (`voice`: the HD
 * Kokoro preset, a browser-voice hint, and which speakers of the owner's custom voice pack speak for the character).
 */
export type CastId = 'pbp' | 'color' | 'pa';

export interface CastMember {
  id: CastId;
  name: string;
  first: string;
  last: string;
  nickname?: string;
  /** the caption's speaker label */
  label: string;
  role: string;
  pronouns: { subject: string; object: string; possessive: string };
  bio: string;
  traits: string[];
  /** what the other booth voice calls him (first is the usual one) */
  calledBy: string[];
  voice: {
    /** Kokoro-82M preset for the HD voices (stable per character) */
    kokoro: string;
    /** which kind of browser voice `pickVoices` looks for first */
    browser: { prefer: 'male' | 'female' };
    /** the delivery (speech rate, pitch) every engine gets for his ordinary lines (excited lines go faster and higher) */
    delivery: { rate: number; pitch: number };
    /** the custom voice pack's speakers (see docs/announcer-voice.md: playbyplay / hype / color) that speak for him */
    packSpeakers: string[];
  };
}

export const CAST: Record<CastId, CastMember> = {
  pbp: {
    id: 'pbp',
    name: 'Lyle Pemberton',
    first: 'Lyle',
    last: 'Pemberton',
    label: 'LYLE',
    role: 'play-by-play',
    pronouns: { subject: 'he', object: 'him', possessive: 'his' },
    bio: 'Twenty-six seasons behind the microphone; keeps his own scorebook in pencil and knows every ballpark in the league.',
    traits: ['precise', 'dry wit', 'scorebook nerd', 'ballpark history buff', 'teases his partner about his playing days'],
    calledBy: ['Lyle'],
    voice: { kokoro: 'am_michael', browser: { prefer: 'male' }, delivery: { rate: 1.04, pitch: 1 }, packSpeakers: ['playbyplay', 'hype'] },
  },
  color: {
    id: 'color',
    name: 'Hollis "Biscuit" Dupree',
    first: 'Hollis',
    last: 'Dupree',
    nickname: 'Biscuit',
    label: 'BISCUIT',
    role: 'analyst',
    pronouns: { subject: 'he', object: 'him', possessive: 'his' },
    bio: 'Eleven seasons as a backup catcher for four clubs; a career .219 hitter who will tell you about every one of his home runs (there were nine).',
    traits: ['sees it from behind the plate', 'self-deprecating', 'loves pitch sequencing', 'not afraid to disagree', 'always hungry'],
    calledBy: ['Biscuit', 'Hollis'],
    voice: { kokoro: 'bm_george', browser: { prefer: 'male' }, delivery: { rate: 1.0, pitch: 1 }, packSpeakers: ['color'] },
  },
  pa: {
    id: 'pa',
    name: 'Clem Ashworth',
    first: 'Clem',
    last: 'Ashworth',
    label: 'PA',
    role: 'public address',
    pronouns: { subject: 'he', object: 'him', possessive: 'his' },
    bio: 'The voice of the ballpark: unhurried, booming, every name stretched out to the last syllable.',
    traits: ['booming', 'unhurried', 'formal'],
    calledBy: ['Clem'],
    voice: { kokoro: 'am_onyx', browser: { prefer: 'male' }, delivery: { rate: 0.92, pitch: 0.75 }, packSpeakers: ['playbyplay'] },
  },
};

/** the caption label of a speaker role ('pbp' -> 'LYLE'); unknown roles: undefined */
export function speakerLabel(speaker: string): string | undefined {
  return (CAST as Record<string, CastMember | undefined>)[speaker]?.label;
}

/** the display name of a speaker role ('pbp' -> 'Lyle Pemberton'); umpires and unknown roles: undefined */
export function speakerName(speaker: string): string | undefined {
  return (CAST as Record<string, CastMember | undefined>)[speaker]?.name;
}

/**
 * Signature phrases: said only on their trigger, at most `max` times a game and never within `cooldown` seconds of the last one, so they stay
 * special. `who` is the voice that owns the phrase.
 */
export interface Catchphrase {
  id: string;
  who: 'pbp' | 'color';
  trigger: 'homeRun' | 'strikeout' | 'doublePlay' | 'bigOut' | 'stolenBase' | 'walk' | 'endOfInning' | 'win';
  lines: string[];
  max: number;
  cooldown: number;
}

export const CATCHPHRASES: Catchphrase[] = [
  { id: 'lyle.hr', who: 'pbp', trigger: 'homeRun', lines: ['Pack a lunch, that one is going a long way!', 'Pack a lunch!'], max: 2, cooldown: 600 },
  { id: 'lyle.k', who: 'pbp', trigger: 'strikeout', lines: ['Sit down, son.', 'And he can go sit down.'], max: 2, cooldown: 900 },
  { id: 'lyle.dp', who: 'pbp', trigger: 'doublePlay', lines: ['Two for the price of one!', 'Two for one, and the shelves are empty.'], max: 1, cooldown: 900 },
  { id: 'lyle.win', who: 'pbp', trigger: 'win', lines: ['Put this one in the books.'], max: 1, cooldown: 0 },
  { id: 'bis.k', who: 'color', trigger: 'strikeout', lines: ['Mm-hmm. Biscuits and gravy.', 'That is biscuits and gravy right there.'], max: 1, cooldown: 900 },
  { id: 'bis.hr', who: 'color', trigger: 'homeRun', lines: ['That is a grown-man swing.', 'Grown-man swing.'], max: 2, cooldown: 600 },
  { id: 'bis.sb', who: 'color', trigger: 'stolenBase', lines: ['I would not have thrown him out either. Ask any pitcher I ever caught.'], max: 1, cooldown: 0 },
];

/**
 * Running jokes: a few lines that come back now and then during a game, each time a step further. A stage is used at most once a game; a joke waits
 * `gap` seconds between stages. Lines with $pbp / $color use the names; the trigger says what in the game makes the joke fit.
 */
export interface RunningJoke {
  id: string;
  trigger: 'slowInning' | 'catcherBats' | 'pitchingChange' | 'moundVisit' | 'lull' | 'stolenBase' | 'foodLull';
  gap: number;
  stages: { who: 'A' | 'B'; t: string[] }[][];
  /** which voice says A (B is the other one) */
  a: 'pbp' | 'color';
}

export const RUNNING_JOKES: RunningJoke[] = [
  {
    id: 'nineHomers',
    trigger: 'catcherBats',
    gap: 900,
    a: 'pbp',
    stages: [
      [
        { who: 'A', t: ['A catcher at the plate, $color. Takes you back.', 'Here is a catcher with a bat in his hands, $color. Any advice?'] },
        { who: 'B', t: ['Nine career home runs, $pbp. I remember every one of them, and so does my mother.', 'Swing hard in case you hit it. That was my whole plan for eleven years.'] },
      ],
      [
        { who: 'A', t: ['Another catcher up. Should I ask about the nine home runs?', 'Here comes another catcher, so I will brace myself for the home-run stories.'] },
        { who: 'B', t: ['Number six was a grand slam, $pbp. In my defense, the wind was blowing out.', 'You already asked. But number four was off a lefty, and nobody hit that lefty.'] },
        { who: 'A', t: ['The wind was blowing out. Of course it was.', 'Of course.'] },
      ],
    ],
  },
  {
    id: 'pressBoxFood',
    trigger: 'foodLull',
    gap: 1200,
    a: 'pbp',
    stages: [
      [
        { who: 'A', t: ['Somebody just brought a tray of sliders up to the booth. The kind you eat.', 'The press-box sliders have arrived, folks. The kind you eat.'] },
        { who: 'B', t: ['Do not look at me, $pbp. I am on a diet. Starting tomorrow.', 'I will be the judge of those, $pbp.'] },
      ],
      [
        { who: 'A', t: ['For the folks at home, the tray of sliders is now empty, and I had one.', 'Quick update on the sliders: there are none left.'] },
        { who: 'B', t: ['That is called a scouting report, $pbp. Somebody had to do it.', 'Quality control. It is part of the job.'] },
      ],
    ],
  },
  {
    id: 'biscuitName',
    trigger: 'lull',
    gap: 1500,
    a: 'pbp',
    stages: [
      [
        { who: 'A', t: ['We have a question from a young fan, $color: why do they call you Biscuit?', 'Somebody asked me again why they call you Biscuit.'] },
        { who: 'B', t: ['Double-A, a Sunday doubleheader, and a basket of buttermilk biscuits. I ate eleven between games, $pbp. Went oh for eight.', 'I ate eleven biscuits between games of a doubleheader in Double-A. Went oh for eight. The name stuck, the average did not.'] },
        { who: 'A', t: ['Oh for eight. And they still remember the biscuits.', 'A legend was born.'] },
      ],
    ],
  },
  {
    id: 'throwingOut',
    trigger: 'stolenBase',
    gap: 900,
    a: 'color',
    stages: [
      [
        { who: 'A', t: ['Tough to throw that guy out. Believe me, I know.', 'I threw out about one in five in my career, $pbp. That one was not going to be the one.'] },
        { who: 'B', t: ['One in five is generous, from what I have read.', 'I have the numbers here, and I will keep them to myself.'] },
      ],
    ],
  },
];

/** fictional park promotions and features the booth may mention in long lulls (the park and the mascot are the game's own) */
export const PROMOS: string[] = [
  'Kids run the bases after the game today, so stick around.',
  'It is two-dollar hot dog night at $park, and judging by the line, word got out.',
  '$mascot has been working the crowd behind the home dugout all night.',
  'The dot race is coming up on the big board in a couple of innings, and $color has a favourite.',
  'Fireworks after the game tonight, weather permitting.',
  'Somebody proposed on the big board last inning. The crowd is taking credit for the yes.',
];

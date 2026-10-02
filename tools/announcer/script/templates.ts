/**
 * Every hand-written template. Sources are the game's own speech (src/audio/cues.ts: umpireText/umpireCallText, PA lines, commentary;
 * src/sim/rules.ts: play descriptions) plus the broadcast lines the commentary thread is adding (pitch / count / situation / stats /
 * replays / recaps). When src/audio grows new lines, add templates here and re-run `npm run announcer:script`.
 *
 * `n` = [pilot, core, extended] instances. Slots (`{name}`, `{mph}`, ...) are filled by slots.ts.
 */
import { BOOTH_TEMPLATES } from './templates-booth';
import type { Template } from './types';

// cadence directions, reused
const D = {
  pa: 'PA voice: formal, even, a touch slow; let the last word fall.',
  paName: 'PA voice: even, then lean on the name and let it fall.',
  umpSharp: 'Sharp and short, from the chest. No melody.',
  umpBig: 'Big and punched, hold the vowel: stuhr-IIIKE.',
  calm: 'Easy, conversational; fall slightly on the last word.',
  calmPlay: 'Describe it plainly; drop on the final word like a period.',
  calmRun: 'Keep it moving; light stress on the verb, tail off.',
  pitch: 'Lean on the pitch name, then clip the speed and location, flat.',
  swing: "Drop low and slow on 'swing and a miss', then a short punch on the call.",
  build: 'Start low and rising; lift the pitch through the line, stress the last word.',
  buildHit: 'Rise from the contact word, speed up, land high and open on the end.',
  hit: 'Lift on the verb, stretch the vowel in the result word, rise on the last word.',
  exc: 'Bright and loud; stretch the key vowel and rise on the last word.',
  big: 'Big voice, stretch the vowels, rising excitement all the way to the last word.',
  peakHr: "Start rising; stretch the vowel on 'gone' (gooone), rise on the last word and hold it.",
  peakCatch: 'Breathless and quick, then a gasp of disbelief on the key word.',
  plateClose: 'Quick staccato; the safe or out call is a punch, then a beat of release.',
  deflate: 'Drop energy all the way down; sigh into it and let the last word sink.',
  color: 'Dry and a little amused, like thinking out loud. Almost no rise.',
  stat: 'Flat, matter-of-fact. Numbers crisp, last word falls.',
  replay: 'Easy, explanatory; slow on the detail, let the last word hang.',
  recap: 'Settled and warm; steady rhythm, drop at each full stop.',
  chat: 'Relaxed and a bit wry, like a tangent in the booth; land every sentence soft.',
  sentence: 'Plain, natural reading, mid pace. No performance.',
  number: 'Say it clearly with the broadcast fall at the end.',
  name: 'Clear and full, the way a PA announcer says the name, a little drop at the end.',
};

export const TEMPLATES: Template[] = [
  // ---------------------------------------------------------------- umpire (cues.ts umpireText / umpireCallText)
  { id: 'ump-strike', kind: 'umpire', style: 'crisp', direction: D.umpBig, n: [3, 4, 1], text: ['Strike!', 'Strike one!', 'Strike two!', 'Strike three!', 'Steeeerike!'] },
  { id: 'ump-ball', kind: 'umpire', style: 'crisp', direction: D.umpSharp, n: [2, 3, 1], text: ['Ball!', 'Ball one.', 'Ball two.', 'Ball three.'] },
  { id: 'ump-ball-four', kind: 'umpire', style: 'crisp', direction: D.umpSharp, n: [1, 1, 1], text: ['Ball four!'] },
  { id: 'ump-foul', kind: 'umpire', style: 'crisp', direction: D.umpBig, n: [2, 2, 1], text: ['Foul ball!', 'Foul!', 'Foul tip!'] },
  { id: 'ump-safe-out', kind: 'umpire', style: 'crisp', direction: D.umpBig, n: [3, 4, 1], text: ['Safe!', "You're out!", 'Out!', 'Safe at second!', 'Out at first!', 'He is out!'] },
  { id: 'ump-misc', kind: 'umpire', style: 'crisp', direction: D.umpSharp, n: [2, 4, 1], text: ['Time!', 'Time, please.', 'Play ball!', 'Take your base!', 'Infield fly! Batter is out!', 'Balk!', "That's a balk.", 'Fair ball!', 'Home run!', 'Check swing, he went!', "He didn't go."] },
  { id: 'ump-count', kind: 'umpire', style: 'crisp', direction: D.umpSharp, n: [0, 2, 1], text: ['Count is {count}, {outs}.', 'Two out, {count}.'] },

  // ---------------------------------------------------------------- PA (cues.ts)
  { id: 'pa-welcome', kind: 'pa', style: 'crisp', direction: D.pa, n: [1, 3, 1], text: ['Ladies and gentlemen, welcome to Claudeball. Tonight, the {team} visit the {team2}.'] },
  { id: 'pa-batting', kind: 'pa', style: 'crisp', direction: D.paName, n: [8, 22, 20], text: ['Now batting, number {jersey}, {name}.'] },
  { id: 'pa-pitching', kind: 'pa', style: 'crisp', direction: D.paName, n: [4, 12, 12], text: ['Now pitching, number {jersey}, {name}.'] },
  { id: 'pa-lineup', kind: 'pa', style: 'crisp', direction: D.paName, n: [0, 8, 8], text: ['Batting {ord}, the {pos}, number {jersey}, {name}.', 'Leading off, the {pos}, number {jersey}, {name}.', 'Now pitching for the {team}, number {jersey}, {name}.'] },
  { id: 'pa-misc', kind: 'pa', style: 'crisp', direction: D.pa, n: [1, 3, 2], text: ['Ladies and gentlemen, please rise for the national anthem.', 'Ladies and gentlemen, please stand for the seventh-inning stretch.', 'Thank you for coming out tonight. Drive home safely.', 'Your attention please, the {team2} have made a pitching change.'] },

  // ---------------------------------------------------------------- play results (sim rules.ts descriptions), calm
  { id: 'res-strikeout', kind: 'playbyplay', style: 'calm', direction: D.swing, n: [3, 14, 4], text: ['{name} strikes out swinging.', '{name} strikes out looking.', 'And {name} strikes out swinging, {pitch} {loc}.'] },
  { id: 'res-strikeout-odd', kind: 'playbyplay', style: 'calm', direction: D.calmPlay, n: [1, 3, 2], text: ['{name} strikes out and is thrown out at first.', '{name} strikes out but reaches on the dropped third strike.'] },
  { id: 'res-walk', kind: 'playbyplay', style: 'calm', direction: D.calmRun, n: [2, 6, 3], text: ['{name} walks.', '{name} is intentionally walked.', '{name} takes ball four and walks to first.'] },
  { id: 'res-hbp', kind: 'playbyplay', style: 'calm', direction: D.calmRun, n: [1, 3, 2], text: ['{name} is hit by the pitch.', '{name} takes one on the arm and heads to first.'] },
  { id: 'res-balk', kind: 'playbyplay', style: 'calm', direction: D.calmRun, n: [1, 2, 1], text: ['Balk called on {name}.', 'The umpire calls a balk and the runners move up.'] },
  { id: 'res-flyout', kind: 'playbyplay', style: 'calm', direction: D.calmPlay, n: [3, 12, 4], text: ['{name} flies out to {pos}.', '{name} lines out to {pos}.', '{name} pops out to {pos}.', '{name} pops out on an infield fly to {pos}.', '{name} flies out to {field}.'] },
  { id: 'res-groundout', kind: 'playbyplay', style: 'calm', direction: D.calmPlay, n: [3, 12, 4], text: ['{name} grounds out, {chain}.', '{name} grounds out, {chain}.'] },
  { id: 'res-gidp', kind: 'playbyplay', style: 'building', direction: D.buildHit, n: [2, 8, 3], text: ['{name} grounds into a double play, {chain}.', 'And a double play! {chain}, the inning is over.', '{name} hits into a double play, {chain}.'] },
  { id: 'res-sac', kind: 'playbyplay', style: 'calm', direction: D.calmPlay, n: [1, 4, 2], text: ['{name} lays down a sacrifice bunt, {chain}.', '{name} hits a sacrifice fly to {pos}; 1 run scores.', '{name} hits a sacrifice fly to {pos}; 2 runs score.'] },
  { id: 'res-single', kind: 'playbyplay', style: 'building', direction: D.buildHit, n: [3, 14, 5], text: ['{name} singles {spray}.', '{name} singles {spray}; 1 run scores.', '{name} singles {spray}; 2 runs score.', 'Base hit! {name} singles {spray}.'] },
  { id: 'res-double', kind: 'playbyplay', style: 'excited', direction: D.hit, n: [2, 12, 4], text: ['{name} doubles {spray}.', '{name} doubles {spray}; 1 run scores.', '{name} doubles {spray}; 2 runs score.', '{name} hits a ground-rule double.'] },
  { id: 'res-triple', kind: 'playbyplay', style: 'excited', direction: D.hit, n: [1, 8, 3], text: ['{name} triples {spray}.', '{name} triples {spray}; 1 run scores.', '{name} triples {spray}; 2 runs score.'] },
  { id: 'res-homer', kind: 'playbyplay', style: 'peak', direction: D.peakHr, n: [3, 12, 4], text: ['{name} homers {spray}.', '{name} homers {spray}, 2 runs score.', '{name} homers {spray}, 3 runs score.', '{name} homers {spray}, 4 runs score.'] },
  { id: 'res-error-fc', kind: 'playbyplay', style: 'deflated', direction: D.deflate, n: [1, 6, 3], text: ['{name} reaches on an error by {pos}.', "{name} reaches on a fielder's choice, {chain}.", 'Oh, and that is booted by the {pos}.'] },
  { id: 'res-steal', kind: 'playbyplay', style: 'building', direction: D.plateClose, n: [2, 8, 3], text: ['{name} steals second.', '{name} steals third.', '{name} steals home.', '{name} is out trying to steal.', '{name} advances on the wild pitch.', '{name} advances on the passed ball.'] },
  { id: 'res-score', kind: 'playbyplay', style: 'calm', direction: D.recap, n: [1, 4, 2], text: ['{name} singles {spray}; 1 run scores. {team} {hi}, {team2} {lo}.', '{name} doubles {spray}; 2 runs score. {team} {hi}, {team2} {lo}.', '{name} homers {spray}, 2 runs score. {team} {hi}, {team2} {lo}.'] },

  // ---------------------------------------------------------------- live calls: pitch by pitch (calm -> building)
  { id: 'call-pitch', kind: 'playbyplay', style: 'calm', direction: D.pitch, n: [5, 18, 8], text: ['{pitch}, {mph}, {loc}.', '{pitch}, {loc}, strike one.', '{mph} miles an hour, {loc}.', 'The {pitch}, {loc}, ball two.', 'Swung on and missed, {pitch}, {mph}.', 'Taken for a ball, {pitch} {loc}.'] },
  { id: 'call-pitch-count', kind: 'playbyplay', style: 'calm', direction: D.calmRun, n: [3, 12, 5], text: ['{name} digs in, the count is {count}.', 'The {count} pitch... {pitch}, {loc}.', "Here's the {count} pitch to {name}.", '{outs}, {count}, and the {pitch} is on the way.'] },
  { id: 'call-foul', kind: 'playbyplay', style: 'calm', direction: D.calmRun, n: [1, 9, 3], text: ['Fouled back, {pitch}, {loc}.', 'Fouled off, and the count stays {count}.', 'Straight back to the screen, foul ball.', 'Down the line, fouled away.'] },
  { id: 'call-swing', kind: 'playbyplay', style: 'building', direction: D.swing, n: [3, 14, 4], text: ['Swing and a miss! Strike three!', 'Swing and a miss! {pitch}, {mph}, {loc}.', 'He swings and misses, and {name} is on his way back to the dugout.', 'Called strike three! {name} cannot believe it.', 'Chased the {pitch} {loc}, and strikes him out!'] },
  { id: 'call-walk', kind: 'playbyplay', style: 'calm', direction: D.calmRun, n: [1, 6, 2], text: ['Ball four, {pitch} {loc}, and {name} will take his base.', 'He could not find the zone, and that is a walk.'] },
  // contact in play
  { id: 'call-contact', kind: 'playbyplay', style: 'building', direction: D.buildHit, n: [3, 12, 5], text: ['A fly ball to {field}...', 'A ground ball to the {pos}...', 'A line drive to {field}!', 'Hit in the air to {field}, the {pos} going back.', 'Chopper toward the {pos}, he has it, throws to first... out.', 'Fly ball to the {pos}, he is under it, and he makes the catch.'] },
  { id: 'call-ball-hit', kind: 'playbyplay', style: 'excited', direction: D.hit, n: [3, 14, 5], text: ['Swung on, and that is a long drive to {field}!', 'Smacked down the line, that one is in the corner!', 'Back, back, back, at the wall... he has got it!', 'Into the gap in {field}, and it rolls all the way to the wall!', 'That ball is crushed to {field}, off the wall, and {name} is rounding second!'] },
  { id: 'call-hr', kind: 'playbyplay', style: 'peak', direction: D.peakHr, n: [6, 22, 4], text: ["{name} swings, and it's outta here! {ft} feet!", "And it's... GONE!", 'Going, going, gone!', 'See you later! That ball is gone!', 'Deep to {field}, back at the wall... and it is gone!', 'Swing and a drive, back, back, back... gone!', 'That is crushed, {ft} feet, and {name} has tied the game!', 'That one is out of here, a {ft}-foot blast!', "A home run for {name}, and it's {hi} to {lo}!"] },
  { id: 'call-walkoff', kind: 'playbyplay', style: 'peak', direction: D.peakHr, n: [2, 8, 2], text: ["Swing and a drive... deep to {field}... it is GONE! A walk-off winner for the {team}!", "And the {team} win it! A walk-off, {hi} to {lo}!", 'Ballgame! {name} wins it with a walk-off home run!'] },
  { id: 'call-robbed', kind: 'playbyplay', style: 'peak', direction: D.peakCatch, n: [1, 6, 2], text: ['Robbed! {name} takes a home run away from {name2}!', 'Oh, what a catch! He leaps and takes it back over the wall!', 'He robbed him! Unbelievable!'] },
  { id: 'call-close', kind: 'playbyplay', style: 'excited', direction: D.plateClose, n: [3, 13, 3], text: ['Here comes the throw, the tag... safe! Safe at the plate!', 'Here is the throw... and he is out! Out at the plate!', 'Bang-bang play at first, and he is out!', 'He is going to third, here comes the throw... safe!', 'Diving into second, and the throw is late, safe!', 'The tag is applied, and the umpire says out!', 'Rundown! They have him, he is out!'] },
  { id: 'call-catch', kind: 'playbyplay', style: 'excited', direction: D.peakCatch, n: [2, 8, 3], text: ['Diving catch by the {pos}!', 'Over the shoulder, and he makes the grab! What a play!', 'The {pos} dives, and he has it!', 'He leaps at the wall, and he has made the catch!'] },
  { id: 'call-end', kind: 'playbyplay', style: 'peak', direction: D.big, n: [1, 3, 1], text: ["And that's the ballgame. The {team} win, {hi} to {lo}.", "And that's the ballgame.", "That's it, the {team} win it, {hi} to {lo}!"] },

  // ---------------------------------------------------------------- tension / building
  { id: 'tension', kind: 'situation', style: 'building', direction: D.build, n: [3, 12, 5], text: ['{runners}, {outs}, and {name} steps in.', 'Two outs, {runners}, and the {count} pitch is coming.', '{outs}, {runners}, and this crowd is on its feet.', 'It is a tie ball game, {runners}, and here is the pitch.', 'One swing could do it right here, {count}.', 'Full count, two outs, {runners}. Everything on this pitch.', 'The crowd is up. {name}, down to his last strike, {runners}.'] },
  { id: 'situ', kind: 'situation', style: 'calm', direction: D.calm, n: [2, 14, 6], text: ['{runners}, {outs}.', 'Runners on the corners, {outs}.', 'We go to the {inning}, {outs}.', 'It is the {inning}, and the {team} lead {hi} to {lo}.', 'Nobody on, nobody out, here in the {inning}.', 'The bases are loaded, and {name} is the batter.', 'A runner at second, {outs}, and the infield is playing back.'] },
  { id: 'excite-short', kind: 'playbyplay', style: 'excited', direction: D.exc, n: [3, 16, 4], text: ['Hit hard!', 'He got all of that one!', 'Oh, he hit that well!', 'What a pitch, what a swing!', 'There it goes, off the wall!', 'And the crowd goes wild!', 'Everybody is on their feet!', 'You can not hit a ball much harder than that!'] },
  { id: 'deflate', kind: 'playbyplay', style: 'deflated', direction: D.deflate, n: [3, 12, 3], text: ["Oh, that's a shame.", 'He just missed it.', 'Ohhh, that hurts.', 'And the rally dies right there.', 'He leaves them stranded.', "Oh no. That's a costly error.", 'Well, that is going to sting.', 'Just missed, and that is a big out.', 'The {team} cannot get the big hit.'] },

  // ---------------------------------------------------------------- inning recaps / game state
  { id: 'recap', kind: 'situation', style: 'calm', direction: D.recap, n: [3, 7, 4], text: ["After {inn}, it's {team} {lo}, {team2} {hi}.", "After {inn} innings, {team} {hi}, {team2} {lo}.", "We're tied at {lo} after {inn}.", 'Going to the {inning}, the {team} lead by {runs}.', "That's {runs} runs in the {inning} for the {team}.", 'Three up, three down, and we go to the {inning}.', 'The {team} strand two, and it is {hi} to {lo} after {inn}.'] },
  { id: 'change', kind: 'situation', style: 'calm', direction: D.calm, n: [1, 6, 3], text: ['A pitching change coming for the {team}, and {name} is the new man.', '{name} comes in to pitch, and he will take his warm-up throws.', 'The manager goes to the bullpen, and it is {name}.', '{name} takes the mound in relief.'] },

  // ---------------------------------------------------------------- stats (deadpan color)
  { id: 'stat-line', kind: 'stat', style: 'deadpan', direction: D.stat, n: [3, 12, 6], text: ['{name} is {h} for {ab} today.', '{name} is {h} for {ab} tonight with a double.', '{name} is hitting {avg} on the season.', 'He is batting {avg} this year, with {hr} home runs and {rbi} runs batted in.', '{name} has {hr} home runs on the year.', '{name} has driven in {rbi} runs this season.', 'He is {h} for his last {ab}.'] },
  { id: 'stat-pitch', kind: 'stat', style: 'deadpan', direction: D.stat, n: [3, 10, 5], text: ["That's strikeout number {k} on the night.", '{name} has struck out {k} tonight.', '{name} has thrown {np} pitches, and {st} of them for strikes.', 'He is sitting at {np} pitches, going into the {ord}.', '{name} owns a {era} E R A this season.', 'He has {k} strikeouts and only {w} walks.', 'That is {k} strikeouts for {name} through the {ord} inning.'] },
  { id: 'stat-ball', kind: 'stat', style: 'deadpan', direction: D.stat, n: [3, 12, 4], text: ['That one left the bat at {exit} miles an hour.', 'Exit velocity, {exit}, launch angle {angle} degrees.', '{ft} feet, the longest home run of the night.', 'That is {exit} off the bat, and it traveled {ft} feet.', '{mph} miles an hour.', 'The ball was hit {exit} and carried {ft} feet.', 'The pitch was {mph}, the hardest of the night.'] },

  // ---------------------------------------------------------------- replay
  { id: 'replay', kind: 'color', style: 'deadpan', direction: D.replay, n: [3, 8, 4], text: ["Let's take another look at that one.", 'Here is the replay.', 'Watch the {pos} here, he gets a great jump.', 'From a different angle you can see the ball just clearing the wall.', 'You can see the tag come down right on the runner.', 'On the replay, he was just a step late.', 'Look how far {name} has to go to get to that ball.', 'The {pitch} just caught the corner on the replay.'] },
  ...BOOTH_TEMPLATES,
];

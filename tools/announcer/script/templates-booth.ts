/**
 * Booth commentary: mirrors the template library in src/audio/commentary.ts (intro, matchup, pitch mix, plate-appearance colour, runs,
 * close plays, replays, half-inning summaries, setup, between innings). Wording is kept close to the game's so the model has heard
 * each shape; re-run `npm run announcer:script` after the commentary changes (`npm run announcer:vocab` refreshes the word list).
 */
import type { Template } from './types';

const stat = 'Flat, matter-of-fact; the numbers crisp, last word falls.';
const dry = 'Dry and a little amused, like thinking out loud. Almost no rise.';
const setup = 'Start low and let it tighten; lean on the situation, lift on the last phrase.';
const recap = 'Settled and warm; steady rhythm, drop at each full stop.';
const replay = 'Easy, explanatory; slow on the detail, let the last word hang.';

export const BOOTH_TEMPLATES: Template[] = [
  { id: 'booth-intro', kind: 'situation', style: 'calm', direction: 'Easy, conversational; set the scene, fall on the last word.', n: [0, 6, 3], text: [
    '{name}, batting left-handed, against {name2}.', '{name}, batting right-handed, against {name2}.', '{name}, batting from both sides, against {name2}.',
    '{name} comes up {h} for {ab} on the night.', '{name} steps in for a first look at {name2} tonight.', 'Top of the {ord}, one out, with a runner on second.', '{name2} is at {np} pitches.', 'Righty against lefty here.'] },
  { id: 'booth-rating', kind: 'color', style: 'deadpan', direction: dry, n: [1, 7, 4], text: [
    '{name} has {pct}-grade power, so anything left over the plate is dangerous.', '{name} makes contact: a {pct} grade on the bat-to-ball skill.', 'A patient hitter, {name}. The eye grades out at {pct}.',
    '{name} can run, a {pct} on the speed grade, so any ball on the ground is a race.', '{name2} has command, {pct} on the control grade, and will work the corners.', '{name2} can run it up to {mph}.',
    '{name} already has a homer tonight.', '{name} already has {hr} homers tonight.', '{name} has struck out twice tonight, so {name2} will want to keep the ball moving.', '{name} has two hits tonight already.'] },
  { id: 'booth-pitchmix', kind: 'color', style: 'deadpan', direction: dry, n: [0, 6, 3], text: [
    'That is four sliders in a row from {name}.', 'That is three curveballs in a row from {name}.', 'Five straight fastballs, counting the variations, from {name}.', 'The first changeup of the night from {name}.',
    '{name} has gone to the fastball {k} times out of {np} tonight.', 'Six breaking balls so far tonight from {name}.', 'That is as hard as {name} has thrown tonight.', 'That change of speed, {mph} then {lo}, is what you want to see.', 'Four pitches in this at-bat.'] },
  { id: 'booth-twostrike', kind: 'situation', style: 'building', direction: setup, n: [0, 5, 3], text: [
    'Two strikes on {name}, and the pitcher is ahead.', 'Ball three, and {name2} needs to find the zone.', 'Full count, and everyone is up.', '{name} is down 0 and 2, protecting the plate now.', '{name2} is behind 3 and 0, and {name} may be taking.',
    'With a runner on first and fewer than two out, {name2} would love a double-play ball.', 'The bases are loaded and {name} is at the plate.', 'The crowd is into it.'] },
  { id: 'booth-result', kind: 'color', style: 'deadpan', direction: stat, n: [1, 7, 4], text: [
    '{name} is {h} for {ab} now.', 'That is second home run of the night for {name}.', 'A home run for {name}, the first tonight.', 'That is three strikeouts tonight for {name}, a hat trick.', 'Four strikeouts for {name}: the golden sombrero.',
    '{name2} has walked two tonight.', '{name} has driven in {k} tonight.', 'That ball was hit {exit} miles an hour.', 'And the game is tied at {lo}.', '{team} take the lead, {hi} to {lo}.', '{team} now lead by {runs}.'] },
  { id: 'booth-close', kind: 'color', style: 'deadpan', direction: dry, n: [0, 4, 2], text: [
    'That was close: a few hundredths of a second.', 'That was close: about {k} hundredths of a second.', 'Everyone is waiting on the umpire for that one.', '{last} has {pct}-grade speed, so the jump makes sense.', 'The runner is going!', '{last} on second is a {pct} runner, so keep an eye on that.'] },
  { id: 'booth-halfinning', kind: 'situation', style: 'calm', direction: recap, n: [1, 6, 4], text: [
    'After the top of the {ord}, it is {team} {lo}, {team2} {hi}.', 'After {ord} inning, it is {team} {hi}, {team2} {lo}.', 'All tied at {lo} as we move on.', '{team} lead {hi} to {lo}.', 'One run came in that half inning.',
    '{runs} runs came in that half inning.', 'Three strikeouts that half inning.', 'Two hits and nothing to show for it.', 'The crowd is on its feet here.', 'We go to the bottom of the {ord}, with {team} {lo} and {team2} {hi}.', 'The score is tied at {lo}.', '{team} are in control by {runs}.'] },
  { id: 'booth-between', kind: 'situation', style: 'calm', direction: recap, n: [0, 5, 3], text: [
    'No outs, nobody on.', 'Two outs, a runner on third.', 'It is {team} {lo}, {team2} {hi}, top of the {ord}.', '{name2} is at {np} pitches, with {k} strikeouts.', '{name2} is two innings in with one hit and no runs.',
    'You can feel the energy in this ballpark.', 'Every pitch matters now in a game this tight.', '{name} is {h} for {ab} tonight.', '{name2} has {k} strikeouts so far.', '{name2} has not allowed a hit yet.', 'This one is going to come down to the wire.'] },
  { id: 'booth-replay', kind: 'color', style: 'deadpan', direction: replay, n: [0, 5, 2], text: [
    'Here it is again from a different angle.', 'Watch this replay.', 'And in slow motion.', 'Off the bat at {exit} miles an hour.', 'The call came down to about {k} hundredths of a second.', '{name2} takes over, in a game that is {team} {lo}, {team2} {hi}.'] },
  { id: 'booth-setup', kind: 'situation', style: 'building', direction: setup, n: [0, 6, 3], text: [
    'Nobody out, runners on first and second.', 'Tied at {lo} in the {inning}.', '{team} {hi}, {team2} {lo} in the {inning}.', '{name} up with runners on second and third and one out.', '{name2} has thrown {np} pitches.', 'We are in the {inning} of a one-run game.',
    'We are in the {inning} of a tie game.', 'Two outs with a runner in scoring position: {name2} is one pitch away from getting out of it, {name} one swing from changing the game.', '{name2} has used the fastball {pct} percent of the time tonight.'] },
];

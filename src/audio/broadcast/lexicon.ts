/**
 * What the play-by-play voice says for every sim event. Each key holds several grammar templates (see `grammar.ts`); a template whose
 * slot has no value (we do not know the direction, the fielder ...) is skipped, so nothing is invented. Every player is "he / him / his"
 * (the owner's call: baseball is usually played by men); nobody else is gendered: umpires are "the umpire", the crowd is "the crowd".
 * A pronoun is only used where it can mean one person (the batter, the runner, or the fielder in a sentence that names no one else).
 *
 * `callsFor(event, ctx, log, env)` returns zero or more calls; the director decides when (and whether) they are said.
 */
import type { RawEvent } from '../types';
import { say, variants, type Slots } from './grammar';
import { lastNameOf, type BoothCtx } from './ctx';
import { isHit, type GameLog } from './gamelog';
import type { Fold, Importance, VoiceId } from './director';
import { locationWords, pitchName } from '../commentary';

export interface Call {
  importance: Importance;
  speaker: VoiceId;
  text: string;
  excited?: boolean;
  ttl: number;
  tag: string;
  fold?: Fold;
  foldable?: boolean;
  /** colour voice reaction that may start over the end of the call ("Ooh!", "Wow!") */
  react?: string;
}

export interface Env {
  rng: () => number;
  /** the live count (balls, strikes, outs) at the moment a fold is spoken */
  live: () => { balls: number; strikes: number; outs: number; batterId?: string };
  epoch: () => number;
}

// ---- vocabulary ------------------------------------------------------------------------------------------------------------

const W = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export const numWord = (n: number) => W[n] ?? String(n);
const ORDW = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
export const ordWord = (n: number) => ORDW[n] ?? `${n}th`;
const BASE = ['home', 'first', 'second', 'third', 'home'];
export const baseWord = (b: number) => BASE[b] ?? 'the bag';

export function countWords(balls: number, strikes: number): string {
  if (balls === 3 && strikes === 2) return 'full';
  return `${ohw(balls)} and ${ohw(strikes)}`;
}
const ohw = (n: number) => (n === 0 ? 'oh' : numWord(n));
const countPhrase = (b: number, s: number) => (b === 3 && s === 2 ? 'a full count' : `${ohw(b)} and ${ohw(s)}`);

/** where a batted ball went, from the sim's spray angle (+ = toward third base / left field) */
export function sprayZone(sprayDeg: number): { id: string; dir: string; side: 'left' | 'center' | 'right'; gap?: string; line?: string } {
  const a = sprayDeg;
  if (a > 45) return { id: 'foul-left', dir: 'the left-field foul territory', side: 'left' };
  if (a >= 38) return { id: 'lf-line', dir: 'the left-field corner', side: 'left', line: 'left-field' };
  if (a >= 15) return { id: 'left', dir: 'left field', side: 'left' };
  if (a >= 5) return { id: 'left-center', dir: 'left-center', side: 'left', gap: 'left-center' };
  if (a > -5) return { id: 'center', dir: 'center field', side: 'center' };
  if (a > -15) return { id: 'right-center', dir: 'right-center', side: 'right', gap: 'right-center' };
  if (a > -38) return { id: 'right', dir: 'right field', side: 'right' };
  if (a >= -45) return { id: 'rf-line', dir: 'the right-field corner', side: 'right', line: 'right-field' };
  return { id: 'foul-right', dir: 'the right-field foul territory', side: 'right' };
}

export function hitType(launchDeg: number, exitMph: number): 'bunt' | 'grounder' | 'liner' | 'fly' | 'pop' {
  if (exitMph <= 32) return 'bunt';
  if (launchDeg < 10) return 'grounder';
  if (launchDeg < 25) return 'liner';
  if (launchDeg < 50) return 'fly';
  return 'pop';
}

/** rough carry in metres (vacuum range with a drag allowance): used only to choose "deep" / "shallow" wording at contact */
export function carryEstimate(exitMph: number, launchDeg: number): number {
  const v = exitMph * 0.44704;
  return (v * v * Math.sin((2 * launchDeg * Math.PI) / 180) / 9.81) * 0.62;
}

/** the fielder's position as it is said in "ground ball to ..." */
const POS_SAY: Record<string, string> = { pitcher: 'the pitcher', catcher: 'the catcher', first: 'first', second: 'second', third: 'third', short: 'short', left: 'left', center: 'center', right: 'right' };
const POS_NOUN: Record<string, string> = { pitcher: 'pitcher', catcher: 'catcher', first: 'first baseman', second: 'second baseman', third: 'third baseman', short: 'shortstop', left: 'left fielder', center: 'center fielder', right: 'right fielder' };

export function depthWord(z: number, x: number): 'shallow' | 'medium' | 'deep' | 'infield' {
  const d = Math.hypot(x, z);
  if (d < 38) return 'infield';
  if (d < 66) return 'shallow';
  if (d < 88) return 'medium';
  return 'deep';
}

// ---- the templates ----------------------------------------------------------------------------------------------------------

export const LEX: Record<string, string[]> = {
  // -- pitch calls (SHOULD; the count is folded in when they cannot be said in time) --
  'ball': [
    'Ball $n[, $loc].', '$loc. Ball $n.', 'Just {misses|off}[ $loc], ball $n.', 'Takes it for ball $n.', 'Ball $n, {taken|and $b lets it go}.', 'Ball $n[, $loc]. {The count|It} {is|goes to} $count.',
    '{Low|High|Outside} again, ball $n.', 'Not {this time|that one}, ball $n.', '$typeCap, $mph. Ball $n.', '$b does not bite. Ball $n.', 'Misses the zone, ball $n.', 'Off the plate, ball $n.', 'Ball $n, and $b stays patient.',
  ],
  'strike.called': [
    'Called strike $n[, $loc].', 'Strike $n, taken[ $loc].', '$b watches it go by, strike $n.', 'Strike $n, looking.', 'Taken for strike $n.', '$typeCap, $mph, called strike $n.',
    'Right there[, $loc]. Strike $n.', 'Gets the call, strike $n.', 'And that one is a strike, number $n.', 'Strike $n, and $b does not offer.', 'In there for strike $n.', '$b takes a strike, $count.', 'Locates it, strike $n.', 'Over the plate, strike $n.',
  ],
  'strike.swinging': [
    'Swing and a miss, strike $n.', '$b swings through it. Strike $n.', 'Swings and misses!', 'Whiffs! Strike $n.', 'Chases it, and misses. Strike $n.', 'Strike $n, swinging.',
    '$typeCap, $mph, and $b swings right through it.', 'Misses it! That is strike $n.', 'Nothing on that one, strike $n.',
  ],
  'strike.foul': [
    '$b fouls this one off[, strike $n].', 'Fouled off, strike $n.', 'Fouled back.', 'Spoils that one, still $count.', 'Off the bat late, foul.', 'Foul ball, {back to the screen|into the stands}.',
    'Fouls it off, and the count stays $count.', 'Gets a piece of it, foul.', 'Hits it foul down the $line line.',
  ],
  'strike.foul.two': [
    '$b fouls this one off.', 'Fouled off, and {the at-bat|this one} goes on.', 'Fouls it back, still two strikes.', 'Stays alive! Foul ball.', 'Spoils another one.', 'Just gets a piece of it, foul.', 'Another foul, the count stays $count.',
  ],
  'strikeout.looking': [
    'Strike three called.', '$b is caught looking!', 'Called strike three! $b {goes down|is rung up} looking.', 'Strike three, looking.', 'Looking! Strike three.', 'Rung up! Strike three called.',
    'Strikes out $b looking.', 'Frozen! Strike three called on $b.',
  ],
  'strikeout.swinging': [
    'Strike three swinging!', 'Swing and a miss! $b strikes out.', 'Strike three, swinging! Got $b.', 'Strikes out $b swinging.', 'Fanned! Strike three!', '$b goes down swinging.', 'Swung on and missed, strike three!',
    '$typeCap, $mph, and $b swings through it for strike three!', 'That is strike three, and $b walks back to the dugout.',
  ],
  'strikeout.dropped': [
    'Strike three, but the ball gets away, and $b will run!', 'Strike three, dropped by the catcher! $b heads for first.', 'The pitch gets by, $b {is running|takes off for first}.',
    'Dropped third strike, here goes $b.',
  ],
  'strikeout.count': ['That is strikeout number $k for $p.', '$k strikeouts now for $p.', '$p has $k punchouts tonight.', '$k K\'s for $p tonight.'],
  'walk': [
    'Ball four. Take your base.', 'Ball four, $b will walk.', 'Ball four, and $b {draws|works} a walk.', 'Ball four, and $b heads down to first.', 'Walk. $b {takes|trots down to} first.',
    'Four balls. $b takes first base.', 'That is ball four, and $b is on.', 'Ball four[, $loc]. That one was close, but $b gets the walk.',
  ],
  'walk.forced': ['Ball four, and that forces in a run!', 'A bases-loaded walk, and a run comes in!', 'Ball four, the runner from third will score!', 'Walks in a run. Ball four.'],
  'walk.intentional': ["They'll put $b on intentionally.", 'Intentional walk to $b.', '$b is walked on purpose.', 'Four wide ones, and $b goes to first.', 'The intentional pass to $b.'],
  'hbp': [
    '$b is hit by the pitch!', 'Hit by the pitch! $b takes first.', 'That one got $b, hit by pitch.', 'Plunked! $b takes first base.', '$b is hit, and the umpire sends $b to first.', 'Ouch. $b is hit by the pitch.',
  ],
  // the pitch clock (MUST: a violation changes the count; SHOULD: a time-out the umpire would not grant, no mound visits left)
  'clock.viol.pitcher': ['Pitch clock violation on $p. That is an automatic ball.', 'The clock runs out on $p, and that is an automatic ball.', 'He did not get the pitch off in time! Violation on the pitcher, ball.', 'And the umpire calls time... the clock hit zero on $p. Automatic ball.', 'Too slow! A pitch clock violation, and $b gets a ball without a pitch.'],
  'clock.viol.batter': ['Pitch clock violation on $b. He was not ready, automatic strike.', '$b was not in the box in time, and that is an automatic strike.', 'The umpire calls a violation on the hitter! Automatic strike on $b.', 'He was still out of the box at eight seconds. Strike called on $b.', 'A clock violation on the batter: that is a free strike for $p.'],
  'time.denied': ['$b asks for time, and the umpire says no.', 'He wanted time, but he has already used his timeout this at-bat.', 'No time for him. He has to stay in the box.', 'Time is denied. He has used his one timeout.', 'He tried to call time, and he does not get it.'],
  'visits.none': ['The catcher starts out to the mound and has to turn back. They are out of mound visits.', 'No more mound visits for $fldTeam. $p is on his own out there.', 'They have used all five mound visits, so nobody can go out and settle him down.', 'The catcher would like to go talk to him, but they are out of visits.'],
  'balk': ['Balk! The runners move up.', 'Balk called, the runners advance.', 'The umpire calls a balk, and the runners move up a base.', 'That is a balk.', 'Balk. Everyone moves up.'],
  // -- batted balls (SHOULD at contact) --
  'contact.grounder': ['Ground ball to $pos...', 'Chopper to $pos...', 'Bouncer to the $side side...', 'On the ground to $pos...', 'Hit on the ground, to $pos...', 'Ground ball, up the middle...'],
  'contact.grounder.hard': ['Smoked on the ground to $pos!', 'Hard ground ball to $pos!', 'A rocket on the ground, to $pos!', 'Sharp grounder to $pos!', 'Ripped on the ground to the $side side!'],
  'contact.liner': ['Line drive to $dir!', 'Sharp liner to $dir.', 'Drives it on a line to $dir.', 'Line drive, headed for $dir...', 'Lined to $dir!', 'Lined hard to $dir.'],
  'contact.liner.hard': ['Smoked to $dir!', 'A laser to $dir!', 'Crushed on a line to $dir!', 'Absolutely scalded to $dir!', 'Hit hard, a line drive to $dir!'],
  'contact.fly': ['Fly ball to $dir...', 'Lifts one to $dir.', 'Fly ball, $dir...', 'Hit in the air to $dir...', 'Drives one to $dir...', 'High fly ball to $dir...'],
  'contact.fly.deep': ['Deep drive to $dir...', 'Hit deep to $dir... going back...', 'High and deep to $dir...', 'A long drive to $dir...', 'Back, back, to $dir...', 'That is hit a long way, to $dir...'],
  'contact.fly.shallow': ['Shallow fly to $dir...', 'A soft fly into $dir...', 'Looper into $dir...', 'Bloops one toward $dir...', 'Popped into shallow $dir...'],
  'contact.pop': ['Popped up near the $where...', 'Pop-up, $where...', 'High pop-up in the infield...', 'Skies one, in the infield...', 'Up in the air, in the infield...'],
  'contact.bunt': ['Bunt! $b lays it down.', 'A bunt, rolling toward $pos...', 'Squares and bunts it...', 'Lays down a bunt...', 'Bunt, down the $side line...'],
  // -- fielding (SHOULD, streamed into the call) --
  'fielded.clean': ['$f has it...', '$f {fields|gathers} it cleanly...', 'Scooped up by $f...', '$f gloves it...', 'Fielded by $f...'],
  'fielded.bobble': ['$f bobbles it!', '$f can not come up with it!', 'Off the glove of $f!', '$f {boots|fumbles} it!'],
  'catch.fly': ['$f {settles under it|camps under it}...', '$f {has it|is under it}...', '$f drifts over...', '$f tracks it down...', '$f waits on it...'],
  'catch.dive': ['$f dives... and makes the catch!', '$f lays out and snags it!', 'Diving catch by $f!', 'Sliding catch by $f!'],
  // -- outs (MUST) --
  'out.ground.first': [
    '$f {has it|fields it}, throws to first... {in time|got $b}! $outs', 'Chopper to $pos, $f {scoops it|has it}, over to first for the out. $outs', '$f {makes the play|gloves it}, throws... out at first! $outs',
    'Grounder to $pos, and that is an out. $outs', 'Ground ball to $pos, $f throws across... in time! $outs', '$f to first, and $b is out. $outs', 'Easy play for $f at $pos. $outs',
  ],
  'out.force': ['Force play at $base! $outs', '$f has it, steps on the bag... out at $base! $outs', 'Throws to $base... out! $outs', 'Out at $base on the force. $outs', 'Forced at $base. $outs'],
  'out.tag': ['Tagged out at $base! $outs', 'The tag is down... out! $outs', 'Out at $base, the tag beats the runner! $outs', 'Gets the tag down, and $r is out. $outs', 'Slides in... tagged out! $outs'],
  'out.line': ['Line drive, caught by $f! $outs', 'Hit hard, but right at $f. $outs', 'Lined to $pos, and $f hangs on! $outs', 'A liner, and $f makes the grab. $outs', 'Right into the glove of $f. $outs'],
  'out.fly': [
    'Fly ball to $dir... $f {settles under it|camps under it} and makes the catch. $outs', 'Lazy fly ball, $f has it. $outs', 'Caught by $f. $outs', '$f makes the catch. $outs', 'Easy out for $f in $dir. $outs',
    'Fly ball, caught. $outs', 'Up and out, $f squeezes it. $outs',
  ],
  'out.fly.deep': ['Deep fly to $dir... $f runs it down at the track! $outs', 'Way back, and $f makes the catch! $outs', '$f goes back, back... and has it! $outs', 'Caught at the warning track by $f. $outs', 'Long fly to $dir, but $f hauls it in. $outs'],
  'out.pop': ['Popped up, $f squeezes it. $outs', 'Pop-up, $f camps under it and has it. $outs', 'Infield pop-up, caught by $f. $outs', 'Pop-up behind the plate, the catcher squeezes it. $outs', 'Skied it, and $f makes the catch. $outs'],
  'out.foulfly': ['Foul ball, caught by $f! $outs', 'Fouls it up, and $f makes the catch near the $side line. $outs', 'Popped foul, $f gets it. $outs', '$f makes a running catch of the foul ball. $outs'],
  'out.infieldfly': ['Infield fly, the batter is out. $outs', 'Infield fly rule: $b is out. $outs', 'Popped up, infield fly rule in effect. $outs', '$f has the infield fly. $outs'],
  'out.pickoff': ['Picked off! $r is out at $base.', 'Caught leaning, and picked off at $base!', 'The pickoff throw gets $r! Out at $base.', 'Gotcha! Picked off at $base.', 'Picked off at $base, $r is out. $outs'],
  'out.cs': ['Caught stealing! $r is out at $base.', 'Throw in time... out! Caught stealing.', 'Nailed at $base! $outs', 'Caught stealing at $base. $outs', 'The throw is there! $r is out at $base.'],
  'out.tagup': ['Tagging up... and the throw beats $r! $outs', 'Out at $base trying to tag up! $outs', 'Doubled off! $r was tagging up.', 'Thrown out tagging up. $outs'],
  'out.interference': ["Batter's interference is called. $outs", "That's interference on the batter. $outs", 'Interference called, $b is out. $outs'],
  'out.appeal': ['On the appeal, $r is out! He never touched $base. $outs', 'He missed the bag! $r is out on the appeal at $base. $outs', '$r missed $base, and the appeal gets him. $outs'],
  'out.runnerint': ['He ran right into the fielder! Interference, and $r is out. $outs', 'Interference on the runner: he got in the way of the play. $outs', '$r collides with the fielder making the play, and he is called out. $outs'],
  'out.baseline': ['He left the baseline to get away from the tag, and he is out. $outs', 'Out of the baseline! $r went too far around the tag. $outs'],
  'obstruction': ['Obstruction! The fielder was in his way without the ball.', 'They are calling obstruction: he was blocked on his way to $base.', 'Obstruction on the fielder, and $r will be given $base.'],
  'appeal.start': ['They are going to appeal at $base.', 'An appeal at $base. Did $r touch the bag?', 'Hold on, the ball goes to $base: they think $r missed it.'],
  'out.other': ['Out! $outs', 'That is an out. $outs', 'And $b is retired. $outs', 'Retired. $outs'],
  'out.dp': ['Double play!', 'Around the horn... double play!', 'Turns two! Double play!', 'Two outs on one play, a double play!', "That's a double play!", 'Double play, and the inning is over!'],
  'out.tp': ['Triple play! Three outs on one play!', 'Unbelievable, a triple play!', 'A triple play! You hardly ever see that.', 'Three outs! A triple play!'],
  'outs.1': ['One away.', 'One out.', 'That is one out.'],
  'outs.2': ['Two down.', 'Two outs.', 'That is two out.'],
  'outs.3': ["That's three.", 'That will retire the side.', "That's the third out.", 'Three outs, and the side is retired.'],
  // -- hits (MUST, at the end of the plate appearance) --
  'hit.single': [
    'Base hit to $dir.', 'Base hit to $dir, and $b will hold at first.', '$b singles to $dir.', 'A line drive into $dir, base hit.', 'Base hit! Into the gap in $gap, $b will hold at first.', 'Ground ball through the $side side, base hit.',
    'Bloops one into $dir, base hit.', 'Base hit, and $b is on at first.', 'A single to $dir.', 'Finds a hole! Base hit to $dir.',
  ],
  'hit.double': [
    'Base hit! Into the gap, $b will take second.', "That's a double! $b {pulls into|slides into} second.", 'Down the $line line, and that is a double.', 'Doubled to $dir, and $b pulls into second.', 'Into the gap in $gap for a double!', 'A stand-up double for $b.',
    'Off the wall! Double for $b.', 'Rips one to $dir, and it is a double.',
  ],
  'hit.triple': ['Triple! $b {digs|steams} into third.', 'In the gap and all the way to third, a triple!', 'Off the wall, and $b is going for three... safe at third, a triple!', 'A triple for $b!', 'That is a triple, $b slides into third.'],
  'hit.sac': ['Sacrifice fly, and the run will score.', 'A sacrifice fly to $dir, the runner tags and scores.', 'Deep enough! Sac fly.', 'Sac fly, a run comes in.'],
  'hit.bunt': ['A sacrifice bunt, the runners move up.', 'Bunted over, the runners advance.', 'Lays down the sacrifice, and the runners are in scoring position.', 'Bunt gets the job done.'],
  'hit.error': ['$b reaches on an error by $f.', '$f can not make the play, and $b is on.', 'An error on $f, and $b reaches.', '$b is safe on the error.'],
  'hit.fc': ["Fielder's choice. The out is made at $base.", "$b reaches on a fielder's choice.", 'They get the runner at $base, and $b is on at first.', "Fielder's choice, the lead runner is out."],
  // -- runners --
  'safe': ['Safe at $base!', '$r is {in|safe} at $base.', 'Safe! $r {slides in|beats the tag}.', 'Safe at $base, {nice|good} slide.', 'The runner is safe!', 'The call is safe.'],
  'safe.close': ['Safe! That was close!', 'Safe by a hair at $base!', 'Whoa, that was close. Safe at $base.', 'Bang-bang play... and the call is safe!', 'Just in time, safe at $base!'],
  'steal.go': ['Runner goes!', 'There goes $r!', '$r is on the move!', 'They are running!', 'Here comes the steal at $base!', 'Steal attempt!', 'The runner takes off!'],
  'steal.safe': ['Safe at $base, steal number $n for $r.', '$r steals $base! That is number $n.', 'Stolen base. $r is safe at $base.', 'Beats the throw! Safe at $base.', 'Gets in safely, a stolen base for $r.'],
  'throw.steal': ["Throw's down...", 'Here is the throw...', "Throwing to $base...", 'Catcher fires to $base...'],
  'pickoff': ['Throws over to $base.', 'Pickoff attempt, the runner dives back safely.', 'Quick throw over to $base.', 'Steps off and throws to $base, back in time.', 'Over to $base, and the runner gets back.'],
  'advance': ['$r advances to $base.', '$r takes $base.', 'And $r moves up to $base.', '$r takes the extra base, $base.', '$r goes to $base on the throw.'],
  'run': ['$r scores!', '$r {crosses|comes across} the plate.', 'Here comes $r... safe, scores!', 'And a run {comes in|scores}.', 'A run for $team.', '$r scores, and it is $score.', 'Scores! $score.'],
  'run.walkoff': ["That's a walk-off! $r scores!", 'Walk-off! $team win it!', "And that's the game! $r scores the winning run!", 'The winning run scores!'],
  'run.nullified': ['No run, it does not count.', 'The run is wiped off the board.', 'The run will not count.', 'That run does not count.'],
  'wp': ['Wild pitch, the runner will advance.', 'Wild pitch! $r moves up.', 'Gets away from the catcher, wild pitch!', 'Wild pitch, way off the plate.', 'That one skips by, a wild pitch.'],
  'wp.none': ['Wild pitch, way off the plate!', 'A wild pitch, nobody on though.', 'That one got away.', 'In the dirt and by the catcher, wild pitch.'],
  'pb': ['Passed ball!', 'Gets by the catcher, passed ball.', 'Passed ball, the runner moves up.', 'The catcher can not handle it, passed ball.', 'It gets away, a passed ball.'],
  'error.drop': ['Dropped! $f can not hold on.', 'An error! $f drops it.', '$f drops it, error!', 'Oh, $f let it get away. Error.', 'Dropped, and the runners will move.'],
  'error.bobble': ['Error on $f!', '$f {misplays|bobbles} it, error!', 'That will be an error on $f.', '$f boots it!', 'Bobbled, and no play. Error on $f.'],
  'error.throw': ['Throwing error, $f sails it.', 'The throw is wild, and that is an error on $f.', '$f throws it away!', 'A bad throw from $f, and the runner is safe.', 'Errant throw by $f.'],
  'tag.hit': ['The tag!', 'Gets the tag down!', 'Tagged!', 'Swipe tag!', 'The tag is on.'],
  'tag.miss': ['Slides in under the tag!', 'Gets in under it, the tag misses.', 'Avoids the tag!', 'Slips away from the tag!', 'Dodges the tag!'],
  'tag.try': ["Here's the throw... the tag attempt!", 'Coming up with the ball, going for the tag...', 'The tag is coming...', 'A swipe at the runner...'],
  // -- big moments (MUST, excited) --
  'hr.solo': [
    'Deep drive to $dir... gone! Home run!', 'There it is! $b hits it out to $dir[, $ft feet].', 'High fly ball... way back... gone!', 'That ball is crushed! Home run for $b!', "It's outta here! $b {goes deep|goes yard}!",
    'Back, back... gone! A home run!', 'And that one is gone! $b {launches|crushes} a home run.', '$b gets all of it! Home run!',
  ],
  'hr.two': ['A two-run homer for $b!', 'Gone! Two runs score on the home run!', 'Two-run shot! $b hits it out to $dir.', 'Home run! A two-run blast for $b!'],
  'hr.three': ['A three-run homer! $b hits it out!', 'Gone! Three runs score!', 'Three-run blast for $b, over the fence!', 'Home run, and three runs come around!'],
  'hr.slam': ['Grand slam! $b clears the bases!', 'Gone! A grand slam for $b, four runs!', 'A grand slam! Unbelievable!', 'Grand slam for $b! The bases were loaded, and now they are cleared!'],
  'hr.walkoff': ["It's a walk-off home run!", 'Walk-off! $b ends it with a home run!', 'Gone! And the game is over, a walk-off homer!', "That's the ballgame! Walk-off home run for $b!"],
  'hr.dist': ['$ft feet.', 'That one went $ft feet.', 'A {$ft-foot|$ft foot} shot.', 'Measured at $ft feet.'],
  'wall': ['Off the wall!', 'Banged off the wall!', 'Caroms off the fence...', 'Off the wall, and $f plays it.', 'Hits the wall hard!'],
  'wallleap': ['$f goes up at the wall...', 'Back to the wall, $f jumps...', '$f {leaps|climbs} at the fence...', '$f is at the wall, and leaps...', 'Up goes $f!'],
  'robbed': [
    'Oh, $f robbed $b! What a catch at the wall!', 'Robbed! $f takes a home run away!', 'Brought back! $f reaches over the wall and robs $b!', 'Took that one away! Incredible catch by $f!', 'What a grab by $f at the wall! No home run!',
    'Unbelievable! $f steals a home run from $b!',
  ],
  // -- flow --
  'half.start': ['The $half of the $ord.', 'We move to the $half of the $ord.', 'Here we go, $half of the $ord.', '$team coming up in the $half of the $ord.', 'Underway in the $half of the $ord.'],
  'half.end': ["And that'll do it for the $half of the $ord.", 'Three outs, and the side is retired.', 'That ends the $half $ord.', 'And we go to the {break|next half}.'],
  'ondeck': ['$o is on deck.', '$o {heads|walks} to the on-deck circle.', 'Up next, $o.', '$o is loosening up in the on-deck circle.', 'On deck, $o.', 'Here comes $o to the on-deck circle, and he takes some swings.', '$o is on deck, and he {is next|will be up next}.'],
  'batter.up': ['$b steps in.', 'Here comes $b.', '$b is up.', 'Now it is $b.', 'And $b {comes to the plate|digs in}.'],
  // short colour reactions (the analyst chiming in over the last words of a call)
  'react.k': ['Nasty.', 'Good pitch.', 'Well pitched.', 'That is a tough at-bat.', 'Ooh.', 'Great sequence there.', 'He had no answer for that.'],
  'react.hit': ['Nice piece of hitting.', 'Good swing.', 'That is a quality at-bat.', 'Beautiful swing.', 'Great approach.', 'Good, solid contact.', 'He put a good swing on that.'],
  'react.out': ['Good play.', 'Nice job by the defense.', 'Routine.', 'That is how you do it.', 'Smooth.', 'Clean.'],
  'react.big': ['Wow!', 'Oh my!', 'Unbelievable!', 'What a play!', 'Absolutely crushed!', 'Incredible!', 'Are you kidding me?'],
  'react.err': ['Ooh, that hurts.', 'That is a tough one.', 'They will want that back.', 'Costly.', 'Oh no.'],
  'replay.pxp': ["Let's take another look at that.", 'Here it is again from a different angle.', 'Watch this replay.', 'And in slow motion.', 'Let us have another look.'],
  'start': ['And we are underway.', 'First pitch is coming up.', 'Here we go.', "Let's play ball."],
  'sub.ph': ['$in will pinch hit for $out.', 'A pinch hitter: $in.', '$in {comes in|steps in} to hit for $out.', 'Pinch hitting, $in.'],
  'sub.pr': ['$in will run for $out.', 'A pinch runner: $in.', '$in comes in to run for $out.', 'Pinch running, $in.'],
  'sub.def': ['$in comes in for $out.', 'A defensive change: $in for $out.', '$in is in the game for $out.', 'A substitution, $in for $out.'],
  'pitch.change': ['A pitching change. $in will take over for $out.', '$in {is coming in|is coming on} to pitch.', 'New pitcher: $in.', '$in {replaces|takes over for} $out on the mound.', 'Here comes $in out of the bullpen.'],
  'end': ["And that's the ballgame! $win win it, $x to $y.", 'Final score: $score. $win take it.', "That'll do it. $win win, $x to $y.", "It's over! $win come away with it, $x to $y.", 'And the game is over, $score.'],
  'end.tie': ['And that one ends in a tie, $x to $y.', 'The game ends tied at $x.', 'Final: $x to $y, a tie.'],
};

/** the same events with "he / him / his" (a pronoun only where it can mean just one person) */
const HE: Record<string, string[]> = {
  'ball': ['He does not bite. Ball $n.', 'He lays off it, ball $n.', 'He takes it, ball $n.', 'He holds back, ball $n.'],
  'strike.called': ['He watches it go by, strike $n.', 'He takes a strike, $count.', 'He leaves the bat on his shoulder, strike $n.', 'He takes it, strike $n[, $loc].'],
  'strike.swinging': ['He swings right through it. Strike $n.', 'He chases it, and misses. Strike $n.', 'He swings and misses, strike $n.', '$typeCap, $mph, and he swings through it.'],
  'strike.foul': ['He fouls this one off.', 'He gets a piece of it, foul.', 'He fouls it back, $count.', 'He hits it foul down the $line line.'],
  'strike.foul.two': ['He stays alive, fouling it off.', 'He fouls another one off.', 'He just gets a piece of it.', 'He battles, and fouls it back.'],
  'strikeout.looking': ['He is caught looking!', 'He goes down looking.', 'He takes it for strike three, and he is rung up!', 'He never moves the bat. Strike three!'],
  'strikeout.swinging': ['He swings and misses, strike three!', 'He goes down swinging.', '$typeCap, $mph, and he swings through it for strike three!', 'He is caught swinging, strike three!'],
  'strikeout.dropped': ['Strike three gets away, and he is running!', 'He takes off for first on the dropped third strike.', 'The ball gets away, and he heads for first!'],
  'strikeout.count': ['$p picks up his $ko strikeout of the night.', '$p has his $ko punchout tonight.', '$p gets his $ko strikeout of the game.'],
  'walk': ['He works a walk.', 'Ball four, and he trots down to first.', 'He draws the walk.', 'Ball four, and he takes first.', 'He earns the walk.'],
  'walk.forced': ['Ball four, and he walks in a run!', 'He takes ball four, and a run comes in!'],
  'walk.intentional': ['They walk him on purpose.', 'They will put him on, intentionally.', 'Four wide ones, and he goes to first.'],
  'hbp': ['He is hit by the pitch!', 'He gets hit, and he takes first.', 'Hit by the pitch, and he heads to first.'],
  'contact.grounder': ['He hits a grounder to $pos...', 'He chops one to $pos...', 'He rolls one to the $side side...'],
  'contact.grounder.hard': ['He smokes one on the ground to $pos!', 'He rips it on the ground to $pos!', 'He hits it hard on the ground, to $pos!'],
  'contact.liner': ['He lines it to $dir!', 'He drives it on a line to $dir.', 'He hits a line drive to $dir.'],
  'contact.liner.hard': ['He smokes it to $dir!', 'He lasers one to $dir!', 'He crushes it on a line to $dir!', 'He hits it hard, a line drive to $dir!'],
  'contact.fly': ['He lifts one to $dir...', 'He hits a fly ball to $dir...', 'He lofts one to $dir...'],
  'contact.fly.deep': ['He hits it deep to $dir... going back...', 'He gets a lot of that, deep to $dir...', 'He drives it deep to $dir...', 'He hits it a long way, to $dir...'],
  'contact.fly.shallow': ['He lifts a shallow fly to $dir...', 'He bloops one toward $dir...', 'He drops a soft fly into $dir...'],
  'contact.pop': ['He pops it up near the $where...', 'He skies one in the infield...', 'He hits a high pop-up in the infield...'],
  'contact.bunt': ['He lays it down, rolling toward $pos...', 'He squares and bunts it...', 'He drops a bunt down the $side line...'],
  'out.ground.first': ['$f fields it, throws to first... got him! $outs', '$f scoops it and throws across... out! $outs', 'Grounder to $pos, and they get him at first. $outs'],
  'out.force': ['Throws to $base... got him! $outs', '$f steps on the bag... and he is out at $base! $outs', 'They get him at $base on the force. $outs'],
  'out.tag': ['The tag is down... he is out! $outs', 'Out at $base, the tag beats him! $outs', 'They got him at $base! $outs'],
  'out.line': ['He lines it right at $f. $outs', 'He lines out to $pos. $outs'],
  'out.fly': ['He flies out to $dir. $outs', 'He lifts it, and $f makes the catch. $outs', 'He hit it in the air, and $f has it. $outs'],
  'out.fly.deep': ['He hit it a long way, but $f hauls it in. $outs', 'He got a lot of it, and $f runs it down. $outs'],
  'out.pop': ['He pops it up, and $f makes the catch. $outs', 'He skied it, and $f has it. $outs'],
  'out.foulfly': ['He fouls it up, and $f makes the catch. $outs', 'He pops it foul, and $f gets it. $outs'],
  'out.infieldfly': ['He pops it up, and with the infield fly rule, he is out. $outs'],
  'out.pickoff': ['Picked off! He is caught leaning at $base.', 'Gotcha! He is picked off at $base.', 'He is picked off at $base! $outs'],
  'out.cs': ['He is caught stealing at $base! $outs', 'Nailed at $base, and he is out! $outs', 'The throw gets him! Out at $base.'],
  'out.tagup': ['He tagged up, but he is out at $base! $outs', 'He is thrown out tagging up. $outs'],
  'out.interference': ['Interference, and he is out. $outs'],
  'out.appeal': ['He missed $base, and on the appeal he is out. $outs', 'They appeal, and he is called out for missing $base. $outs'],
  'appeal.start': ['They think he missed $base. Here comes the appeal.'],
  'out.runnerint': ['He ran into the fielder making the play, and he is out. $outs'],
  'out.baseline': ['He went out of the baseline, and he is out. $outs'],
  'obstruction': ['Obstruction: he was blocked, and he gets $base.'],
  'out.other': ['He is retired. $outs', 'And he is out. $outs'],
  'hit.single': ['He singles to $dir.', 'Base hit, and he will hold at first.', 'He lines one into $dir, base hit.', 'He finds a hole! Base hit to $dir.', 'Base hit, and he is on at first[, his $hn hit tonight].', 'He drops one into $dir, a single.'],
  'hit.double': ['He drives one into the gap, and he will take second.', 'He pulls into second with a double.', 'He rips one to $dir, and he is in with a double.', 'He slides into second, a double[, his $hn hit tonight].', 'He drives it to $dir, and he has a double.'],
  'hit.triple': ['He digs for third... and he makes it! A triple!', 'He is going for three... safe at third, a triple!', 'He steams into third with a triple.'],
  'hit.sac': ['He gets it deep enough, a sacrifice fly.', 'He lifts it deep enough, and the run will score.'],
  'hit.bunt': ['He lays down the sacrifice, and the runners move up.', 'He gets the bunt down, and the runners advance.'],
  'hit.error': ['He reaches on an error by $f.', 'He is safe on the error.', '$f can not make the play, and he is on.'],
  'hit.fc': ["He reaches on a fielder's choice.", 'They get the runner at $base, and he is on at first.'],
  'safe': ['He is safe at $base.', 'Safe! He slides in.', 'He beats the tag!', 'He is in safely at $base.'],
  'safe.close': ['He is in there by a hair! Safe at $base!', 'Safe! He just got in there, close play!'],
  'steal.go': ['He is going!', 'There he goes!', 'He is on the move!', 'He takes off!', 'And he is running!'],
  'steal.safe': ['He steals $base! That is number $n.', 'He is safe at $base, steal number $n.', 'He beats the throw! Safe at $base.', 'He gets in safely, stolen base number $n.'],
  'pickoff': ['He gets back in time.', 'Pickoff attempt, and he dives back safely.', 'Over to $base, and he gets back.'],
  'run': ['He scores!', 'He crosses the plate.', 'Here he comes... safe, he scores!', 'He scores, and it is $score.', 'He comes around to score.'],
  'run.walkoff': ["That's a walk-off! He scores!", 'Walk-off! He scores the winning run!', 'He scores, and that is the ballgame!'],
  'error.drop': ['He drops it! An error on $f.', 'Oh, $f let it get away. He is charged with the error.', 'He can not hold on, and that is an error.'],
  'error.bobble': ['He bobbles it, an error on $f.', 'He boots it! Error on $f.', 'He misplays it, and that is an error.'],
  'error.throw': ['He throws it away!', 'He sails the throw, an error on $f.', 'A bad throw from him, and the runner is safe.'],
  'tag.hit': ['Got him!', 'He is tagged!', 'The tag is on him.'],
  'tag.miss': ['He slides in under the tag!', 'He avoids the tag!', 'He slips away from the tag!', 'He dodges the tag!'],
  'tag.try': ['The tag is coming for him...', 'Going for the tag on him...'],
  'hr.solo': ['He gets all of it! Home run!', 'He hits it out to $dir[, $ft feet].', 'He crushes it, and it is gone!', 'He launches one, and it is gone! Home run!', 'He goes deep[, his $hrn homer tonight]!', 'He hit that one a mile! Home run!'],
  'hr.two': ['He hits a two-run homer to $dir!', 'He drives it out for two runs!', 'Two-run shot, and he hit that one a long way!'],
  'hr.three': ['He hits a three-run homer!', 'He clears the fence, and three runs score!', 'He drives it out, a three-run blast!'],
  'hr.slam': ['He hits a grand slam! Four runs score!', 'He clears the bases with a grand slam!', 'He just hit a grand slam!'],
  'hr.walkoff': ['He ends it with a home run! Walk-off!', "He wins it with a homer! That's the ballgame!", 'Walk-off! He hit it out, and the game is over!'],
  'robbed': ['$f reaches over the wall, and he takes a home run away from $b!', 'He took that away! What a catch by $f!', 'He reaches over and robs $b! Incredible!', 'Oh, he took that one away from $b!'],
  'batter.up': ['Here comes $b, and he digs in.', '$b steps in, and he gets set.'],
  'wallleap': ['$f is at the wall, and he leaps...', 'He goes up at the wall...'],
};
for (const [k, v] of Object.entries(HE)) LEX[k] = [...(LEX[k] ?? []), ...v];

/**
 * More ways to say the calls heard most (2026-10-29 variety pass, `docs/announcer-variety.md`): every one of these comes up dozens of times a game,
 * and the booth's memory (`memory.ts`) reaches for the wording heard longest ago, so a wider pool is heard as a fresher broadcast.
 */
const MORE: Record<string, string[]> = {
  'ball': [
    '$typeCap misses, ball $n.', 'Ball $n, just off the edge.', 'Nothing doing there. Ball $n.', 'A little too fine, ball $n.', 'Ball $n, and the count is $count.', 'He spits on it. Ball $n.', 'Out of the zone, ball $n.',
    'Not quite, ball $n.', 'That one is a ball, number $n.', '$p misses with the $type. Ball $n.',
  ],
  'strike.called': [
    'The umpire rings it up, strike $n.', 'Strike $n, and $b does not like the call.', 'He freezes, strike $n.', 'Strike $n, called.', 'That is strike $n, on a $type.', 'Taken, and that is strike $n.', 'The $type is there for strike $n.',
    '$p gets the call, strike $n.',
  ],
  'strike.swinging': ['Swing and a miss, $count.', 'Big cut, and nothing. Strike $n.', 'He came out of his shoes on that one. Strike $n.', '$b offers, and misses. Strike $n.', 'Swung on and missed, strike $n.', 'Nothing but air. Strike $n.'],
  'strike.foul': ['Foul ball, strike $n.', 'That one is foul. Strike $n.', 'Foul, and that is strike $n.', 'He fouls it away, $count.', 'Foul ball, and a souvenir for somebody.'],
  'strike.foul.two': [
    'Fights it off, foul.', 'Fouled off again. $b will not go away.', 'Another foul. Still $count.', 'Gets just enough of it to stay alive.', 'Foul ball. This at-bat keeps going.', '$b fends it off.',
  ],
  'walk': ['Ball four, and $b takes his base.', 'Ball four. A good eye from $b.', 'Four balls, and $b is aboard.', 'A walk to $b. That is a free pass.', 'Ball four, and $b drops the bat and jogs to first.'],
  'hbp': ['That one got away from $p, and $b wears it.', 'Right on the elbow guard. $b takes first.'],
  'contact.grounder': ['Two hopper to $pos...', 'Slow roller to $pos...', 'Ground ball toward $pos...', 'Rolled over to $pos...', 'Topped, toward $pos...', 'Hit on the ground, the $side side...', 'A bouncer up the middle...', 'Grounded to $pos...'],
  'contact.grounder.hard': ['One-hopper, hard, to $pos!', 'A smash on the ground at $pos!', 'Scorched on the ground to the $side side!'],
  'contact.liner': ['Line drive into $dir...', 'Hit on a line toward $dir...', 'A low liner to $dir...', 'Line drive, $dir...', 'Slices a liner to $dir...'],
  'contact.fly': ['Lofted to $dir...', 'In the air toward $dir...', 'A fly ball, out toward $dir...', 'Lifted to $dir...', 'Flies one to $dir...'],
  'contact.fly.shallow': ['A blooper toward $dir...', 'Soft fly, shallow $dir...', 'Dying quail into $dir...'],
  'contact.pop': ['Straight up, near the $where...', 'Pop fly, in the infield...', 'A high one, near the $where...', 'Got under that one, popped up...', 'Popped up, on the infield...'],
  'fielded.clean': ['Picked cleanly by $f...', '$f is there...', 'In the glove of $f...', '$f with it...', '$f takes it...', 'And $f grabs it...'],
  'catch.fly': ['$f has a beat on it...', '$f, under it...', '$f gets there...'],
  'out.ground.first': ['$f gathers, fires to first... out. $outs', 'Grounded out to $pos. $outs', '$f to first, and the throw is in time. $outs', 'Rolled over to $pos, and $f takes care of it. $outs', 'Ground ball, $f, the throw... got him. $outs'],
  'out.fly': ['And $f puts it away. $outs', 'Routine fly ball, $f has it. $outs', 'Lifted to $dir, and $f makes the play. $outs', 'Not enough on it. $f has it. $outs'],
  'out.pop': ['Pop-up, and $f puts it away. $outs', 'Way up, way down, into the glove of $f. $outs', 'Popped up, and $f takes care of it. $outs'],
  'out.line': ['Lined right at $f. $outs', 'Hit hard, but $f snares it. $outs', '$f, right there for the line drive. $outs'],
  'outs.1': ['One gone.', 'And that is the first out.', 'One out in the inning.'],
  'outs.2': ['Two away.', 'Two gone.', 'And there is the second out.'],
  'outs.3': ['And that is the inning.', 'Side retired.', 'And that will end the inning.'],
  'hit.single': ['Base hit, $dir. $b is aboard.', 'A clean single into $dir.', 'That one finds the grass in $dir. Base hit.', 'Singled to $dir.'],
  'hit.double': ['Two-base hit for $b!', 'Two bags for $b, a double to $dir.', 'A double for $b, into $dir.', 'And $b has himself a double.'],
  'hit.fc': ["The fielder's choice: they take the out at $base.", "$b is on, but the runner is forced at $base. Fielder's choice.", 'They get the lead runner, and $b is safe at first.'],
  'safe': ['Safe! $r is in there.', '$r makes it, safe at $base.', 'And $r is in safely.', '$r beats it, safe at $base.'],
  'advance': ['$r moves up to $base.', 'And $r is on to $base.', '$r alertly takes $base.', 'That moves $r up to $base.'],
  'run': ['In comes $r.', 'And $r touches home. $score.', 'That is a run, $r scores.', '$r is across, and it is $score.'],
  'wall': ['Rattles around off the wall!', 'Right off the fence!', 'Hits the wall!', 'Off the fence!'],
  'pitch.change': ['$in will come on to pitch.', 'They go to the bullpen for $in.', 'The call goes to $in.', 'In from the bullpen, $in.', 'That will be all for $out. $in is coming in.', '$out is done, and $in takes over.'],
  'strikeout.count': ['Strikeout number $k for $p.', 'That is $k K\'s on the night for $p.', '$p is up to $k strikeouts.', '$k strikeouts and counting for $p.'],
  'batter.up': [
    'Next up, $b.', '$b to the plate.', 'Up comes $b.', '$b digs in at the plate.', 'Stepping in, $b.', '$b now.', 'In the box, $b.', 'Here is $b.', 'Now batting, $b.', '$b, settling in.', 'Up steps $b.',
    'Next hitter, $b.', '$b, the next man up.', 'And here comes $b to hit.', '$b gets in the box.',
  ],
  'ondeck': ['$o waits in the on-deck circle.', '$o will follow.', 'After this, $o.', 'Waiting on deck, $o.', 'That brings $o on deck.', '$o, swinging the weighted bat on deck.'],
  'half.start': ['The $half of the $ord, coming up.', 'On we go to the $half of the $ord.', 'The $half half of the $ord inning.', 'Now the $half of the $ord.'],
  'react.k': ['Got him.', 'Filthy.', 'Could not catch up to it.', 'He set that up beautifully.', 'That is a pitcher pitching.', 'Never had a chance.', 'Put him away.', 'Wipeout pitch.'],
  'react.hit': ['Stayed on it.', 'Right on the barrel.', 'Went with the pitch.', 'He was waiting on that one.', 'Squared it up.', 'Professional piece of hitting.', 'Short and quick.', 'Nice job staying back.'],
  'react.out': ['Made it look easy.', 'Good hands.', 'Textbook.', 'Nothing fancy about it.', 'He was right there.', 'Good instincts.', 'Sure-handed.'],
  'react.err': ['That one will sting.', 'He just missed it.', 'That is not the one you want.', 'Ugh.', 'You have to make that play.'],
  'react.big': ['Oh, my goodness!', 'What a moment!', 'Look at that!', 'You have got to be kidding!', 'Unreal!', 'Oh, wow!'],
  'react.hr': ['Wow!', 'Oh, that is gone!', 'Crushed!', 'No doubt about that one!', 'Oh my!', 'That is a bomb!', 'Long gone!', 'Look at that thing fly!'],
  'react.rob': ['Oh!', 'No way!', 'He took it away!', 'Oh, what a grab!', 'Are you kidding me!', 'Robbery!'],
  'replay.pxp': ['One more look.', 'Here it is from behind the plate.', 'Let us see that again.', 'From the other side now.', 'Look at this one again.'],
  'end': ['That is the final out. $win win, $x to $y.', 'Ballgame! $win take it, $x to $y.', 'And that will end it. $win, $x to $y.'],
};
for (const [k, v] of Object.entries(MORE)) LEX[k] = [...(LEX[k] ?? []), ...v];

/** which lexicon keys cover which sim event (for the coverage test and the report) */
export const EVENT_KEYS: Record<string, string[]> = {
  gameStart: ['start'],
  batterUp: ['batter.up'],
  onDeck: ['ondeck'],
  halfInningStart: ['half.start'],
  halfInningEnd: ['half.end'],
  call: ['ball', 'strike.called', 'strike.swinging', 'strike.foul', 'strike.foul.two', 'strikeout.looking', 'strikeout.swinging', 'balk'],
  contact: ['contact.grounder', 'contact.grounder.hard', 'contact.liner', 'contact.liner.hard', 'contact.fly', 'contact.fly.deep', 'contact.fly.shallow', 'contact.pop', 'contact.bunt'],
  fielded: ['fielded.clean', 'fielded.bobble'],
  catch: ['catch.fly', 'catch.dive'],
  error: ['error.drop', 'error.bobble', 'error.throw'],
  throw: ['throw.steal'],
  out: ['out.ground.first', 'out.force', 'out.tag', 'out.line', 'out.fly', 'out.fly.deep', 'out.pop', 'out.foulfly', 'out.infieldfly', 'out.pickoff', 'out.cs', 'out.tagup', 'out.interference', 'out.appeal', 'out.runnerint', 'out.baseline', 'out.other', 'out.dp', 'out.tp', 'strikeout.looking', 'strikeout.swinging', 'strikeout.dropped'],
  safe: ['safe', 'safe.close', 'steal.safe'],
  runnerAdvance: ['advance'],
  runScored: ['run', 'run.walkoff'],
  runsNullified: ['run.nullified'],
  appeal: ['appeal.start'],
  obstruction: ['obstruction'],
  steal: ['steal.go'],
  pickoffAttempt: ['pickoff'],
  walk: ['walk', 'walk.forced', 'walk.intentional'],
  hitByPitch: ['hbp'],
  wildPitch: ['wp', 'wp.none'],
  passedBall: ['pb'],
  homeRun: ['hr.solo', 'hr.two', 'hr.three', 'hr.slam', 'hr.walkoff', 'hr.dist'],
  wallContact: ['wall'],
  wallLeap: ['wallleap'],
  robbedHomeRun: ['robbed'],
  substitution: ['sub.ph', 'sub.pr', 'sub.def'],
  pitchingChange: ['pitch.change'],
  plateAppearanceEnd: ['hit.single', 'hit.double', 'hit.triple', 'hit.sac', 'hit.bunt', 'hit.error', 'hit.fc', 'strikeout.count'],
  gameEnd: ['end', 'end.tie'],
  tag: ['tag.hit'],
  tagAttempt: ['tag.try'],
  tagAvoided: ['tag.miss'],
  pitchClockViolation: ['clock.viol.pitcher', 'clock.viol.batter'],
  timeDenied: ['time.denied', 'visits.none'],
};

/** sim events the booth deliberately says nothing about (they are sounds, gestures or bookkeeping) */
export const SILENT_EVENTS = ['baseMissed', 'collision', 'interference', 'outOfBaseline', 'windup', 'pitchReleased', 'pitchCrossed', 'swing', 'umpireCall', 'ballReturn', 'baseTouch', 'playEnd', 'decisionRequested', 'decisionResolved', 'ballKidRetrieve', 'ballTossedToFan', 'batBoyRetrieve', 'coachSignal', 'signsGiven', 'shakeOff', 'timeCalled', 'moundVisit', 'moundVisitEnd', 'pitchingChangeStart', 'challenge', 'challengeResult', 'breakStart', 'pitchClockStart', 'pitchClockReset', 'disengagement'];

export const lexiconStats = () => Object.fromEntries(Object.entries(LEX).map(([k, v]) => [k, v.reduce((a, t) => a + variants(t), 0)]));

// ---- building calls from events --------------------------------------------------------------------------------------

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function person(c: BoothCtx, id: unknown) {
  return c.person?.(id);
}

function baseSlots(c: BoothCtx, log: GameLog, ev: RawEvent): Slots {
  const batter = c.batter;
  const p = c.pitcher;
  const f = person(c, ev.fielderId ?? ev.playerId);
  const r = person(c, ev.runnerId ?? ev.playerId);
  const away = c.teams.away;
  const home = c.teams.home;
  return {
    b: batter ? lastNameOf(batter.name) : 'the batter',
    p: p ? lastNameOf(p.name) : 'the pitcher',
    f: f ? lastNameOf(f.name) : undefined,
    pos: f?.role ? POS_SAY[f.role] : undefined,
    r: r ? lastNameOf(r.name) : 'the runner',
    team: c.half === 'top' ? away : home,
    score: `${away} ${c.score.away}, ${home} ${c.score.home}`,
    ord: ordWord(c.inning),
    half: c.half,
    outs: undefined,
    ...tonight(c, log),
  };
}

/** "his second hit tonight", "his third homer": counted from the game log (the current plate appearance is already in it) */
function tonight(c: BoothCtx, log: GameLog): Slots {
  const bid = c.batter?.id;
  const k = c.pitcher?.pit?.so;
  const pas = bid ? log.batterPas(bid) : [];
  const hits = pas.filter((x) => isHit(x.result)).length;
  const hrs = pas.filter((x) => x.result === 'home run').length;
  return {
    hn: hits >= 2 ? ordWord(hits) : undefined,
    hrn: hrs >= 2 ? ordWord(hrs) : undefined,
    k: k && k >= 3 ? numWord(k) : undefined,
    ko: k && k >= 3 ? ordWord(k) : undefined,
  };
}

function outsPhrase(n: number, rng: () => number): string {
  const key = n >= 3 ? 'outs.3' : n === 2 ? 'outs.2' : 'outs.1';
  return say(LEX[key], {}, rng) ?? '';
}

/**
 * The calls for one event. `c` is the snapshot at the time of the event (state is one step behind: the booth never relies on
 * counts from it except through `env.live`).
 */
export function callsFor(ev: RawEvent, c: BoothCtx, log: GameLog, env: Env): Call[] {
  const rng = env.rng;
  const out: Call[] = [];
  const S = baseSlots(c, log, ev);
  const push = (key: string | string[], importance: Importance, o: Partial<Call> & { slots?: Slots } = {}) => {
    const keys = Array.isArray(key) ? key : [key];
    const slots = { ...S, ...(o.slots ?? {}) };
    for (const k of keys) {
      const tpl = LEX[k];
      if (!tpl) continue;
      const text = say(tpl, slots, rng);
      if (text) {
        out.push({ importance, speaker: o.speaker ?? 'pxp', text, excited: o.excited, ttl: o.ttl ?? (importance === 'must' ? 60 : 6), tag: o.tag ?? k, fold: o.fold, react: o.react, foldable: o.foldable ?? (k.startsWith('contact') || k === 'batter.up' || k === 'half.start') });
        return;
      }
    }
  };

  switch (ev.type) {
    case 'gameStart':
      push('start', 'could');
      break;
    case 'batterUp':
      if (c.batter) push('batter.up', 'could', { ttl: 6 });
      break;
    case 'onDeck': {
      const o = person(c, ev.playerId);
      if (o) push('ondeck', 'could', { slots: { o: lastNameOf(o.name) }, ttl: 6 });
      break;
    }
    case 'halfInningStart': {
      const half = ev.half === 'bottom' ? 'bottom' : 'top';
      push('half.start', 'should', { slots: { half, ord: ordWord(Number(ev.inning) || c.inning), team: half === 'top' ? c.teams.away : c.teams.home }, ttl: 8 });
      break;
    }
    case 'halfInningEnd': {
      const half = ev.half === 'bottom' ? 'bottom' : 'top';
      push('half.end', 'should', { slots: { half, ord: ordWord(Number(ev.inning) || c.inning) }, ttl: 10 });
      break;
    }
    case 'call': {
      const cl = (ev.call ?? {}) as { kind?: string; balls?: number; strikes?: number };
      const kind = String(cl.kind ?? '');
      const balls = cl.balls ?? c.balls;
      const strikes = cl.strikes ?? c.strikes;
      const pitch = log.pitches[log.pitches.length - 1];
      const bats: 'L' | 'R' = c.batter?.hand === 'L' ? 'L' : c.batter?.hand === 'R' ? 'R' : c.pitcher?.hand === 'R' ? 'L' : 'R';
      const loc = pitch && pitch.x !== undefined && pitch.y !== undefined ? locationWords(pitch.x, pitch.y, bats) : undefined;
      const type = pitch?.type ? pitchName(pitch.type) : undefined;
      const slots: Slots = { loc, type, typeCap: type ? cap(type) : undefined, mph: pitch?.mph || undefined };
      const mkFold = (): Fold => ({
        key: 'count',
        epoch: env.epoch(),
        render: () => {
          const live = env.live();
          if (live.balls === 0 && live.strikes === 0) return null; // a new batter: the count is not news
          return say(['That makes it $count.', 'The count is $count.', "And it's $count.", 'Now $count.', 'We are at $count.', 'Count goes to $count.', 'That brings it to $count.', '$countCap now.', 'So, $count.', 'Now it is $count.'], { count: countPhrase(live.balls, live.strikes), countCap: cap(countPhrase(live.balls, live.strikes)) }, rng);
        },
      });
      if (kind === 'ball') {
        if (balls >= 3) break; // ball four: the walk event speaks
        const n = balls + 1;
        push('ball', 'should', { slots: { ...slots, n: numWord(n), count: countPhrase(n, strikes) }, fold: mkFold(), ttl: 3 });
      } else if (kind === 'strikeLooking' || kind === 'strikeSwinging') {
        if (strikes >= 2) {
          // strike three: the out event speaks (strikeout lines); nothing here
          break;
        }
        const n = strikes + 1;
        push(kind === 'strikeLooking' ? 'strike.called' : 'strike.swinging', 'should', { slots: { ...slots, n: numWord(n), count: countPhrase(balls, n) }, fold: mkFold(), ttl: 3, excited: kind === 'strikeSwinging' && n === 2 });
      } else if (kind === 'foul' || kind === 'foulTip') {
        const n = Math.min(2, strikes + 1);
        const spray = log.lastContact?.sprayDeg;
        const line = spray === undefined ? undefined : spray > 0 ? 'left-field' : 'right-field';
        push(strikes >= 2 ? 'strike.foul.two' : 'strike.foul', 'should', { slots: { ...slots, n: numWord(n), count: countPhrase(balls, n), line }, fold: mkFold(), ttl: 3 });
      } else if (kind === 'balk') push('balk', 'must');
      break;
    }
    case 'contact': {
      const exit = Number(ev.exitMph) || 0;
      const launch = Number(ev.launchDeg) || 0;
      const spray = Number(ev.sprayDeg) || 0;
      const z = sprayZone(spray);
      if (Math.abs(spray) > 45 || z.id.startsWith('foul')) break; // foul: the foul call speaks
      const type = hitType(launch, exit);
      const hard = exit >= 98;
      const carry = carryEstimate(exit, launch);
      const slots: Slots = { dir: z.dir, side: z.side === 'center' ? 'middle' : z.side, where: z.side === 'left' ? 'third base' : z.side === 'right' ? 'first base' : 'mound', pos: z.side === 'left' ? 'third' : z.side === 'right' ? 'first' : 'second' };
      if (type === 'bunt') push('contact.bunt', 'should', { slots: { ...slots, pos: 'third' }, ttl: 3 });
      else if (type === 'grounder') push(hard ? 'contact.grounder.hard' : 'contact.grounder', 'should', { slots, ttl: 3 });
      else if (type === 'liner') push(hard ? 'contact.liner.hard' : 'contact.liner', 'should', { slots, ttl: 3, excited: exit >= 105 });
      else if (type === 'fly') {
        const key = carry >= 100 ? 'contact.fly.deep' : carry < 55 ? 'contact.fly.shallow' : 'contact.fly';
        push(key, 'should', { slots, ttl: 4, excited: carry >= 105 });
      } else push('contact.pop', 'should', { slots, ttl: 3 });
      break;
    }
    case 'fielded': {
      if (ev.clean === false) push('fielded.bobble', 'must', { excited: true });
      else push('fielded.clean', 'should', { ttl: 3 });
      break;
    }
    case 'catch': {
      if (ev.kind === 'pitch') break;
      if (ev.fly && String(ev.height) === 'low') push('catch.dive', 'should', { excited: true, ttl: 3 });
      else if (ev.fly) push('catch.fly', 'should', { ttl: 3 });
      break;
    }
    case 'error': {
      const k = String(ev.kind);
      push(k === 'throw' ? 'error.throw' : k === 'drop' ? 'error.drop' : 'error.bobble', 'must', { excited: true, slots: { f: person(c, ev.fielderId) ? lastNameOf(person(c, ev.fielderId)!.name) : undefined } });
      break;
    }
    case 'throw': {
      if (log.stealing && Number(ev.toBase) > 0) push('throw.steal', 'should', { slots: { base: baseWord(Number(ev.toBase)) }, ttl: 2 });
      break;
    }
    case 'steal': {
      push('steal.go', 'should', { slots: { r: person(c, ev.runnerId) ? lastNameOf(person(c, ev.runnerId)!.name) : 'the runner', base: baseWord(Number(ev.toBase)) }, excited: true, ttl: 3 });
      break;
    }
    case 'pitchClockViolation': {
      // the umpire's ruling changes the count: a MUST, with the analyst's reaction
      const onPitcher = ev.on === 'pitcher';
      push(onPitcher ? 'clock.viol.pitcher' : 'clock.viol.batter', 'must', { ttl: 12, react: say(['Ooh.', 'That one will sting.', 'You cannot do that.', 'Unforced error.', 'Wow.'], {}, rng) ?? undefined });
      break;
    }
    case 'timeDenied':
      if (ev.reason === 'noMoundVisits') push('visits.none', 'should', { ttl: 10, slots: { fldTeam: c.half === 'top' ? c.teams.home : c.teams.away } });
      else push('time.denied', 'should', { ttl: 6 });
      break;
    case 'pickoffAttempt':
      push('pickoff', 'should', { slots: { base: baseWord(Number(ev.base)) }, ttl: 3 });
      break;
    case 'safe': {
      const base = baseWord(Number(ev.base));
      const rn = person(c, ev.playerId);
      const slots: Slots = { base, r: rn ? lastNameOf(rn.name) : 'the runner' };
      if (log.stealing && Number(ev.base) === log.stealing.base) {
        const n = log.steals.get(log.stealing.id)?.[1] ?? 1;
        push('steal.safe', 'must', { slots: { ...slots, n: numWord(n) } });
      } else push(ev.closePlay === true ? 'safe.close' : 'safe', 'must', { slots, excited: ev.closePlay === true });
      break;
    }
    case 'out': {
      const ot = String(ev.outType);
      const base = typeof ev.base === 'number' ? baseWord(ev.base) : undefined;
      const f = person(c, (ev.fielders as unknown[] | undefined)?.[0] ?? ev.fielderId);
      const rn = person(c, ev.playerId);
      const last = log.pitches[log.pitches.length - 1];
      const outsN = log.outs; // already counted by the log
      const slots: Slots = {
        base, f: f ? lastNameOf(f.name) : undefined, pos: f?.role ? POS_SAY[f.role] : undefined,
        r: rn ? lastNameOf(rn.name) : 'the runner', b: c.batter ? lastNameOf(c.batter.name) : 'the batter', outs: outsPhrase(outsN, rng),
        dir: undefined, side: f?.role === 'first' || f?.role === 'right' ? 'right' : 'left',
      };
      const z = log.lastContact ? sprayZone(log.lastContact.sprayDeg) : undefined;
      slots.dir = z?.dir;
      const deep = log.landing ? depthWord(log.landing.z, log.landing.x) === 'deep' : false;
      // double / triple plays
      if (log.recentOuts.length >= 3) {
        push('out.tp', 'must', { excited: true, slots });
        break;
      }
      if (log.recentOuts.length === 2) {
        push('out.dp', 'must', { excited: true, slots });
        break;
      }
      if (ot === 'strikeout') {
        const swinging = last?.result === 'swinging';
        push(swinging ? 'strikeout.swinging' : 'strikeout.looking', 'must', { excited: swinging, slots: { ...slots, type: last?.type ? pitchName(last.type) : undefined, typeCap: last?.type ? cap(pitchName(last.type)) : undefined, mph: last?.mph || undefined } });
        const k = c.pitcher?.pit?.so;
        if (k && k >= 3) out.push({ importance: 'could', speaker: 'pxp', text: say(LEX['strikeout.count'], { ...S, k: numWord(k), ko: ordWord(k) }, rng) ?? '', ttl: 6, tag: 'strikeout.count' });
      } else if (ot === 'force' && base === 'first') push('out.ground.first', 'must', { slots });
      else if (ot === 'force') push('out.force', 'must', { slots });
      else if (ot === 'tag') push('out.tag', 'must', { slots });
      else if (ot === 'line') push('out.line', 'must', { slots, excited: true });
      else if (ot === 'fly') push(deep ? ['out.fly.deep', 'out.fly'] : 'out.fly', 'must', { slots });
      else if (ot === 'pop') push('out.pop', 'must', { slots });
      else if (ot === 'foulFly') push('out.foulfly', 'must', { slots });
      else if (ot === 'infieldFly') push('out.infieldfly', 'must', { slots });
      else if (ot === 'pickoff') push('out.pickoff', 'must', { slots });
      else if (ot === 'caughtStealing') push('out.cs', 'must', { slots, excited: true });
      else if (ot === 'tagUp') push('out.tagup', 'must', { slots });
      else if (ot === 'batterInterference') push('out.interference', 'must', { slots });
      else if (ot === 'appeal') push('out.appeal', 'must', { slots, excited: true });
      else if (ot === 'interference') push('out.runnerint', 'must', { slots, excited: true });
      else if (ot === 'baseline') push('out.baseline', 'must', { slots });
      else push('out.other', 'must', { slots });
      break;
    }
    case 'plateAppearanceEnd': {
      const r = String(ev.result ?? '');
      const z = log.lastContact ? sprayZone(log.lastContact.sprayDeg) : undefined;
      const type = log.lastContact ? hitType(log.lastContact.launchDeg, log.lastContact.exitMph) : undefined;
      const slots: Slots = { dir: z?.dir, side: z?.side === 'center' ? undefined : z?.side, gap: z?.gap, line: z?.line, base: undefined };
      if (r === 'single') push(type === 'grounder' && z?.side !== 'center' ? ['hit.single'] : 'hit.single', 'must', { slots });
      else if (r === 'double') push('hit.double', 'must', { slots, excited: true });
      else if (r === 'triple') push('hit.triple', 'must', { slots, excited: true });
      else if (r === 'sac fly') push('hit.sac', 'must', { slots });
      else if (r === 'sac bunt') push('hit.bunt', 'must', { slots });
      else if (r === 'reached on error') {
        const f = person(c, log.landing?.fielderId);
        push('hit.error', 'must', { slots: { ...slots, f: f ? lastNameOf(f.name) : undefined } });
      } else if (r === "fielder's choice") push('hit.fc', 'must', { slots: { ...slots, base: 'second' } });
      else if (r.startsWith('strikeout') && r.includes('dropped')) push('strikeout.dropped', 'must', { slots, excited: true });
      break;
    }
    case 'walk':
      if (ev.intentional) push('walk.intentional', 'must');
      else if (c.runners[0] && c.runners[1] && c.runners[2]) push('walk.forced', 'must', { excited: true });
      else {
        const pitch = log.pitches[log.pitches.length - 1];
        const bats: 'L' | 'R' = c.batter?.hand === 'L' ? 'L' : c.batter?.hand === 'R' ? 'R' : 'R';
        push('walk', 'must', { slots: { loc: pitch && pitch.x !== undefined && pitch.y !== undefined ? locationWords(pitch.x, pitch.y, bats) : undefined } });
      }
      break;
    case 'hitByPitch':
      push('hbp', 'must', { excited: true });
      break;
    case 'wildPitch':
      push(c.runners.some(Boolean) ? 'wp' : 'wp.none', 'must', { excited: true });
      break;
    case 'passedBall':
      push('pb', 'must');
      break;
    case 'runScored': {
      const rn = person(c, ev.playerId);
      const walkoff = c.half === 'bottom' && c.inning >= 9 && c.score.home > c.score.away && c.score.home - c.score.away <= 1 && ev.team === 'home';
      push(walkoff ? 'run.walkoff' : 'run', 'must', { slots: { r: rn ? lastNameOf(rn.name) : 'the runner', score: `${c.teams.away} ${ev.runsAway ?? c.score.away}, ${c.teams.home} ${ev.runsHome ?? c.score.home}`, team: ev.team === 'home' ? c.teams.home : c.teams.away }, excited: walkoff });
      break;
    }
    case 'runsNullified':
      push('run.nullified', 'must');
      break;
    case 'obstruction': {
      if (ev.awarded) break;
      const rn = person(c, ev.runnerId);
      push('obstruction', 'must', { excited: true, slots: { r: rn ? lastNameOf(rn.name) : 'the runner', base: baseWord(Number(ev.base)) } });
      break;
    }
    case 'appeal': {
      if (ev.stage !== 'start') break;
      const rn = person(c, ev.runnerId);
      push('appeal.start', 'must', { slots: { r: rn ? lastNameOf(rn.name) : 'the runner', base: baseWord(Number(ev.base)) } });
      break;
    }
    case 'runnerAdvance': {
      const to = Number(ev.toBase);
      const from = Number(ev.fromBase);
      const rn = person(c, ev.playerId);
      // the batter's own advance is part of the hit call; narrate the other runners only when they take an extra base on a throw / wild pitch
      if (to > from && to < 4 && rn && !(c.batter && rn.name === c.batter.name)) push('advance', 'should', { slots: { r: lastNameOf(rn.name), base: baseWord(to) }, ttl: 3 });
      break;
    }
    case 'homeRun': {
      const runs = (log.lastContact?.runnersOn ?? c.runners.filter(Boolean).length) + 1;
      const ft = Math.round(Number(ev.distance) * 3.28084);
      const z = log.lastContact ? sprayZone(log.lastContact.sprayDeg) : undefined;
      const walkoff = c.half === 'bottom' && c.inning >= 9 && c.score.home + runs > c.score.away && c.score.home <= c.score.away && c.score.away - c.score.home < runs;
      const slots: Slots = { dir: z?.dir, ft: ft > 0 ? ft : undefined };
      const key = walkoff ? 'hr.walkoff' : runs >= 4 ? 'hr.slam' : runs === 3 ? 'hr.three' : runs === 2 ? 'hr.two' : 'hr.solo';
      push(key, 'must', { excited: true, slots, react: say(LEX['react.hr'], {}, rng) ?? 'Wow!' });
      if (ft >= 400 && !walkoff) push('hr.dist', 'could', { slots: { ft }, ttl: 10 });
      break;
    }
    case 'wallContact':
      if (ev.who === 'ball') push('wall', 'should', { excited: true, ttl: 3, slots: { f: undefined } });
      break;
    case 'wallLeap':
      push('wallleap', 'should', { excited: true, ttl: 3, slots: { f: person(c, ev.fielderId) ? lastNameOf(person(c, ev.fielderId)!.name) : undefined } });
      break;
    case 'robbedHomeRun':
      push('robbed', 'must', { excited: true, react: say(LEX['react.rob'], {}, rng) ?? 'Oh!', slots: { f: person(c, ev.fielderId) ? lastNameOf(person(c, ev.fielderId)!.name) : undefined } });
      break;
    case 'tag':
      push('tag.hit', 'should', { ttl: 2 });
      break;
    case 'tagAttempt':
      push('tag.try', 'should', { ttl: 2 });
      break;
    case 'tagAvoided':
      push('tag.miss', 'should', { ttl: 3, excited: true });
      break;
    case 'substitution': {
      const reason = String(ev.reason ?? '');
      const inn = person(c, ev.inId);
      const outn = person(c, ev.outId);
      if (!inn || !outn) break;
      const key = /pinch.?hit/i.test(reason) ? 'sub.ph' : /pinch.?run/i.test(reason) ? 'sub.pr' : 'sub.def';
      push(key, 'should', { slots: { in: lastNameOf(inn.name), out: lastNameOf(outn.name) }, ttl: 12 });
      break;
    }
    case 'pitchingChange': {
      const inn = person(c, ev.inId);
      const outn = person(c, ev.outId);
      push('pitch.change', 'must', { slots: { in: inn ? lastNameOf(inn.name) : undefined, out: outn ? lastNameOf(outn.name) : 'the pitcher' } });
      break;
    }
    case 'gameEnd': {
      const w = String(ev.winner);
      const h = Number(ev.home ?? c.score.home);
      const a = Number(ev.away ?? c.score.away);
      if (w === 'tie') push('end.tie', 'must', { slots: { x: h, y: a } });
      else push('end', 'must', { excited: true, slots: { win: w === 'home' ? c.teams.home : c.teams.away, x: Math.max(h, a), y: Math.min(h, a), score: `${c.teams.away} ${a}, ${c.teams.home} ${h}` } });
      break;
    }
    default:
      break;
  }
  return out;
}

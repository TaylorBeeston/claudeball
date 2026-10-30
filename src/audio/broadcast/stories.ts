/**
 * Conversation topics: what two broadcasters would actually chat about, each derived from the game state and the rolling game log
 * (never invented). A *story* is a true observation with a salience; its script is 2-4 turns (observation -> question -> answer ->
 * quip) written with the grammar of `grammar.ts`. The picker scores stories by novelty, relevance and recency, avoids repeating a
 * fact, and falls back to a short neutral line when nothing is interesting (never more than 3 topic-less lines in a row).
 *
 * Wording rules: players are "he / him / his" (the owner's call), umpires "the umpire", everyone else neutral; a pronoun only where the line before it
 * names exactly one person; plain numbers, 4-14 words for punchy lines (tense moments), 12-35 for colour in a lull.
 */
import { say, type Slots } from './grammar';
import { lastNameOf, type BoothCtx } from './ctx';
import { isBreaking, isFastball, isHit, isK, isOffspeed, type GameLog } from './gamelog';
import { pitchName } from '../commentary';
import { numWord, ordWord } from './lexicon';
import type { Topic, TopicTurn, VoiceId } from './director';
import { CAST } from './cast';

/** how a voice is addressed by his partner (the analyst is mostly "Biscuit", now and then "Hollis") */
export const addressOf = (v: VoiceId, rng: Rng) => (v === 'pxp' ? CAST.pbp.calledBy[0] : rng() < 0.9 ? CAST.color.calledBy[0] : CAST.color.calledBy[1] ?? CAST.color.calledBy[0]);

type Rng = () => number;

export interface Line {
  /** A opens the topic, B answers (who is which voice is chosen per topic) */
  who: 'A' | 'B';
  t: string[];
  /** a line that may be skipped when it does not expand */
  opt?: boolean;
  excited?: boolean;
  interject?: boolean;
}

export interface Story {
  id: string;
  /** the fact this is about: not told twice within the cooldown */
  key: string;
  salience: number;
  /** 'now' stories are about this very plate appearance / moment */
  relevance: number;
  /** punchy stories use short lines (tense moments) */
  tense?: boolean;
  /** which voice opens (pxp / color / either) */
  opener?: VoiceId | 'either';
  build(rng: Rng, opener: VoiceId): TopicTurn[] | null;
}

export function script(lines: Line[], slots: Slots, rng: Rng, opener: VoiceId): TopicTurn[] | null {
  const other: VoiceId = opener === 'pxp' ? 'color' : 'pxp';
  const turns: TopicTurn[] = [];
  for (const l of lines) {
    const me: VoiceId = l.who === 'A' ? opener : other;
    // $other: what this speaker calls his partner (the cast's names), $me: his own first name
    const text = say(l.t, { ...slots, other: addressOf(me === 'pxp' ? 'color' : 'pxp', rng), me: me === 'pxp' ? CAST.pbp.first : CAST.color.first }, rng);
    if (!text) {
      if (l.opt) continue;
      return null;
    }
    turns.push({ speaker: l.who === 'A' ? opener : other, text, excited: l.excited, interject: l.interject });
  }
  return turns.length ? turns : null;
}

const grade = (v: number | undefined) => (v === undefined ? undefined : Math.round(v / 5) * 5);
const pct = (a: number, b: number) => Math.round((a / Math.max(1, b)) * 100);
const countSay = (b: number, s: number) => (b === 3 && s === 2 ? 'a full count' : `${numWord(b)} and ${numWord(s)}`);

export interface StoryEnv {
  rng: Rng;
  /** pa counter, for cooldowns */
  pa: number;
}

/** common slots for a context */
export function slotsOf(c: BoothCtx): Slots {
  const bat = c.batter;
  const pit = c.pitcher;
  const bl = bat?.bat;
  const batTeam = c.half === 'top' ? c.teams.away : c.teams.home;
  const fldTeam = c.half === 'top' ? c.teams.home : c.teams.away;
  const batScore = c.half === 'top' ? c.score.away : c.score.home;
  const fldScore = c.half === 'top' ? c.score.home : c.score.away;
  const diff = Math.abs(batScore - fldScore);
  return {
    b: bat ? lastNameOf(bat.name) : undefined,
    B: bat?.name,
    p: pit ? lastNameOf(pit.name) : undefined,
    P: pit?.name,
    batTeam,
    fldTeam,
    ord: ordWord(c.inning),
    half: c.half,
    outsw: c.outs === 0 ? 'nobody' : numWord(c.outs),
    diff,
    diffw: numWord(diff),
    runs: diff === 1 ? 'run' : 'runs',
    sep: diff === 1 ? 'separates' : 'separate',
    leads: 'lead',
    lead: batScore > fldScore ? batTeam : fldScore > batScore ? fldTeam : undefined,
    trail: batScore > fldScore ? fldTeam : fldScore > batScore ? batTeam : undefined,
    score: `${c.teams.away} ${c.score.away}, ${c.teams.home} ${c.score.home}`,
    tiescore: c.score.home,
  };
}

/**
 * What the booth says when the crowd makes something of the man the PA announced (`c.fan`): $f is his last name, $seasons his seasons with the
 * club ("nine seasons"). Spoken American ("favorite"). The recording script reads these too (tools/announcer/script/booth.ts).
 */
export const FAN_LINES = {
  favourite: ['Listen to them for $f.', 'Big hand for $f.', 'The crowd loves $f.', 'A fan favorite, $f.', 'Hear that? That is for $f.'],
  favouriteAgain: ['They are still cheering $f.', 'Another big hand for $f.', 'Every time up, they let $f hear it.'],
  pitcherIn: ['A big hand for $f as he takes the ball.', 'Nice ovation for $f.', 'The crowd likes it when $f pitches.'],
  closerIn: ['Here comes $f, and the crowd is up.', 'They know what it means when $f comes in.', 'Listen to them for $f.'],
  villain: ['A few boos for $f.', 'They are letting $f hear it.', 'Not a warm welcome for $f.', 'Listen to that. Boos for $f.'],
  villainEnd: ['That is baseball.', 'Some fans never forget.', 'It comes with the territory.'],
  why: {
    star: ['He is the best hitter on this club, and they know it.', 'They know who the big bat is.', 'When he comes up, people put their hot dogs down.'],
    veteran: ['$seasons in this uniform. He has earned that.', 'He has been here $seasons. They have watched him grow up.'],
    hometown: ['He grew up not far from here. Half this crowd knows his family.', 'The local kid. He came to games in this park as a boy.', 'Hometown kid. Every hit he gets, this place shakes.'],
    ace: ['He is the ace of this staff. Big crowds when he pitches.', 'When he starts, the place fills up.'],
    closer: ['That is the closer. Game on the line, ball in his hand.', 'This is his inning.'],
    former: ['He played $seasons here. Not everybody has made peace with him leaving.', 'He spent $seasons in the home uniform. They have not forgotten.'],
    rival: ['It is $batTeam and $fldTeam. They boo the big bats on principle.', 'Rivalry game. The best hitter on the other side always hears it.'],
    burnedHr: ['He took one deep earlier. They remember.', 'After that home run earlier, what did you expect?'],
    burnedRbi: ['He did the damage last time up. They have not forgotten.', 'He drove in runs earlier. They remember.'],
  } as Record<string, string[]>,
};

export function collectStories(log: GameLog, c: BoothCtx): Story[] {
  const S = slotsOf(c);
  const bat = c.batter;
  const pit = c.pitcher;
  const stories: Story[] = [];
  const add = (s: Story) => stories.push(s);
  const paPitches = log.pitchesInPa();
  const bl = bat?.bat;
  const pl = pit?.pit;
  const bid = bat?.id ?? '';
  const pid = pit?.id ?? '';
  const mix = pid ? log.mix(pid) : { total: 0, by: {} as Record<string, number>, fb: 0, brk: 0, off: 0 };
  const late = c.inning >= 7;
  const batScore = c.half === 'top' ? c.score.away : c.score.home;
  const fldScore = c.half === 'top' ? c.score.home : c.score.away;
  const diff = batScore - fldScore;
  const tight = late && Math.abs(diff) <= 2;
  const rsp = c.runners[1] || c.runners[2];

  // ---- pitching ----------------------------------------------------------------------------------------------------------
  const first = paPitches[0];
  if (first && paPitches.length === 1 && isBreaking(first.type) && pit && bat) {
    add({
      id: 'firstPitchBreaking', key: `fpb:${log.cur?.n}`, salience: 0.55, relevance: 1, opener: 'color',
      build: (rng, o) => script([
        { who: 'A', t: ['What is $p thinking with a first-pitch $type to $b?', 'A first-pitch $type to $b. Interesting choice.', 'First pitch is a $type. That is not what you expect.', '$p opens $b with a $type.', '$p starts $b off with a $type.', 'A $type to start the at-bat.'] },
        { who: 'B', t: ['Trying to steal a strike and get ahead, I would say.', 'Getting ahead of the count, and showing $b something to think about.', 'It is a way to get ahead without giving up the fastball.', 'He is trying to get ahead without giving up the fastball.', 'You do not see many hitters swing at a first-pitch $type.', 'Steal strike one, and the whole at-bat changes.', 'He wants $b thinking about something other than the fastball.', 'Start soft, finish hard. That is the idea.'] },
        { who: 'A', t: ['{Works|Worked} so far.', 'And now the next pitch matters.', 'We will see if $b is {sitting on|ready for} the fastball.', 'We will see what comes next.', 'A {smart|bold} way to start.'], opt: true },
      ], { ...S, type: pitchName(first.type) }, rng, o),
    });
  }
  if (paPitches.length >= 3) {
    const [a, b, d] = paPitches.slice(-3);
    if (isFastball(a.type) && isFastball(b.type) && (isOffspeed(d.type) || isBreaking(d.type)) && pit) {
      add({
        id: 'sequence', key: `seq:${log.cur?.n}:${paPitches.length}`, salience: 0.6, relevance: 1, opener: 'pxp',
        build: (rng, o) => script([
          { who: 'A', t: ['$ta, $tb, and now the $td.', 'Two fastballs, then a $td from $p.', 'Fastball, fastball, and then the $td.', '$p throws $ta, $tb, and then he goes to the $td.'] },
          { who: 'B', t: ['That is changing speeds, and it keeps $b off balance.', 'Classic sequencing: {show|set up} the fastball, then take a little off.', 'The $td plays up off the fastball.', 'He is changing speeds, and it keeps $b off balance.', 'Speed differential. Oldest trick there is.', 'That is how you make a fastball look faster.', 'Hard, hard, then soft. Hitters hate it.', 'Change the eye level, change the speed. That is pitching.'] },
          { who: 'A', t: ['{Good|Smart} pitching.', 'It is {all about|a game of} timing.', 'And $b {has to adjust|has to be ready for either}.', 'Textbook.', 'You will see that again tonight.'], opt: true },
        ], { ...S, ta: `${a.mph}`, tb: `${b.mph}`, td: pitchName(d.type) }, rng, o),
      });
    }
    if (isBreaking(a.type) && isBreaking(b.type) && isBreaking(d.type)) {
      add({ id: 'threeBreakers', key: `3brk:${log.cur?.n}`, salience: 0.5, relevance: 1, opener: 'color', build: (rng, o) => script([
        { who: 'A', t: ['Three breaking balls in a row to $b.', '$p has gone to the breaking stuff three straight times, and he has not shown a fastball.'] },
        { who: 'B', t: ['{Not a single fastball|No fastball in sight}. $b has to be wondering when it comes.', 'And $b {has to decide|is probably guessing} whether the heat is coming.', 'He is pitching backwards tonight.', 'The fastball might be the surprise pitch now.'] },
      ], S, rng, o) });
    }
  }
  if (pid) {
    const fb = log.fastballStreak(pid);
    if (fb >= 5) {
      add({
        id: 'fastballStreak', key: `fbs:${pid}:${Math.floor(fb / 2)}`, salience: 0.5 + Math.min(0.2, (fb - 5) * 0.04), relevance: 0.8, opener: 'color',
        build: (rng, o) => script([
          { who: 'A', t: ['That is $n fastballs in a row from $p.', '$p {has thrown|has gone with} $n straight fastballs now.'] },
          { who: 'B', t: ['{Sooner or later|At some point} a breaking ball has to show up.', 'Is $p just going to keep challenging with the heat?', 'That is a lot of fastballs. {Somebody|$b} is going to sit on one.', 'Is he just going to keep challenging with the heat?', 'At some point he has to {mix in|show} a breaking ball.', 'He is daring $b to catch up.', 'When it is working, why change it?', 'Everybody knows it is coming. That is a confident pitcher.', 'He has not needed anything else.'] },
          { who: 'A', t: ['If it ain\'t broke.', 'Or just trusting the fastball.', 'We will see how long that lasts.', 'Old-fashioned power pitching.', 'Hard stuff, and more of it.'], opt: true },
        ], { ...S, n: numWord(fb) }, rng, o),
      });
    }
    const cnt = log.onCount(pid, c.balls, c.strikes);
    if (cnt.length >= 4) {
      const byType: Record<string, number> = {};
      for (const p of cnt) byType[p.type] = (byType[p.type] ?? 0) + 1;
      const [type, k] = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
      if (k / cnt.length >= 0.66 && (c.balls + c.strikes > 0)) {
        add({
          id: 'countTendency', key: `ct:${pid}:${c.balls}-${c.strikes}`, salience: 0.65, relevance: 1, opener: 'color',
          build: (rng, o) => script([
            { who: 'A', t: ['On $cnt counts tonight, $p has gone to the $type $k of $m times.', 'In $cnt counts, $p has thrown the $type $k times out of $m tonight.'] },
            { who: 'B', t: ['So that is what $b should be {looking for|sitting on}.', 'That is a {pattern|tendency} worth knowing.', 'Is $b thinking $type here?', 'If $b has noticed, he can {sit on it|be ready for it}.', 'A good hitter files that away.', 'The advance scouts will have that one circled.'] },
            { who: 'A', t: ['{If|Maybe} $b {knows|has noticed}.', 'Or $p {mixes it up|crosses $b up} this time.', 'Patterns are {made to be broken|only useful until they are not}.'], opt: true },
          ], { ...S, cnt: countSay(c.balls, c.strikes), type: pitchName(type), k: numWord(k), m: numWord(cnt.length) }, rng, o),
        });
      }
    }
    if (mix.total >= 25) {
      // the pitch mixed in with the fastball: the most thrown one that is not a fastball (none: nothing to say about it)
      const top = Object.entries(mix.by).filter(([t]) => !isFastball(t)).sort((a, b) => b[1] - a[1])[0];
      if (top) add({
        id: 'pitchMix', key: `mix:${pid}:${Math.floor(mix.total / 25)}`, salience: 0.4, relevance: 0.5, opener: 'color',
        build: (rng, o) => script([
          { who: 'A', t: ['$p has thrown the {fastball|heater} $fb percent of the time tonight.', 'About $fb percent fastballs from $p so far.'], },
          { who: 'B', t: ['And the $top is the pitch that gets mixed in.', 'The {offspeed|breaking} stuff has been the {surprise|change of pace}.', 'That tells you where the confidence is.', 'He leans on the fastball, with the $top as the change of pace.', 'He trusts the fastball. You can see it.', 'The $top keeps them honest.'], opt: true },
        ], { ...S, fb: pct(mix.fb, mix.total), top: pitchName(top[0]) }, rng, o),
      });
    }
    const rt = log.retiredStreak(pid);
    if (rt >= 5) {
      add({ id: 'cruising', key: `cru:${pid}:${rt}`, salience: 0.6 + Math.min(0.2, (rt - 5) * 0.05), relevance: 0.7, opener: 'pxp', build: (rng, o) => script([
        { who: 'A', t: ['$p has retired $n in a row.', '$n straight batters set down by $p.', '$p is {cruising|in a groove} right now, $n in a row.'] },
        { who: 'B', t: ['{Nobody|Nothing} has {touched|solved} $p tonight.', 'The rhythm is {there|working}: {quick|fast} pitches, {quick|fast} outs.', 'Everything is working for $p right now.', 'Nobody has {touched|solved} him tonight.', 'He is in complete control.', 'That is what a groove looks like.', 'Strike one, strike two, out. Over and over.', 'Hitters are going back to the dugout shaking their heads.'] },
        { who: 'A', t: ['$b will try to {end|break} it.', 'Somebody has to get a runner on and {change the mood|stir things up}.'], opt: true },
      ], { ...S, n: numWord(rt) }, rng, o) });
    }
    const tr = log.recentTrouble(pid, 4);
    if (tr >= 3) {
      add({ id: 'rattled', key: `rat:${pid}:${log.pas.length}`, salience: 0.7, relevance: 0.9, opener: 'color', tense: true, build: (rng, o) => script([
        { who: 'A', t: ['$p has put a runner on in {three|$tr} of the last four batters.', '{Trouble|Traffic} on the bases again for $p.'] },
        { who: 'B', t: ['Someone is going to get warm in the bullpen.', '{That is where|This is when} the manager starts watching.', '$p needs to find the zone in a hurry.', 'He needs to find the zone in a hurry.', 'He is working out of traffic again.', 'He has to slow the game down.', 'This is where a catcher earns his money, $other.', 'A mound visit might be coming.', 'He is fighting himself a little out there.'] },
      ], { ...S, tr: numWord(tr) }, rng, o) });
    }
    if (pl && pl.pitches >= 90) {
      add({ id: 'pitchCount', key: `pc:${pid}:${pl.pitches >= 110 ? 110 : pl.pitches >= 100 ? 100 : 90}`, salience: 0.55, relevance: 0.6, opener: 'pxp', build: (rng, o) => script([
        { who: 'A', t: ['$p is up to $n pitches.', '$n pitches for $p tonight.'] },
        { who: 'B', t: ['That is a lot of work, {and the fastball has to hold up|and you wonder how much is left}.', 'Every pitch from here is {extra|a bonus}.', 'You {start to|have to} wonder about the {bullpen|next move}.', 'You have to wonder how much he has left.', 'The bullpen phone will be ringing soon.', 'He is running on fumes, or close to it.'] },
      ], { ...S, n: pl.pitches }, rng, o) });
    }
    if (pl && pl.h === 0 && pl.outs >= 12 && c.inning >= 5) {
      add({ id: 'noHitter', key: `nh:${pid}:${c.inning}`, salience: 0.85, relevance: 0.9, tense: true, opener: 'pxp', build: (rng, o) => script([
        { who: 'A', t: ['$p has not allowed a hit.', 'Still no hits against $p.', '$p still working on a no-hitter.'] },
        { who: 'B', t: ['{Nobody talks about it|You do not say the words}, but it is {there|out there}.', 'The crowd knows.', 'That puts {a little|a lot of} pressure on every pitch.', 'He has to be thinking about it.', 'Nobody in the dugout is sitting near him, I promise you.', 'I am not saying a word, $other.'] },
      ], S, rng, o) });
    }
    if (pl && pl.so >= 7) {
      add({ id: 'kNight', key: `kn:${pid}:${pl.so}`, salience: 0.6, relevance: 0.6, opener: 'pxp', build: (rng, o) => script([
        { who: 'A', t: ['$k strikeouts now for $p.', '$p has $k punchouts tonight.'] },
        { who: 'B', t: ['The {stuff|command} is {electric|sharp} tonight.', 'And that is {before|even before} the late innings.', 'The swings are {late|behind it} all night.', 'His stuff is {electric|sharp} tonight.', 'He is {piling them up|racking them up}.', 'Hitters are going up there guessing.', 'That is a lot of walks back to the dugout.'], opt: true },
      ], { ...S, k: pl.so }, rng, o) });
    }
    const fbs = log.pitcherPitches(pid).filter((p) => isFastball(p.type) && p.mph > 0);
    if (fbs.length >= 24) {
      const early = fbs.slice(0, 8).reduce((a, p) => a + p.mph, 0) / 8;
      const lateAvg = fbs.slice(-8).reduce((a, p) => a + p.mph, 0) / 8;
      if (early - lateAvg >= 2) {
        add({ id: 'velocityDown', key: `vd:${pid}:${Math.floor(fbs.length / 20)}`, salience: 0.7, relevance: 0.8, opener: 'color', build: (rng, o) => script([
          { who: 'A', t: ['$p\'s fastball is down about $d miles an hour from where it started.', 'The velocity has dropped a couple of ticks on $p, $a earlier, $l now.'] },
          { who: 'B', t: ['That is {the thing|what} you {watch|look} for.', '{Fatigue|The workload} {could be|is} showing.', 'Is the {bullpen|manager} watching that too?', 'He may be {tiring|slowing down}.', 'A couple of ticks is the first sign.', 'The hitters notice that before anybody.'] },
        ], { ...S, d: numWord(Math.round(early - lateAvg)), a: Math.round(early), l: Math.round(lateAvg) }, rng, o) });
      } else if (lateAvg - early >= 2) {
        add({ id: 'velocityUp', key: `vu:${pid}:${Math.floor(fbs.length / 20)}`, salience: 0.5, relevance: 0.6, opener: 'color', build: (rng, o) => script([
          { who: 'A', t: ['$p is throwing harder now than at the start.', 'The fastball has {picked up|ticked up} for $p, about $d miles an hour.'] },
          { who: 'B', t: ['{Getting stronger|Finding another gear} as the game goes on.', 'That is {unusual|not what you usually see}.', 'He is {getting stronger|finding another gear} as the game goes on.'], opt: true },
        ], { ...S, d: numWord(Math.round(lateAvg - early)) }, rng, o) });
      }
    }
    const pr = pit?.ratings;
    if (pr?.control && pr.control >= 65) {
      add({ id: 'controlGrade', key: `ctl:${pid}`, salience: 0.35, relevance: 0.3, opener: 'color', build: (rng, o) => script([
        { who: 'A', t: mix.total >= 20 ? ['$p has a $g grade on command, so expect the {corners|edges}.', '$g-grade control for $p, and it {shows|has shown} tonight.'] : ['$p has a $g grade on command, so expect the {corners|edges}.', '$g-grade control for $p. He lives on the edges.'] },
        { who: 'B', t: ['That is why the walks are {rare|so few}.', 'Painting the corners.', 'That is why he does not walk many.'], opt: true },
      ], { ...S, g: grade(pr.control) }, rng, o) });
    }
  }

  // ---- hitting -----------------------------------------------------------------------------------------------------------
  if (bat && bid) {
    const pas = log.batterPas(bid);
    const last2 = pas.slice(-2);
    if (last2.length === 2 && last2.every((p) => isHit(p.result))) {
      add({ id: 'hotBat', key: `hot:${bid}:${pas.length}`, salience: 0.65, relevance: 1, opener: 'pxp', build: (rng, o) => script([
        { who: 'A', t: ['$b has hits in {both|each of the last two} trips.', '$b is locked in so far.', 'Two hits in a row for $b.'] },
        { who: 'B', t: ['{Seeing|Squaring up} the ball {well|nicely} tonight.', 'That is a hitter {who has figured it out|in a rhythm}.', '$p has to be careful here.', 'He is in a rhythm.', 'He has found his timing.', 'He is seeing it like a beach ball tonight.', 'Everything is on the barrel for him.'] },
        { who: 'A', t: ['{Pitch|Work} {carefully|around the zone}.', 'Third time is the charm?', 'He will be hoping to make it three in a row.'], opt: true },
      ], S, rng, o) });
    }
    if (bl && bl.so >= 2) {
      add({ id: 'coldBat', key: `cold:${bid}:${bl.so}`, salience: 0.55, relevance: 1, opener: 'color', build: (rng, o) => script([
        { who: 'A', t: ['$b has struck out $kt tonight.', '$kt strikeouts for $b so far.'] },
        { who: 'B', t: ['{Not the night|A rough night} for $b.', 'The hitter {will want|needs} to put the ball in play here.', 'A chance to {get one back|turn the night around}.', 'He needs to put the ball in play here.', 'He is looking to turn the night around.', 'One good swing changes the whole night.', 'Nothing has gone his way so far.'] },
      ], { ...S, kt: bl.so === 2 ? 'twice' : numWord(bl.so) + ' times' }, rng, o) });
    }
    if (bl && bl.so === 3 && isK(pas[pas.length - 1]?.result)) {
      add({ id: 'hatTrick', key: `hat:${bid}`, salience: 0.6, relevance: 0.9, opener: 'color', build: (rng, o) => script([
        { who: 'A', t: ['Three strikeouts for $b. That is a hat trick, and not the good kind.', '$b has struck out three times. Hat trick.'] },
        { who: 'B', t: ['One more and it is a golden sombrero.', 'Nobody wants that one.', 'He does not want a fourth.', 'One more and he gets the golden sombrero.'] },
      ], S, rng, o) });
    }
    if (bl && bl.hr >= 1) {
      add({ id: 'homerTonight', key: `hr:${bid}:${bl.hr}`, salience: 0.6, relevance: 1, opener: 'pxp', build: (rng, o) => script([
        { who: 'A', t: ['$b {already has|has} $hr tonight.'], },
        { who: 'B', t: ['{Be careful here|Careful here}, $p. That is {dangerous|a threat}.', '{Do not leave it|Do not hang one} over the plate for $b.', 'That swing can change the game.', 'He can change the game with one swing.', 'Do not {leave|hang} one over the plate for him, $p.', 'He has already done damage tonight.', 'Pitch him like he is the most dangerous man in the park, because tonight he is.'] },
      ], { ...S, hr: bl.hr === 1 ? 'a homer' : `${numWord(bl.hr)} homers` }, rng, o) });
    }
    if (bl && bl.ab >= 2 && bl.h === bl.ab) {
      add({ id: 'perfectNight', key: `perf:${bid}:${bl.ab}`, salience: 0.55, relevance: 0.9, opener: 'pxp', build: (rng, o) => script([
        { who: 'A', t: ['$b is $h for $ab tonight.', '$h for $ab so far for $b.', '$h for $ab for $b.'] },
        { who: 'B', t: ['Nobody has gotten $b out on contact yet.', '{Perfect|Flawless} so far.', 'The pitchers {have no answer|are having trouble}.', 'They have not gotten him out yet tonight.', 'He has not made an out yet.'], opt: true },
      ], { ...S, h: bl.h, ab: bl.ab }, rng, o) });
    }
    if (pid) {
      const bvp = log.batterVsPitcher(bid, pid);
      if (bvp.pa >= 2) {
        add({ id: 'batterVsPitcher', key: `bvp:${bid}:${pid}:${bvp.pa}`, salience: 0.5, relevance: 1, opener: 'color', build: (rng, o) => script([
          { who: 'A', t: ['$b is $h for $pa against $p tonight.', 'This is the {third|$npa} look at $p for $b, {and so far|with} $h hits in $pa trips.'] },
          { who: 'B', t: ['{Hitters|Batters} usually {get better|see it better} each time through.', 'That is the {advantage|edge} of {seeing|facing} a pitcher again.', 'Knowing what is coming helps.', 'He sees it better each time through.', 'Every look tells a hitter a little more.', 'Now $p has to show him something new.', 'He has a book on $p by now.', 'The cat-and-mouse part of the night.'] },
        ], { ...S, h: bvp.hits, pa: bvp.pa, npa: ordWord(bvp.pa + 1) }, rng, o) });
      }
      const tt = log.timesThrough(bid, pid);
      if (tt >= 3) {
        add({ id: 'thirdTime', key: `tt:${bid}:${pid}:${tt}`, salience: 0.55, relevance: 1, opener: 'color', build: (rng, o) => script([
          { who: 'A', t: ['$ord3 time $b has seen $p tonight.', '$ord3b look at $p for $b.'] },
          { who: 'B', t: ['The third time through the order is {when|where} hitters {tend to|usually} {do damage|have the advantage}.', 'There is {an old|a} baseball saying about the third time through.', 'He has {seen enough of|a good read on} $p by now.', 'This is when a manager starts thinking about the bullpen.', 'He has seen everything $p has by now.', 'The numbers say advantage hitter.'] },
        ], { ...S, ord3: tt === 3 ? 'The third' : 'Another', ord3b: tt === 3 ? 'Third' : 'Another' }, rng, o) });
      }
    }
    const br = bat.ratings;
    if (br?.power && br.power >= 70) {
      add({ id: 'powerGrade', key: `pow:${bid}`, salience: 0.4, relevance: 0.5, opener: 'color', build: (rng, o) => script([
        { who: 'A', t: ['$b has $g-grade power.', '$g on the power scale for $b.'] },
        { who: 'B', t: ['{That is|You can see} why {$p is careful|the pitch locations matter}.', 'One swing can do it.', 'He can change the game with one swing.', 'Mistakes up in the zone leave the park against him.', 'You pitch him carefully, and you still worry.'], opt: true },
      ], { ...S, g: grade(br.power) }, rng, o) });
    }
    if (br?.contact && br.contact >= 70) {
      add({ id: 'contactGrade', key: `con:${bid}`, salience: 0.35, relevance: 0.4, opener: 'color', build: (rng, o) => script([
        { who: 'A', t: ['$b {puts the ball in play|rarely strikes out}: a $g grade for contact.', '$g-grade contact skills for $b.'] },
        { who: 'B', t: ['{Tough|Hard} to strike out.', 'That {makes the two-strike count|is what makes two strikes} {less comfortable|less safe} for the pitcher.', 'He is {tough|hard} to strike out.'], opt: true },
      ], { ...S, g: grade(br.contact) }, rng, o) });
    }
    if (paPitches.length >= 7) {
      add({ id: 'longAtBat', key: `long:${log.cur?.n}`, salience: 0.6, relevance: 1, tense: true, opener: 'pxp', build: (rng, o) => script([
        { who: 'A', t: ['$n pitches in this at-bat.', 'Long at-bat, $n pitches so far.', '$b has seen $n pitches in this at-bat, and he is still in there.'] },
        { who: 'B', t: ['And $b is {not giving in|battling}.', '$p needs to finish this.', 'Somebody has to {blink|give}.', 'That is a battle.', 'Every pitch here wears on the pitcher a little.', 'Neither one is giving in.'] },
      ], { ...S, n: numWord(paPitches.length) }, rng, o) });
    }
  }

  // ---- baserunning ---------------------------------------------------------------------------------------------------------
  const rIdx = c.runnerSpeed?.findIndex((s) => s !== undefined && s >= 65) ?? -1;
  if (rIdx >= 0 && c.runners[rIdx] && c.runnerNames?.[rIdx] && c.outs < 2 && rIdx < 2) {
    const rn = lastNameOf(c.runnerNames[rIdx]!);
    add({ id: 'speedster', key: `spd:${rn}:${c.inning}`, salience: 0.6, relevance: 0.9, opener: 'pxp', tense: true, build: (rng, o) => script([
      { who: 'A', t: ['$r on $bs with a $g on the speed scale.', '$r is a $g runner, on {first|$bs}.'] },
      { who: 'B', t: ['$p has to {be quick to the plate|keep an eye on that}.', 'That is a {real|serious} stolen-base threat.', 'Watch for the {jump|steal} here.', 'He is a {real|serious} stolen-base threat.', 'He could {go|run} at any moment.', 'Every throw over is a little message.', 'The whole infield knows he can go.'] },
    ], { ...S, r: rn, g: grade(c.runnerSpeed![rIdx]), bs: ['first', 'second', 'third'][rIdx] }, rng, o) });
  }
  const stealers = [...log.steals.entries()].filter(([, [att, ok]]) => ok >= 2);
  if (stealers.length) {
    const [id, [att, ok]] = stealers[0];
    const name = c.person?.(id)?.name;
    if (name) add({ id: 'stealCount', key: `stl:${id}:${ok}`, salience: 0.5, relevance: 0.5, opener: 'pxp', build: (rng, o) => script([
      { who: 'A', t: ['$r has {stolen|swiped} $ok bases tonight.', '$ok steals for $r tonight.'] },
      { who: 'B', t: ['A {real|constant} {nuisance|problem} on the bases.', 'Pitchers are {not holding|having trouble holding} $r.', 'Nobody has been able to hold him.', 'He is a {real|constant} problem on the bases.'], opt: true },
    ], { ...S, r: lastNameOf(name), ok: numWord(ok) }, rng, o) });
    void att;
  }

  // ---- game situation -------------------------------------------------------------------------------------------------------
  if (c.runners[0] && c.runners[1] && c.runners[2]) {
    add({ id: 'loaded', key: `bl:${c.inning}:${c.half}:${log.cur?.n}`, salience: 0.8, relevance: 1, tense: true, opener: 'pxp', build: (rng, o) => script([
      { who: 'A', t: ['Bases loaded, $outsw out.', 'Bases loaded. Here we go.', 'The bases are loaded.'] },
      { who: 'B', t: ['Everything {on the line|matters} here.', '$p cannot {afford|walk} anybody.', 'Big {moment|spot} for $b.', 'Nowhere to put him.', 'This is the at-bat of the game so far.', 'The crowd is up.'] },
    ], S, rng, o) });
  }
  if (rsp && c.outs === 2) {
    add({ id: 'twoOutRsp', key: `2o:${log.cur?.n}`, salience: 0.7, relevance: 1, tense: true, opener: 'pxp', build: (rng, o) => script([
      { who: 'A', t: ['Two out, runner in scoring position.', 'Two outs, and a runner in scoring position.', 'Two down, and a runner in scoring position.', 'A runner in scoring position with two away.'] },
      { who: 'B', t: ['One hit and {it is a run|they score}.', '$p is {one out|one pitch} away from {getting out of it|escaping}.', '$b with a chance to {change the game|be the hero}.', 'Big pitch coming up.', 'With two outs, the runner goes on contact.', 'This is the at-bat of the inning.'] },
    ], S, rng, o) });
  }
  if (tight) {
    add({ id: 'tightLate', key: `tl:${c.inning}:${c.half}`, salience: 0.65, relevance: 0.9, tense: true, opener: 'pxp', build: (rng, o) => script([
      { who: 'A', t: ['$ord inning, $score.', 'It is {tight|close} in the $ord. $score.'] },
      { who: 'B', t: ['Every pitch {matters|counts} now.', 'One swing {and it is over|changes everything}.', 'You can {feel|hear} it in the {ballpark|crowd}.', 'Nobody is sitting down now.', 'This is why you stay to the end.', 'Managers earn their money in innings like this.'] },
    ], S, rng, o) });
  }
  if (diff !== 0 && Math.abs(diff) >= 6 && c.inning >= 6) {
    add({ id: 'blowout', key: `blow:${c.inning}`, salience: 0.45, relevance: 0.6, opener: 'color', build: (rng, o) => script([
      { who: 'A', t: ['$lead lead {comfortably|by a good margin}, $score.', '$score. $lead is {in control|cruising}.'] },
      { who: 'B', t: ['{Time|Hard} for the {bullpen|bench} to {get some work|see action}.', 'It would take {a big inning|something special} from $trail.', 'Not much drama left.', 'The scoreboard tells the story.', 'You play it out and learn something.', 'This is when the young guys get some innings.'] },
    ], S, rng, o) });
  }
  const trailingMax = c.half === 'bottom' ? log.maxDeficit.home : log.maxDeficit.away;
  const myScore = batScore, theirScore = fldScore;
  if (trailingMax >= 3 && myScore >= theirScore && c.inning >= 4) {
    add({ id: 'comeback', key: `cb:${c.inning}:${c.half}`, salience: 0.75, relevance: 0.8, opener: 'color', build: (rng, o) => script([
      { who: 'A', t: ['$batTeam {were|was} down by $n and have {come all the way back|fought back}.', 'From $n down to {even|ahead}: {quite|what} a comeback for $batTeam.'] },
      { who: 'B', t: ['{Never|Not} {out of it|counted out}.', 'That is {a team that does not quit|resilience}.', 'And {the momentum|the crowd} is with them.', 'You cannot count this club out.', 'That dugout is alive now.'] },
    ], { ...S, n: numWord(trailingMax) }, rng, o) });
  }
  const sl = log.scorelessStreak(c.half === 'top' ? 'home' : 'away', c);
  if (sl >= 3) {
    add({ id: 'zeroes', key: `zero:${c.half}:${sl}`, salience: 0.55, relevance: 0.7, opener: 'pxp', build: (rng, o) => script([
      { who: 'A', t: ['$fldTeam pitching has put up $n zeroes in a row.', '$n scoreless innings in a row for $fldTeam.'] },
      { who: 'B', t: ['{Shutting|Locking} the door.', '$batTeam {cannot|have not been able to} {get anything going|break through}.', 'Pitching {wins|has been} the story.', 'Somebody has to crack.', 'The hitters keep going back to the dugout with nothing.'] },
    ], { ...S, n: numWord(sl) }, rng, o) });
  }
  if (log.leadChanges >= 2) {
    add({ id: 'seesaw', key: `ss:${log.leadChanges}`, salience: 0.5, relevance: 0.5, opener: 'color', build: (rng, o) => script([
      { who: 'A', t: ['The lead has changed hands $n times tonight.'], },
      { who: 'B', t: ['{This game|It} is {a seesaw|back and forth}.', 'Nobody {is comfortable|can relax} in this one.', 'Back and forth, all night.', 'Nobody is leaving early tonight.'] },
    ], { ...S, n: numWord(log.leadChanges) }, rng, o) });
  }
  // ---- the crowd and the man just announced (a favourite cheered, a villain booed: only when they really did) --------------
  const fan = c.fan;
  if (fan) {
    const F = { ...S, f: lastNameOf(fan.name), seasons: fan.years === 1 ? 'one season' : `${numWord(fan.years)} seasons` };
    const key = `fan:${fan.id}:${fan.pa}`;
    const L = FAN_LINES;
    if (fan.side === 'favourite') {
      const open = fan.pitcher ? (fan.kind === 'closer' ? L.closerIn : L.pitcherIn) : fan.pa === 1 ? L.favourite : L.favouriteAgain;
      add({ id: 'fanFavourite', key, salience: 0.62, relevance: 1, opener: 'either', build: (rng, o) => script([
        { who: 'A', t: open },
        { who: 'B', t: L.why[fan.kind] ?? L.why.star, opt: true },
      ], F, rng, o) });
    } else {
      const why = fan.kind === 'former' ? L.why.former : fan.kind === 'rival' ? L.why.rival : fan.burnedBy === 'hr' ? L.why.burnedHr : L.why.burnedRbi;
      add({ id: 'fanVillain', key, salience: 0.6, relevance: 1, opener: 'either', build: (rng, o) => script([
        { who: 'A', t: L.villain },
        { who: 'B', t: why, opt: true },
        { who: 'A', t: L.villainEnd, opt: true },
      ], F, rng, o) });
    }
  }
  if ((c.crowd ?? 0) > 0.6 && !fan) {
    add({ id: 'crowd', key: `crowd:${c.inning}`, salience: 0.4, relevance: 0.6, opener: 'color', build: (rng, o) => script([
      { who: 'A', t: ['Listen to this crowd.', 'The crowd {is loving|is into} this.', 'Hear that? The place is {alive|buzzing}.'] },
      { who: 'B', t: ['{They know|They can feel} what is {at stake|coming}.', 'That is what baseball is for.', 'You {cannot|can not} {fake|buy} {that|an atmosphere like that}.', 'That is a ballpark that cares.', 'The players feed off that.'], opt: true },
    ], S, rng, o) });
  }
  // ---- the pitch clock ----------------------------------------------------------------------------------------------------
  const clk = c.clock;
  if (clk && clk.running && (clk.kind === 'pitch' || clk.kind === 'betweenBatters') && clk.remaining <= 3.5 && clk.remaining > 1 && pit) {
    // (once a half-inning at most: a deliberate worker is near the end of the clock often)
    add({ id: 'clockLow', key: `clk:${c.inning}${c.half}`, salience: 0.3, relevance: 1, tense: true, opener: 'pxp', build: (rng, o) => script([
      { who: 'A', t: ['$p is going to have to get set... the clock is running.', 'Clock is winding down on $p.', '{Under five|Four} seconds on the clock, and $p still has not come set.', 'He had better get going, the clock is ticking.', 'Tick, tick. $p needs to get going.', 'The clock is in single digits on $p.'] },
    ], S, rng, o) });
  }
  if (clk && clk.kind === 'pitch' && clk.disengagementsLeft === 0 && c.runners.some(Boolean) && pit) {
    add({ id: 'clockDiseng', key: `dis:${log.cur?.n}`, salience: 0.45, relevance: 0.9, opener: 'color', build: (rng, o) => script([
      { who: 'A', t: ['That is both of his disengagements used up, $other.', '$p has stepped off twice now. He is out of disengagements.'] },
      { who: 'B', t: ['So if he throws over again and does not get him, it is a balk. The runner knows it, too.', 'One more throw over that does not get the runner is a balk. That runner can take a bigger lead now.'] },
      { who: 'A', t: ['{Watch for the steal here.|The rule changes the whole cat-and-mouse game.}'], opt: true },
    ], S, rng, o) });
  }
  if (clk && pit && c.pitcherTempo !== undefined && (c.pitcherTempo >= 1.12 || c.pitcherTempo <= 0.88)) {
    const quick = c.pitcherTempo >= 1.12;
    add({ id: quick ? 'quickWorker' : 'slowWorker', key: `tempo:${pit.id}`, salience: 0.3, relevance: 0.5, opener: 'pxp', build: (rng, o) => script(quick ? [
      { who: 'A', t: ['$p works fast. Gets the ball back and he is ready to go.', 'You do not need a pitch clock for $p. He works in a hurry.', '$p is one of the quickest workers you will see.'] },
      { who: 'B', t: ['Defenses love that. Keeps everybody on their toes behind him.', 'Hitters hate it, though. He does not give them a chance to breathe.', 'I loved catching guys like that. Get it, sign, throw, done.'], opt: true },
    ] : [
      { who: 'A', t: ['$p takes his time out there. He will use most of that clock.', '$p is a deliberate worker. He is up against the clock just about every pitch.', 'He lives on the edge of the clock, $p does.'] },
      { who: 'B', t: ['Before the clock came in, he would have been a twenty-five-second guy, easy.', 'He has had to speed up a lot since the clock came in.', 'You can see him peek at the clock before he comes set.'], opt: true },
    ], S, rng, o) });
  }
  if (clk && c.inning >= 2) {
    add({ id: 'clockRule', key: 'clockrule', salience: 0.14, relevance: 0.2, opener: 'pxp', build: (rng, o) => script([
      { who: 'A', t: ['Fifteen seconds with the bases empty, eighteen with a runner on. The pitch clock has changed the rhythm of this game.', 'Games are a half hour shorter since the pitch clock came in.', 'You notice the pace now. No more pitchers wandering around the mound between pitches.'] },
      { who: 'B', t: ['As a catcher I would have hated it. I used to take my time going back to the plate, give my pitcher a breather.', 'The hitters had to adjust too. One timeout per at-bat, and you have to be in the box with eight seconds left.', 'I was skeptical, $other. But I like it. More action, less standing around.'] },
      { who: 'A', t: ['{And the fans seem to like it.|Hard to argue with a game that moves.}'], opt: true },
    ], S, rng, o) });
  }
  if (bat && pit && bat.hand && pit.hand && bat.hand !== 'S' && pit.hand !== 'S' && bat.hand === pit.hand) {
    add({ id: 'sameHand', key: `hand:${bat.hand}${pit.hand}:${c.inning}`, salience: 0.22, relevance: 0.4, opener: 'color', build: (rng, o) => script([
      { who: 'A', t: ['$h against $h2 here.', 'It is $h on $h2 in this matchup.', '$h facing $h2.', 'A same-side matchup here, $h against $h2.'] },
      { who: 'B', t: ['That {usually favors|tends to favor|helps} the pitcher.', '{The break|The angle} {works|plays} for $p.', 'That is the matchup the dugout wanted.', 'The breaking ball moves away from the hitter here.', 'Tougher look for $b.'], opt: true },
    ], { ...S, h: bat.hand === 'L' ? 'lefty' : 'righty', h2: bat.hand === 'L' ? 'lefty' : 'righty' }, rng, o) });
  }
  return stories;
}

/** neutral lines when nothing is interesting: only facts about the moment (inning, score, outs), never a claim about the players */
export function neutralStories(c: BoothCtx): Story[] {
  const S = slotsOf(c);
  const out: Story[] = [];
  // the score fillers (score, tied, lead) say the same fact: one of them per score and inning
  const add = (id: string, lines: Line[], ok = true, tense = false) => ok && out.push({ id, key: /^n\.(score|tied|lead)$/.test(id) ? `n:score:${c.score.away}-${c.score.home}:${c.inning}` : `n:${id}`, salience: 0.1, relevance: 0.2, tense, opener: 'either', build: (rng, o) => script(lines, S, rng, o) });
  add('n.inning', [{ who: 'A', t: ['We are in the $half of the $ord.', 'It is the $half of the $ord inning.', 'Here in the $half of the $ord.', 'We are rolling along in the $ord.'] }, { who: 'B', t: ['Plenty of baseball left.', 'Still a lot of game ahead.', 'Lots of baseball to play.', 'Long way to go.'], opt: true }], c.inning >= 2 && c.inning <= 6);
  add('n.score', [{ who: 'A', t: ['It is $score in the $ord.', 'The score: $score.', 'Here in the $ord, $score.', 'Checking the board: $score.'] }, { who: 'B', t: ['A game that is still up for grabs.', 'Anybody\'s ballgame.', 'Nothing decided yet.', 'Plenty of time for either side.', 'Up for grabs.'], opt: true }], Math.abs(c.score.home - c.score.away) <= 2 && c.score.home + c.score.away > 0);
  add('n.tied', [{ who: 'A', t: ['All tied up at $tiescore.', 'Tied at $tiescore.', 'Even at $tiescore.', 'All square at $tiescore.'] }, { who: 'B', t: ['And the next run could matter a lot.', 'Every run counts double in a tie game, $other.'], opt: true }], c.score.home === c.score.away && c.score.home > 0 && c.inning >= 4);
  add('n.lead', [{ who: 'A', t: ['$lead lead by $diffw.', '$lead are up $diffw.', '$lead in front by $diffw.'] }, { who: 'B', t: ['Not a safe margin.', 'That can disappear in a hurry.', 'One swing changes that.', 'A lead like that is never safe in this park.', 'Plenty of time to make that up.'], opt: true }], S.lead !== undefined && Number(S.diff) > 0 && Number(S.diff) <= 3);
  add('n.outs', [{ who: 'A', t: c.outs === 2 ? ['Two out, and the pressure is on.', 'Two outs here.', 'Two away in the $half of the $ord.', 'Down to the last out of the inning.', 'Two gone, one to go.'] : ['One out.', 'One down, two to go.', 'One away in the $half of the $ord.', 'One out here in the $ord.', 'One gone.'] }], c.outs > 0);
  return out;
}

export interface PickerCfg {
  /** max topic-less (neutral) lines in a row */
  maxNeutralInRow: number;
}

/**
 * Stories whose facts come up nearly every plate appearance (a first-pitch curveball, two fastballs and a change, righty on righty ...): each is
 * told at most `max` times a game and `gap` plate appearances apart, so the conversation does not keep circling back to the same observation.
 */
export const STORY_CAPS: Record<string, { max: number; gap: number }> = {
  firstPitchBreaking: { max: 8, gap: 3 },
  sequence: { max: 9, gap: 3 },
  threeBreakers: { max: 5, gap: 3 },
  fastballStreak: { max: 7, gap: 3 },
  sameHand: { max: 7, gap: 3 },
  batterVsPitcher: { max: 7, gap: 2 },
  thirdTime: { max: 5, gap: 3 },
  pitchMix: { max: 5, gap: 4 },
  cruising: { max: 6, gap: 3 },
  rattled: { max: 5, gap: 3 },
  twoOutRsp: { max: 7, gap: 2 },
  clockLow: { max: 7, gap: 3 },
  fanFavourite: { max: 3, gap: 3 },
  fanVillain: { max: 2, gap: 3 },
  zeroes: { max: 4, gap: 4 },
  'n.outs': { max: 11, gap: 2 },
  'n.inning': { max: 6, gap: 4 },
};

/**
 * Picks the next topic: scores every story by salience, relevance, novelty and a little noise; never repeats a key; falls back to a
 * neutral line (at most `maxNeutralInRow` times in a row, then it prefers silence).
 */
export class TopicPicker {
  private used = new Map<string, number>();
  /** per story id: times told this game and the plate appearance it was last told in (for `STORY_CAPS`) */
  private toldIds = new Map<string, { n: number; pa: number }>();
  private pa = 0;
  private recentIds: string[] = [];
  private neutralInRow = 0;
  private seq = 1;
  constructor(private rng: Rng, private cfg: PickerCfg = { maxNeutralInRow: 3 }) {}

  /**
   * `extra`: stories the booth adds (callbacks, running jokes, long-lull talk, second-guessing a move); `maxTurns`: longer exchanges in long lulls;
   * `fresh(text)`: false for a line said recently (the story is rebuilt with other words, or skipped).
   */
  next(log: GameLog, c: BoothCtx, tenseMoment: boolean, o: { extra?: Story[]; maxTurns?: number; fresh?: (text: string) => boolean } = {}): Topic | null {
    this.maxTurns = o.maxTurns ?? 4;
    this.names = new Set(Object.values(slotsOf(c)).filter((v): v is string => typeof v === 'string').flatMap((v) => v.split(/[\s,]+/)).filter((w) => /^[A-Z][a-z]/.test(w)));
    const fresh = o.fresh ?? (() => true);
    const build = (s: Story, opener: VoiceId) => {
      for (let k = 0; k < 3; k++) {
        const turns = s.build(this.rng, opener);
        if (!turns || turns.every((x) => fresh(x.text))) return turns;
      }
      return null;
    };
    this.pa = log.pas.length;
    const capped = (id: string) => {
      const cap = STORY_CAPS[id];
      const u = this.toldIds.get(id);
      return !!cap && !!u && (u.n >= cap.max || this.pa - u.pa < cap.gap);
    };
    const stories = [...collectStories(log, c), ...(o.extra ?? [])].filter((s) => !this.used.has(s.key) && !capped(s.id));
    const scored = stories.map((s) => {
      const novelty = this.recentIds.includes(s.id) ? 0 : 0.3 - Math.min(0.3, this.recentIds.filter((x) => x === s.id).length * 0.1);
      const tenseFit = tenseMoment ? (s.tense ? 0.15 : -0.1) : s.tense ? -0.05 : 0.05;
      return { s, score: s.salience * 1.0 + s.relevance * 0.35 + novelty + tenseFit + this.rng() * 0.15 };
    });
    scored.sort((a, b) => b.score - a.score);
    for (const { s } of scored) {
      const opener: VoiceId = s.opener === 'either' || !s.opener ? (this.rng() < 0.5 ? 'pxp' : 'color') : s.opener;
      const turns = build(s, opener);
      if (turns && turns.length) return this.take(s, turns, false);
    }
    // nothing interesting: a neutral line (rarely, and never too many in a row)
    if (this.neutralInRow >= this.cfg.maxNeutralInRow) {
      this.neutralInRow = 0; // stay quiet this time, then allow it again
      return null;
    }
    if (this.rng() > 0.4) return null; // fillers are rare
    const neutral = neutralStories(c).filter((s) => !this.recentIds.slice(-6).includes(s.id) && !this.used.has(s.key) && !capped(s.id));
    while (neutral.length) {
      const i = Math.floor(this.rng() * neutral.length);
      const s = neutral.splice(i, 1)[0];
      const opener: VoiceId = this.rng() < 0.5 ? 'pxp' : 'color';
      const turns = build(s, opener);
      if (turns && turns.length) return this.take(s, turns, true);
    }
    return null;
  }

  private maxTurns = 4;
  /** proper names of the moment (players, clubs): they keep their capital after "Well, Lyle, ..." */
  private names = new Set<string>();
  /** topics since the last time one voice called the other by name */
  private sinceAddress = 0;

  private take(s: Story, turns: TopicTurn[], neutral: boolean): Topic {
    if (!neutral || s.key.startsWith('n:score:')) this.used.set(s.key, 1);
    this.neutralInRow = neutral ? this.neutralInRow + 1 : 0;
    this.recentIds.push(s.id);
    if (this.recentIds.length > 40) this.recentIds.shift();
    this.toldIds.set(s.id, { n: (this.toldIds.get(s.id)?.n ?? 0) + 1, pa: this.pa });
    // a short exchange (longer in a long lull)
    return { id: this.seq++, tag: s.id, turns: this.address(turns.slice(0, this.maxTurns)) };
  }

  /**
   * Now and then (not more than every third topic) a question is put to the partner by name ("..., Biscuit?") and the answer starts with his name
   * ("Well, Lyle, ..."), like two people who have worked together for years. Lines that already name the partner are left alone.
   */
  private address(turns: TopicTurn[]): TopicTurn[] {
    this.sinceAddress++;
    if (turns.length < 2 || this.sinceAddress < 4 || this.rng() > 0.35) return turns;
    const out = turns.map((t) => ({ ...t }));
    const named = (t: TopicTurn) => CAST.pbp.calledBy.concat(CAST.color.calledBy).some((n) => t.text.includes(n));
    if (out.some(named)) return turns;
    const q = out.findIndex((t, i) => i < out.length - 1 && /\?$/.test(t.text) && out[i + 1].speaker !== t.speaker);
    if (q >= 0) {
      const to = addressOf(out[q].speaker === 'pxp' ? 'color' : 'pxp', this.rng);
      out[q].text = out[q].text.replace(/\?$/, `, ${to}?`);
    } else {
      // the answer (second turn, a real one: six words or more) opens with the partner's name
      const a = out[1];
      if (a.text.split(/\s+/).length < 6) return turns;
      const to = addressOf(a.speaker === 'pxp' ? 'color' : 'pxp', this.rng);
      const first = (a.text.split(/\s+/)[0] ?? '').replace(/[^A-Za-z']/g, '');
      if (/^(Agreed|Right|Exactly|Yes|Yeah|Well)$/.test(first)) return turns;
      const no = /^(Not|No|Nope)$/.test(first);
      // a name keeps its capital (the players and clubs of this moment), anything else is lowercased
      const keepCap = /^(I|I'm|I'd|I'll|I've)$/.test(first) || this.names.has(first);
      a.text = `${no || this.rng() < 0.5 ? 'Well' : 'Yeah'}, ${to}, ${keepCap ? a.text : a.text.charAt(0).toLowerCase() + a.text.slice(1)}`;
    }
    this.sinceAddress = 0;
    return out;
  }

  reset() {
    this.used.clear();
    this.toldIds.clear();
    this.recentIds = [];
    this.neutralInRow = 0;
  }
}

void isK;

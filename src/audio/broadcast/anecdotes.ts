/**
 * The booth's own stories: what two old baseball men tell each other while the game catches its breath (a mound visit, a pitching change, a hitter's
 * walk-up, a lopsided score). None of it is about tonight's players, so none of it can be wrong about them: these are Lyle's twenty-six seasons and
 * his pencil scorebook, Biscuit's eleven years as a backup catcher for four clubs (.219, nine home runs, number six a grand slam with the wind
 * blowing out, number four off a lefty nobody hit, about one runner in five thrown out), the press box, the park and the game itself. Nobody real,
 * no real clubs, no brands; players are "he", umpires are "the umpire", everybody else stays neutral.
 *
 * Each anecdote is one exchange (alternatives within a line say the same thing, so any combination makes sense). It fits a kind of moment
 * (`when`); the booth tells one now and then in a long lull, picks the one heard longest ago (the booth's memory spans games) and never the same
 * one twice in a game.
 */
import type { Line } from './stories';

export type AnecdoteWhen =
  /** any long lull from the second inning on */
  | 'lull'
  /** the catcher comes to bat, or goes to the mound */
  | 'catcher'
  /** a mound visit */
  | 'visit'
  /** a pitching change (after it is called) */
  | 'change'
  /** a day game / a night game */
  | 'day'
  | 'night'
  /** one club far ahead from the fifth on */
  | 'blowout'
  /** nobody has scored after three */
  | 'scoreless'
  /** the first three innings */
  | 'early'
  /** a runner stole a base a moment ago */
  | 'steal'
  /** a ball left the park this inning */
  | 'homer'
  /** an error this inning */
  | 'error'
  /** a double play this inning */
  | 'dp'
  /** extra innings */
  | 'extra'
  /** the pitcher on the mound has struck out six or more */
  | 'strikeouts';

export interface Anecdote {
  id: string;
  when: AnecdoteWhen;
  /** who opens */
  a: 'pxp' | 'color';
  lines: Line[];
}

const A = (t: string[], opt = false): Line => ({ who: 'A', t, opt });
const B = (t: string[], opt = false): Line => ({ who: 'B', t, opt });

export const ANECDOTES: Anecdote[] = [
  // ---- Biscuit behind the plate ---------------------------------------------------------------------------------------------------------
  { id: 'bis.signs', when: 'catcher', a: 'pxp', lines: [
    A(['Did you ever get crossed up on the signs, $other?', 'Catchers get crossed up on the signs all the time. Did it ever happen to you, $other?']),
    B(['Once, in Triple-A. I put down one finger, got a curveball right off the shin guard, and the pitcher swore it was my handwriting.']),
    A(['Your handwriting.', 'Your handwriting, he said.'], true),
  ] },
  { id: 'bis.knuckler', when: 'catcher', a: 'pxp', lines: [
    A(['Did you ever have to catch a knuckleball, $other?', 'Ever catch a knuckleballer, $other?']),
    B(['One spring. I wore the big mitt, the one like a pizza pan, and I still chased half of them to the backstop.', 'For a month in Double-A. The ball was moving, the glove was moving, and the only thing standing still was my career.']),
    A(['That sounds about right.', 'Nobody catches it. They just survive it.'], true),
  ] },
  { id: 'bis.knees', when: 'catcher', a: 'color', lines: [
    A(['You know what nobody tells a young catcher, $other? Your knees keep their own stats.', 'Every catcher has a knee that forecasts the weather. Mine is usually right about rain.']),
    B(['And what do the knees say tonight?', 'What is the knee calling for tonight?']),
    A(['Sit down, Hollis, and have a sandwich.', 'Clear skies, and a sandwich in the fifth inning.']),
  ] },
  { id: 'bis.gear', when: 'catcher', a: 'pxp', lines: [
    A(["Somebody called the catcher's gear the tools of ignorance once, and it stuck.", "The tools of ignorance, they used to call the catcher's gear."]),
    B(['I took that personally for eleven years, $other. The ignorance part was accurate, but I took it personally.']),
  ] },
  { id: 'bis.gear2', when: 'catcher', a: 'color', lines: [
    A(['People ask what the hardest part of catching is. Getting the gear on in a hurry when you made the last out of the inning.', 'The hardest thing about catching, $other? Making the last out, then strapping all the gear back on in thirty seconds.']),
    B(['And you made a lot of last outs.', 'You had a lot of practice at that.']),
    A(['I was very quick with the shin guards.', 'Fastest shin guards in the league.']),
  ] },
  { id: 'bis.cake', when: 'steal', a: 'color', lines: [
    A(['My best year throwing runners out, I got one in four. My manager bought me a cake.', 'One season I threw out one runner in four, and the manager bought the whole team a cake.']),
    B(['A cake.', 'A whole cake.']),
    A(['Chocolate. I earned every bite.', 'Chocolate. Best year of my career.'], true),
  ] },
  { id: 'bis.ovation', when: 'steal', a: 'color', lines: [
    A(['I threw out three runners in a row once, $other. The dugout gave me a standing ovation.', 'Three straight runners thrown out, one week in July. The dugout stood up and clapped.']),
    B(['Sarcastically, I assume.', 'Was it sarcastic?']),
    A(['Mostly. It still counts.', 'Mostly. I will take it.']),
  ] },
  { id: 'bis.pickoffThrow', when: 'steal', a: 'pxp', lines: [
    A(['Were you a catcher who threw behind runners, $other?', 'Did you ever try to pick a runner off yourself, $other?']),
    B(['Once. It went into right field, the runner scored from first, and I spent the next week on the bench. Great view from there.']),
  ] },
  { id: 'bis.mask', when: 'visit', a: 'color', lines: [
    A(['You know the best part of a mound visit, $other? You get to take the mask off and breathe.', 'Half the time I went to the mound, I just wanted the fresh air.']),
    B(['And what did you tell them out there?', 'What did you say to the pitcher?']),
    A(['Throw strikes and do not shake me off. Nobody ever listened to the second part.']),
  ] },
  { id: 'bis.keys', when: 'visit', a: 'pxp', lines: [
    A(['Any mound visit you remember, $other?', 'What was the strangest thing a pitcher ever said to you on a mound visit, $other?']),
    B(['Bases loaded, nobody out, and the pitcher asks me if I have seen his car keys.']),
    A(['Did he get out of it?', 'And then?']),
    B(['Double play on the next pitch. The keys were in his glove.']),
  ] },
  { id: 'bis.hotdogs', when: 'visit', a: 'color', lines: [
    A(['I went out to the mound once and the pitcher told me he could smell the hot dogs from the rubber.', 'One pitcher told me on a visit that he could smell the hot dogs from the mound, $other.']),
    B(['What did you tell him?', 'And your advice?']),
    A(['Throw a fastball, then go find out. He struck the guy out. Some people just need a goal.']),
  ] },
  { id: 'bis.umpChat', when: 'lull', a: 'color', lines: [
    A(['A catcher talks to the plate umpire all game, $other. Weather, food, travel. Never the strike zone.', 'I used to talk to the plate umpire every inning. Weather, food, travel. Never about the strike zone.']),
    B(['Never the strike zone?', 'Not once?']),
    A(['Not out loud. You complain about the zone, you do not get the next close one.']),
  ] },
  { id: 'bis.framing', when: 'lull', a: 'color', lines: [
    A(['People ask about pitch framing. My secret was to catch the ball and then not move. Ever. Like a statue.']),
    B(['A statue that hit two nineteen.']),
    A(['A statue with nine home runs, $other.']),
  ] },
  { id: 'bis.quietGlove', when: 'lull', a: 'color', lines: [
    A(['Framing a pitch is mostly about a quiet glove. My glove was very quiet, $other. My bat was even quieter.']),
    B(['That is a nice way to put it.', 'Quieter. That is generous.']),
    A(['I have a nice way of putting a lot of things.']),
  ] },
  { id: 'bis.bullpen', when: 'change', a: 'color', lines: [
    A(['Backup catchers live in the bullpen, $other. I knew every crack in that bench out there.', 'I spent a lot of years in bullpens. Warming up relievers, eating sunflower seeds, waiting for the phone.']),
    B(['Did the phone ever ring for you?', 'And when the phone rang?']),
    A(['Once, for me. They wanted to know if I had any more sunflower seeds.']),
  ] },
  { id: 'bis.wrongNumber', when: 'change', a: 'pxp', lines: [
    A(['The bullpen phone, $other. What is the strangest call you ever heard on it?', 'What was it like out there when the bullpen phone rang?']),
    B(['Everybody stands up at once. One time it was a wrong number, and three relievers had already started stretching.']),
    A(['A wrong number.', 'Three relievers.'], true),
    B(['Somebody wanted a pizza. We almost sent the left-hander.'], true),
  ] },
  { id: 'bis.firstHomer', when: 'homer', a: 'pxp', lines: [
    A(['Tell the folks about home run number one, $other.', 'Your first big-league homer, $other. Where did it land?']),
    B(['First row. A kid caught it, and the family made the kid give it back. I still have it. That kid is probably forty now.']),
    A(['And if that kid is listening?', 'And the kid?'], true),
    B(['Thank you. I will sign anything you like.'], true),
  ] },
  { id: 'bis.passRunner', when: 'homer', a: 'color', lines: [
    A(['My second home run cleared the wall by about a foot, and I ran so fast I almost passed the runner in front of me.', 'Home run number two, I came around second so fast I almost passed my own teammate.']),
    B(['Almost.', 'That would have been an out.']),
    A(['And only eight career home runs. I slowed down just in time, $other.']),
  ] },
  { id: 'bis.homerTrot', when: 'homer', a: 'color', lines: [
    A(['I never learned how to trot, $other. Nine home runs, and I ran every one like the ball was coming back.', 'The home run trot takes practice. I never got enough reps.']),
    B(['Nine reps in eleven years.']),
    A(['Spread out very evenly.', 'Quality over quantity.']),
  ] },
  { id: 'bis.grandSlam', when: 'homer', a: 'pxp', lines: [
    A(['Number six, $other. The grand slam.', 'I know you want to tell them about number six, $other.']),
    B(['Bases loaded, two strikes, and a breeze you could fly a kite in. I just put the bat out there and the wind did the rest.']),
    A(['The wind was blowing out.', 'The wind again.']),
    B(['A gentleman never argues with the wind, $other.'], true),
  ] },
  { id: 'bis.dpRelief', when: 'dp', a: 'color', lines: [
    A(['When I was catching, a double-play ball was the best sound in the world. Two outs, and nobody throws me another pitch.', 'Every catcher loves a double play. It means you get to go sit down sooner.']),
    B(['Spoken like a man with sore knees.', 'You and your knees.']),
  ] },
  { id: 'bis.lefty', when: 'lull', a: 'pxp', lines: [
    A(['You have mentioned that lefty a few times, $other. Home run number four.', 'Tell me again about the lefty nobody could hit, $other.']),
    B(['He struck me out eleven times in a row. The twelfth time, I closed my eyes and swung. Home run.']),
    A(['Eyes closed.', 'With your eyes closed.']),
    B(['It is a strategy, $other. Do not tell the hitting coach.'], true),
  ] },
  { id: 'bis.lefty2', when: 'lull', a: 'color', lines: [
    A(['That lefty I took deep, number four. I will tell you a secret, $other: I am fairly sure that pitch was a ball.', 'Home run number four, off the best lefty I ever faced. I think it was a ball, $other.']),
    B(['A ball.', 'You swung at a ball.']),
    A(['A ball that went four hundred feet. The umpire never said a word.']),
  ] },
  { id: 'bis.fourClubs', when: 'lull', a: 'pxp', lines: [
    A(['Four clubs in eleven years, $other. Which uniform was your favourite?', 'You wore four different uniforms. Which one fit?']),
    B(['The third one. Elastic waist on the pants, and the cap was a size too big, so I always felt young.']),
  ] },
  { id: 'bis.shape', when: 'lull', a: 'color', lines: [
    A(['None of my uniforms ever fit, $other. Catchers are a different shape.', 'Uniforms are not made for catchers. We are a different shape.']),
    B(['What shape is that?', 'A different shape?']),
    A(['Sturdy. The equipment manager stopped asking after my second year.']),
  ] },
  { id: 'bis.trade', when: 'lull', a: 'color', lines: [
    A(['I was traded once for a player to be named later. It turned out to be a bag of batting practice baseballs.']),
    B(['A bag of baseballs.']),
    A(['Good baseballs, though, $other. Barely used.']),
  ] },
  { id: 'bis.cash', when: 'lull', a: 'color', lines: [
    A(['One club traded me for cash. Not a lot of cash, $other. I asked.']),
    B(['How much?', 'How much cash?']),
    A(['Enough for a nice dinner. Not for two.']),
  ] },
  { id: 'bis.pancakes', when: 'early', a: 'pxp', lines: [
    A(['What did you eat before games when you were playing, $other?', 'Did you have a pregame meal, $other?']),
    B(['Pancakes. Every day for eleven years. Day games, night games, doubleheaders. Pancakes.']),
    A(['That explains a lot.', 'That explains the biscuits, too.']),
    B(['It explains everything, $other.'], true),
  ] },
  { id: 'bis.rainDelay', when: 'lull', a: 'color', lines: [
    A(['My favourite thing in baseball was a rain delay, $other. Nobody can strike you out during a rain delay.']),
    B(['You would have loved a dome.']),
    A(['Domes have no rain delays, $other. I would have hated a dome.']),
  ] },
  { id: 'bis.cards', when: 'lull', a: 'pxp', lines: [
    A(['What did you do in the clubhouse during a rain delay, $other?', 'You played through a lot of rain delays, $other. How did you pass the time?']),
    B(['Cards. Every rain delay, the same game, the same four guys.']),
    A(['Were you any good?', 'Did you win?']),
    B(['I hit about two nineteen at cards too.']),
  ] },
  { id: 'bis.bat', when: 'lull', a: 'color', lines: [
    A(['I had one bat that lasted three seasons. That is not a good sign, $other.', 'I used the same bat for three whole seasons once. Never broke it.']),
    B(['Never hit the ball hard enough to break it?', 'Not a good sign at all.']),
    A(['The bat was fine. The hitter was the problem.']),
  ] },
  { id: 'bis.easyNight', when: 'strikeouts', a: 'color', lines: [
    A(["When a pitcher has it like this, the catcher's job is easy. Put down a finger, hold the glove still, stay out of the way.", 'Catching a pitcher on a night like this, all you do is stay out of the way.']),
    B(['You must have been great at staying out of the way.']),
    A(['Best in the league, $other.']),
  ] },
  { id: 'bis.blowoutCatcher', when: 'blowout', a: 'color', lines: [
    A(['A game like this is when the backup catcher gets in, $other. Every blowout was my big night.', 'This is the kind of score that got me into ballgames. I loved a lopsided score.']),
    B(['A blowout specialist.', 'You were a specialist.']),
    A(['Somebody has to catch the ninth inning of a nine to one game. Proudly.']),
  ] },
  { id: 'bis.sixteen', when: 'extra', a: 'color', lines: [
    A(['The longest game I ever caught went sixteen, $other. I lost four pounds and found two of them again at the buffet.']),
    B(['Did you get a hit?']),
    A(['One, in the fourteenth. I was too tired to run, so it was a single.']),
  ] },
  { id: 'bis.eighteen', when: 'extra', a: 'pxp', lines: [
    A(['What is the longest game you ever played in, $other?', 'You must have caught a few of these extra-inning games, $other.']),
    B(['Eighteen innings in Double-A. It ended on a walk-off walk, with me on deck. I have never been happier not to bat.']),
  ] },
  // ---- Lyle and his scorebook, the ballparks, the job --------------------------------------------------------------------------------
  { id: 'lyle.pencil', when: 'lull', a: 'color', lines: [
    A(['You still keep score in pencil, $other. Why not a pen?', 'Why do you keep score in pencil, $other?']),
    B(['Because the official scorer changes a ruling now and then, and so do I. Pencil forgives.']),
    A(['Pencil forgives. I like that.'], true),
  ] },
  { id: 'lyle.forest', when: 'lull', a: 'color', lines: [
    A(['How many pencils do you go through in a season, $other?']),
    B(['About forty. Twenty-six seasons, that is a small forest. I apologize to the trees.']),
    A(['A forest of scorebooks.', 'The trees forgive you.'], true),
  ] },
  { id: 'lyle.shelf', when: 'lull', a: 'pxp', lines: [
    A(['I keep every scorebook I have ever filled on a shelf at home. My family calls it the wall of numbers.', 'Twenty-six seasons of scorebooks at home. Now and then I open one at random and remember a Tuesday in May.']),
    B(['Any of my games in there, $other?', 'Are my games in there?']),
    A(['A few. I drew a little star next to every one of your home runs.']),
    B(['Nine stars. I will take it.'], true),
  ] },
  { id: 'lyle.margin', when: 'lull', a: 'color', lines: [
    A(['What do you write in the margins of that scorebook, $other?', 'I see you writing in the margin again, $other. What goes in there?']),
    B(['Notes. Who looked tired, who was chewing gum, what I had for dinner. The dinner notes are the most accurate.']),
  ] },
  { id: 'lyle.firstGame', when: 'lull', a: 'color', lines: [
    A(['Do you remember the first game you ever called, $other?', 'What was your first broadcast like, $other?']),
    B(['Every pitch. I was so nervous I gave the count before the pitch was thrown. Twice.']),
    A(['Twice.', 'We all have one of those.'], true),
  ] },
  { id: 'lyle.silence', when: 'lull', a: 'pxp', lines: [
    A(['My worst call ever, $other. My first season, I called a fly ball a home run, and the left fielder caught it on the warning track.', 'First season in the booth, I called a home run that the left fielder caught. I still hear the silence.']),
    B(['What did you say next?', 'How did you get out of that one?']),
    A(['I said, and he makes the catch. Very quietly.']),
  ] },
  { id: 'lyle.oldPark', when: 'lull', a: 'pxp', lines: [
    A(['When I started, one park in this league still had a scoreboard you changed by hand. A fellow inside with a ladder and a box of numbers.']),
    B(['What happened in a big inning?']),
    A(['You could hear the ladder. The crowd would cheer for the scoreboard operator too.']),
  ] },
  { id: 'lyle.tenCard', when: 'lull', a: 'color', lines: [
    A(["That old hand-turned scoreboard you talk about, $other. What happened when a team scored ten?", 'Did that old hand scoreboard ever run out of numbers, $other?']),
    B(['There was exactly one card with a ten on it. It was used twice in thirty years, and the second time it went up upside down.']),
  ] },
  { id: 'lyle.pigeon', when: 'lull', a: 'pxp', lines: [
    A(['Every press box has a personality, $other. Some are warm, some are cold, and one of them has a pigeon that has been there longer than I have.']),
    B(['Is the pigeon on the payroll?']),
    A(['Unofficially. Better attendance than some players.']),
  ] },
  { id: 'lyle.coffee', when: 'lull', a: 'color', lines: [
    A(['You have been in every press box in this league, $other. Where is the best coffee?', 'Which press box has the best coffee, $other?']),
    B(['I could tell you every press-box coffee in this league blindfolded, and I never will. It is the only power I have.']),
  ] },
  { id: 'lyle.lineupCard', when: 'early', a: 'color', lines: [
    A(['What is the first thing you do when you get to the ballpark, $other?']),
    B(['I sharpen three pencils and write the lineups into the book. Then I sharpen them again, out of nerves.']),
  ] },
  { id: 'lyle.early', when: 'early', a: 'color', lines: [
    A(['How early do you get to the park, $other?', 'You are always here before me, $other. How early do you come in?']),
    B(['About four hours. Two to prepare, and two to find the good parking spot.']),
  ] },
  { id: 'lyle.view', when: 'lull', a: 'color', lines: [
    A(['Which booth in this league has the best view, $other?', 'You have called a game from every booth in the league. Favourite view?']),
    B(['The one with the sun in your eyes for three innings. Builds character, and it gives me a tan.']),
  ] },
  { id: 'lyle.bus', when: 'night', a: 'color', lines: [
    A(['What is the latest you have ever gotten home from a ballgame, $other?', 'You have done a lot of night games, $other. Latest one ever?']),
    B(['A quarter past three in the morning. The game went fifteen, and the bus went the wrong way.']),
  ] },
  { id: 'lyle.dayGame', when: 'day', a: 'pxp', lines: [
    A(['Day baseball, $other. Half this crowd told the boss it was a dentist appointment.', 'There is nothing like a day game. Kids out of school, people taking a very long lunch.']),
    B(['I played a lot of day games. You see the ball better and you sweat twice as much.']),
    A(['And somebody\'s boss is watching right now, too.'], true),
  ] },
  { id: 'lyle.sunscreen', when: 'day', a: 'color', lines: [
    A(['Are you wearing sunscreen up here, $other?', 'You have a little color on you today, $other.']),
    B(['Twenty-six seasons of day games, and only the left side of my face has a tan. The booth faces the same way every time.']),
  ] },
  { id: 'lyle.official', when: 'error', a: 'color', lines: [
    A(['Do you ever disagree with the official scorer, $other?', 'You ever argue with the official scorer on an error?']),
    B(['Every night, in pencil, quietly. I keep my own book, and in my book I am always right.']),
  ] },
  { id: 'lyle.rhubarb', when: 'lull', a: 'pxp', lines: [
    A(['The best argument I ever saw at home plate lasted eleven minutes, $other. The manager kicked dirt on the umpire\'s shoes.']),
    B(['And then?', 'What happened?']),
    A(['Then the manager apologized, cleaned the shoes with a cap, and got thrown out anyway.']),
  ] },
  { id: 'lyle.ruleBook', when: 'lull', a: 'pxp', lines: [
    A(['I once saw a manager argue a call by reading the rule book out loud at home plate, $other.']),
    B(['Out loud?', 'The whole rule?']),
    A(['The whole page. The umpire listened, nodded, and threw the manager out.']),
  ] },
  { id: 'lyle.triple', when: 'lull', a: 'pxp', lines: [
    A(['Most exciting play in baseball, $other? I say the triple.', 'If you could see one play every night, what would it be, $other?']),
    B(['The triple, sure. Unless you are the catcher. Then it is the strikeout on three pitches. Nobody runs, and I get to sit down.']),
    A(['Spoken like a catcher.', 'Typical catcher.']),
  ] },
  { id: 'lyle.diagram', when: 'lull', a: 'color', lines: [
    A(['What is the strangest play you ever had to score, $other?', 'You have scored a lot of games, $other. Ever have a play with no box for it?']),
    B(['A pickoff throw that hit the runner, the coach and the bag, in that order. I drew a little diagram in the margin.']),
  ] },
  { id: 'lyle.fouls', when: 'lull', a: 'pxp', lines: [
    A(['I keep a count of foul balls caught by fans in the section below the booth, $other. Two hundred and eleven in twenty-six years.']),
    B(['And how many have you caught?']),
    A(['None. I keep the scorebook in one hand and a pencil in the other.']),
  ] },
  { id: 'lyle.anthem', when: 'early', a: 'color', lines: [
    A(['How many first pitches have you seen, $other?', 'You ever count how many games you have called, $other?']),
    B(['Something over four thousand. And I still get a little nervous before every first pitch.']),
  ] },
  // ---- the two of them ------------------------------------------------------------------------------------------------------------------
  { id: 'duo.um', when: 'lull', a: 'pxp', lines: [
    A(['Do you remember the first time we worked together, $other?']),
    B(['You told me to stop saying um. I said, um, sure. That was the whole first inning.']),
    A(['You have gotten much better.']),
  ] },
  { id: 'duo.hungry', when: 'lull', a: 'color', lines: [
    A(['How long have we been doing this together, $other?']),
    B(['Long enough that I can tell you are hungry before you can.']),
    A(['When?', 'And when is that?']),
    B(['Usually around the fourth inning. Sometimes the second.']),
  ] },
  { id: 'duo.headset', when: 'lull', a: 'color', lines: [
    A(['$other has had the same headset for twelve years, folks. It has outlasted three of my diets.']),
    B(['It fits my head. Why would I change it?']),
    A(['Says the man who has used the same kind of pencil since before I was a rookie.']),
  ] },
  { id: 'duo.bet', when: 'scoreless', a: 'color', lines: [
    A(['$other and I have a little wager on the first run of the game. Loser buys the press-box sandwiches.']),
    B(['And I am feeling good about it.', 'I took the late innings. Patience.']),
    A(['You always feel good about it.', 'You always say that.'], true),
  ] },
  { id: 'duo.bullpenNight', when: 'blowout', a: 'pxp', lines: [
    A(['Not the closest game we have ever called, $other.', 'This one got away a while ago.']),
    B(['No, but somebody in the bullpen is about to have the best night of his life. There is always something to watch.']),
  ] },
  { id: 'duo.freeBaseball', when: 'extra', a: 'pxp', lines: [
    A(['Free baseball, folks. Nobody leave.', 'Extra innings. My favourite words in the language.']),
    B(['My stomach has some thoughts about extra innings, $other.']),
    A(['Somebody find the man a sandwich.'], true),
  ] },
  { id: 'duo.dinner', when: 'extra', a: 'color', lines: [
    A(['Every extra inning, the dinner reservation moves back another half hour, $other.']),
    B(['You made a reservation?', 'Who is waiting on you?']),
    A(['A plate of ribs, and they do not wait for anybody.']),
  ] },
  // ---- the game, the park, the crowd ------------------------------------------------------------------------------------------------------
  { id: 'game.foulBall', when: 'lull', a: 'pxp', lines: [
    A(['Did you ever get a foul ball in the stands as a kid, $other?', 'You ever catch a foul ball as a fan, $other?']),
    B(['Never. I caught about a hundred thousand baseballs in my life, and not one of them was a souvenir.']),
  ] },
  { id: 'game.ballKid', when: 'lull', a: 'color', lines: [
    A(['Watch the ball kid down the line, $other. Better hands than some of the infielders I played with.', 'That ball kid on the line has not missed one all night.']),
    B(['Somebody get that kid a contract.', 'No errors so far.']),
  ] },
  { id: 'game.organ', when: 'lull', a: 'pxp', lines: [
    A(['Listen to that organ. Some things in baseball should never change.', 'The organist here has been playing the same few songs for years, and I would not change a note.']),
    B(['I had a walk-up song once. They played it so rarely, the organist forgot how it went.']),
  ] },
  { id: 'game.hotDog', when: 'night', a: 'color', lines: [
    A(['A hot dog tastes better at night, $other. That is just science.', 'Something about the lights makes the ballpark food taste better.']),
    B(['Have you tested that?', 'Is that science?']),
    A(['Eleven years of research. Extensively. For the fans.']),
  ] },
  { id: 'game.lights', when: 'night', a: 'pxp', lines: [
    A(['Baseball under the lights, $other. The grass never looks greener than it does right now.']),
    B(['And the ball looks like a little moon coming in. A catcher sees it all night.']),
  ] },
  { id: 'game.unwritten', when: 'blowout', a: 'pxp', lines: [
    A(['With a lead like this, the unwritten rules come out, $other. No stealing, no showing anybody up.', 'Big lead, late. This is where the unwritten rules come in.']),
    B(['I could never remember the unwritten rules. Nobody ever wrote them down.']),
  ] },
  { id: 'game.zeroes', when: 'scoreless', a: 'pxp', lines: [
    A(['Nothing but zeroes on the board so far. I like a game like this, $other. The scorebook stays neat.', 'A pitchers\' duel. Every inning in my scorebook is tidy little dots.']),
    B(['Neat is not the word the hitters would use.']),
  ] },
  { id: 'game.walkIn', when: 'change', a: 'pxp', lines: [
    A(['The walk in from the bullpen, $other. Longest walk in baseball.', 'Every reliever I have known says the walk in from the bullpen is the loneliest part of the job.']),
    B(['And the catcher is waiting at the mound with a smile. Nothing to worry about, we say. Everybody is worried.']),
  ] },
  { id: 'game.glove', when: 'change', a: 'color', lines: [
    A(['When a new pitcher came in, I always said the same thing, $other: throw it where I put the glove.']),
    B(['Did they?']),
    A(['Some of them. The ones who did are still pitching.']),
  ] },
  { id: 'game.chess', when: 'steal', a: 'pxp', lines: [
    A(['The running game is a chess match, $other. The pitcher, the catcher, the runner, and the first-base coach whispering the whole time.', 'A stolen base starts long before the runner goes. He is reading the pitcher from the first pitch.']),
    B(['And the catcher is always the last one to know. Trust me.']),
  ] },
  { id: 'game.ks', when: 'strikeouts', a: 'pxp', lines: [
    A(['I have a whole row of Ks in the scorebook tonight, $other. I am running out of room.', 'When a pitcher piles up strikeouts like this, my Ks get a little bigger.']),
    B(['The backward K is for looking, right?']),
    A(['The backward one for looking, the forward one for swinging, and a little star for the really good ones.']),
  ] },
  { id: 'game.souvenir', when: 'homer', a: 'color', lines: [
    A(['Somebody out there is going home with a souvenir, $other.', 'Some fan just caught a home run ball. That is the best day of somebody\'s summer.']),
    B(['Keep it, or throw it back?', 'Would you throw it back?']),
    A(['Keep it. Put it on the mantle and tell the story wrong for forty years.']),
  ] },
  { id: 'game.errorHide', when: 'error', a: 'color', lines: [
    A(['After an error, a fielder wants the next ball hit right at him. Or he wants to hide. Depends on the player.']),
    B(['Which one were you?']),
    A(['A catcher cannot hide, $other. I tried. The mask helps a little.']),
  ] },
  { id: 'game.pivot', when: 'dp', a: 'pxp', lines: [
    A(['The pivot at second on a double play, $other. Takes a lot of nerve with a runner coming in.', 'Turning two is a ballet with somebody trying to knock you over.']),
    B(['I played one inning at second base in a spring game. It is the only inning of my life I wished I had my catcher\'s gear on.']),
  ] },
  { id: 'game.firstLook', when: 'early', a: 'pxp', lines: [
    A(['First time through the order, $other. Everybody is still taking notes.', 'Early innings. Hitters still figuring out what the pitcher has tonight.']),
    B(['So is the catcher. What is working, what is not, and what you should never call again.']),
  ] },
  { id: 'game.routine', when: 'lull', a: 'color', lines: [
    A(['Every hitter has a routine, $other. Gloves, helmet, tap the plate, deep breath. Mine ended with a strikeout.']),
    B(['Strikeout was part of the routine?']),
    A(['It was not the plan. It was just very consistent.']),
  ] },
  { id: 'game.noClock', when: 'lull', a: 'pxp', lines: [
    A(['You know what I love about this game, $other? No clock on the innings. It ends when it ends.']),
    B(['There is a pitch clock now.']),
    A(['For the pitches. The innings still take as long as they like.']),
  ] },
  { id: 'game.newThing', when: 'lull', a: 'pxp', lines: [
    A(['Twenty-six seasons, $other, and every night I might see something I have never seen before.']),
    B(['Like what?', 'Such as?']),
    A(['I will let you know the moment it happens.']),
  ] },
  { id: 'game.mascotKnees', when: 'lull', a: 'color', lines: [
    A(['$mascot has been up on the dugout roof for an inning now. Somebody check the knees in that costume.', 'Is $mascot allowed a mound visit? Looks like it could use one.']),
    B(['The mascot has worked harder tonight than both bullpens.']),
  ] },
  { id: 'game.coach', when: 'lull', a: 'color', lines: [
    A(['Keep an eye on the third-base coach, $other. Touching the cap, the belt, the nose. Half of those signs mean nothing.']),
    B(['Which half?']),
    A(['The half I missed. I looked at the runner ahead of me and did whatever he did.']),
  ] },
  { id: 'game.dirt', when: 'lull', a: 'pxp', lines: [
    A(['The grounds crew here is one of the best in the league, $other. Look at the lines on that infield.']),
    B(['A catcher notices the dirt around home plate. Too soft and the ball dies, too hard and it skips right past you.', 'I always shook hands with the grounds crew. They decide how the ball bounces in front of the plate.']),
  ] },
  // ---- more of them (added after the recording script's sessions were laid out: new stories go at the end) ---------------------------
  { id: 'bis.backupDays', when: 'lull', a: 'pxp', lines: [
    A(['Eleven years as a backup catcher, $other. What did you do on the days you did not play?', 'What does a backup catcher do on his days off, $other?']),
    B(['Caught every pitcher in the bullpen, charted every pitch, and kept the sunflower seeds organized. Somebody had to.']),
    A(['Organized how?']),
    B(['By flavor. Nobody ever thanked me.']),
  ] },
  { id: 'bis.spring', when: 'lull', a: 'pxp', lines: [
    A(['Spring training must have been something for a backup catcher, $other.', 'Did you like spring training, $other?']),
    B(['Six weeks of catching every arm in camp. By the end of March my left hand had its own heartbeat.']),
    A(['And the hitting?']),
    B(['I hit very well in the spring. It is the only time of year the pitchers are trying to throw strikes.']),
  ] },
  { id: 'bis.mittBreakIn', when: 'lull', a: 'color', lines: [
    A(['Breaking in a new catcher\'s mitt takes about a month, $other. I used to sleep with a ball tied up in mine.']),
    B(['You slept with the mitt?', 'In the bed?']),
    A(['Every night. My wife asked which one of us was getting traded first.']),
  ] },
  { id: 'bis.foulTip', when: 'catcher', a: 'pxp', lines: [
    A(['A catcher takes a lot of foul tips off the mask, $other. Do you remember them?', 'How many foul tips did you take off the mask, $other?']),
    B(['Every one of them. They live in a little room in the back of my head, and they all still ring a bell.']),
  ] },
  { id: 'bis.breathe', when: 'visit', a: 'color', lines: [
    A(['Here is a secret about mound visits, $other. Half the time the catcher just wants the pitcher to breathe.']),
    B(['And the other half?']),
    A(['The other half he wants to breathe himself.']),
  ] },
  { id: 'bis.oneSteal', when: 'steal', a: 'color', lines: [
    A(['I stole one base in eleven years, $other.', 'One stolen base in my whole career, $other.']),
    B(['Just the one?', 'How did that happen?']),
    A(['The pitcher forgot about me and the catcher had the flu. I still had to slide, and I was out of breath for two innings.']),
  ] },
  { id: 'bis.greedy', when: 'strikeouts', a: 'pxp', lines: [
    A(['On a strikeout night like this one, $other, what is the catcher thinking back there?', 'Everything is working tonight. What does a catcher do with a night like this, $other?']),
    B(['Trying not to get greedy. When a pitch is working you want to call it forever, and that is exactly when a hitter starts waiting for it.']),
  ] },
  { id: 'bis.plate', when: 'lull', a: 'color', lines: [
    A(['The play at the plate was my favorite thing in baseball, $other.']),
    B(['Even with a runner coming right at you?']),
    A(['Especially then. You get the ball, you hold on, and for one second the whole park is watching the catcher.']),
  ] },
  { id: 'bis.pinchHit', when: 'lull', a: 'pxp', lines: [
    A(['Did you ever pinch-hit, $other?', 'Did they ever send you up to pinch-hit, $other?']),
    B(['Eleven times. The manager only sent me up when he had run out of everybody else, and I could hear him counting.']),
    A(['How did it go?']),
    B(['Two hits, one walk, and eight very long walks back to the dugout.']),
  ] },
  { id: 'bis.noChangeup', when: 'lull', a: 'color', lines: [
    A(['My first week in the big leagues, $other, I called a changeup for a pitcher who did not have one.']),
    B(['What did he throw?']),
    A(['His fastball, a little slower, out of pity. The hitter popped it up, so we both pretended it was the plan.']),
  ] },
  { id: 'bis.lights', when: 'night', a: 'color', lines: [
    A(['Night games behind the plate, $other, you lose the ball in the lights maybe once a month.']),
    B(['What do you do then?', 'And then what?']),
    A(['Hold the mitt still, close your eyes a little, and hope the pitcher is having a good night.']),
  ] },
  { id: 'bis.firstInning', when: 'early', a: 'color', lines: [
    A(['First inning, $other, I always wanted to throw a runner out early. It sets the tone.']),
    B(['Did it work?']),
    A(['About one time in five. The other four set a different tone.']),
  ] },
  { id: 'lyle.radio', when: 'lull', a: 'pxp', lines: [
    A(['I started out on radio, $other. On radio you have to describe everything. The grass, the clouds, the color of the socks.']),
    B(['And on television?']),
    A(['On television I can say, look at that, and let the picture do the work. Best part of the job.']),
  ] },
  { id: 'lyle.notes', when: 'lull', a: 'color', lines: [
    A(['They hand you a stack of notes this thick before every game, $other. How much of it do you use?', 'How much of that stack of game notes do you actually use, $other?']),
    B(['About one line. The trick is knowing which line, and the trick is usually wrong.']),
  ] },
  { id: 'lyle.voice', when: 'lull', a: 'color', lines: [
    A(['How do you keep your voice for a whole season, $other?']),
    B(['Hot tea, no shouting at home, and I let you do the yelling on the home runs.']),
    A(['I do yell a little.', 'Fair enough.']),
  ] },
  { id: 'lyle.firstPartner', when: 'lull', a: 'color', lines: [
    A(['Who was your first partner in the booth, $other?']),
    B(['A retired pitcher who talked about his arm for nine innings a night, for three seasons.']),
    A(['And now you have me.']),
    B(['Now I have a catcher who talks about his knees. It is a step up.']),
  ] },
  { id: 'lyle.scoreAtHome', when: 'early', a: 'pxp', lines: [
    A(['Anybody keeping score at home tonight, I salute you. Sharpen those pencils.', 'If you are keeping score at home tonight, good for you. It is the best way to watch a ballgame.']),
    B(['Are there a lot of them?', 'Is that a lot of people?']),
    A(['More than you would think. And every one of them knows how to mark a fielder\'s choice, which is more than I can say for some press boxes.']),
  ] },
  { id: 'lyle.miles', when: 'lull', a: 'color', lines: [
    A(['How many miles do you think you have traveled for this job, $other?']),
    B(['Twenty-six seasons, half of them on the road. Enough to get to the moon, and the moon has better coffee than some of these airports.']),
  ] },
  { id: 'lyle.shadows', when: 'day', a: 'pxp', lines: [
    A(['Shadows creeping across the infield now, $other. The hardest time of day to see the ball.']),
    B(['Half the plate in the sun and half in the shade. As a catcher you just hope the pitcher is not trying anything fancy.']),
  ] },
  { id: 'lyle.moth', when: 'night', a: 'pxp', lines: [
    A(['Something about a night game, $other. The lights come on and the whole place gets a little louder.']),
    B(['And the moths come out. I swallowed one once, in the middle of a pitch.']),
    A(['In the middle of a pitch?']),
    B(['I caught the pitch. The moth was not so lucky.']),
  ] },
  { id: 'lyle.cleanPage', when: 'scoreless', a: 'pxp', lines: [
    A(['A scoreless game is the cleanest page in my scorebook, $other. Nothing but little lines and zeroes.']),
    B(['You sound happy about that.']),
    A(['I am. I have not had to sharpen a pencil since the second inning.']),
  ] },
  { id: 'duo.prediction', when: 'lull', a: 'pxp', lines: [
    A(['Give me a prediction for the next inning, $other.', 'All right, $other, what happens in the next inning?']),
    B(['A ground ball, a walk, and somebody in the front row drops a hot dog.']),
    A(['That is not a prediction. That is every inning.']),
    B(['And I am usually right.']),
  ] },
  { id: 'duo.watchCatcher', when: 'lull', a: 'color', lines: [
    A(['You know what my notes say for this inning, $other? Watch the catcher.']),
    B(['Your notes always say watch the catcher.']),
    A(['And I have never once been wrong.']),
  ] },
  { id: 'game.wave', when: 'lull', a: 'pxp', lines: [
    A(['No wave yet tonight, $other.']),
    B(['Give it an inning. Somebody in the upper deck is always ready to start one.']),
    A(['And somebody in the good seats is always ready to ignore it.']),
  ] },
  { id: 'game.warmups', when: 'change', a: 'pxp', lines: [
    A(['Eight warm-up pitches for the new man, $other. What is he thinking about out there?']),
    B(['The first hitter, the catcher\'s signs, and whether he tied his shoes. In that order, if he is smart.']),
  ] },
  { id: 'game.visitClock', when: 'visit', a: 'pxp', lines: [
    A(['The umpire will give them about thirty seconds out there, $other.']),
    B(['And then he walks out nice and slow, so everybody sees him coming. It is a very polite way of saying, that is enough.']),
  ] },
  { id: 'game.stealSign', when: 'steal', a: 'pxp', lines: [
    A(['The steal sign is the simplest sign in baseball, $other, and somehow it is the one everybody misses.']),
    B(['Because the runner is the only one looking for it. Everybody else is looking at the runner.']),
  ] },
  { id: 'game.bigLead', when: 'blowout', a: 'color', lines: [
    A(['In a game like this one, $other, the catcher starts calling whatever the pitcher wants to throw.']),
    B(['No more chess?']),
    A(['No more chess. Just strikes, and everybody gets home a little early.']),
  ] },
];

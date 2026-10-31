# Announcer variety

How often the booth repeats itself, measured over whole simulated games, and what was done about it. The owner's note (2026-10-29): *"I love the
announcers as they are but I've begun to memorize all their lines."*

**The harness**: `npx tsx scripts/booth-variety.ts --chains 3 --games 10` plays 3 chains of 10 nine-inning games (Broadcast tempo, chatter Normal,
the time of day cycling night / day / dusk; seeds 101 + 1000 x chain + 17 x game) through the real booth on a fake clock, like
`scripts/booth-transcript.ts`, and records every line said (a folded-in count is its own line). The games of a chain run one after another and
share the booth's memory between games when it has one, as a person watching game after game does. About 25 minutes on 3 cores.

- **Exact repeat within the game**: the same words said earlier in the same game.
- **Shape**: the line with the names (players, clubs, the park, the officials, the managers, the mascot), digits and number words masked, so
  "Brooks sets them down in order." and "Silva sets them down in order." are the same line to the listener.
- **Heard in an earlier game**: the shape was said in an earlier game of the chain. The last column takes only games 6-10.
- Categories: **call** (play-by-play calls of pitches and plays, from `lexicon.ts`, and the folded-in count), **reaction** (the analyst's
  "Nasty." over the end of a call, catchphrases), **topic** (the between-pitch conversation: stories, callbacks, running jokes, fillers),
  **segment** (the opening, the breaks between half innings, the closing).

## Before (main at 17016c2)

30 games in 3 chains of 10, NaN min a game on average, 893 lines a game (495 not calls)

| lines | per game | exact repeat within the game | shape repeat within the game | shape heard in an earlier game of the chain | ... in the second half of the chain |
|---|---|---|---|---|---|
| all | 893 | 15.5 % | 39.0 % | 75.2 % | 89.2 % |
| everything but calls | 495 | 16.7 % | 38.8 % | 77.8 % | 92.1 % |
| call | 398 | 14.0 % | 39.4 % | 72.0 % | 85.4 % |
| reaction | 14 | 24.9 % | 24.9 % | 74.1 % | 93.4 % |
| topic | 395 | 18.3 % | 40.2 % | 78.8 % | 93.1 % |
| segment | 86 | 7.7 % | 34.3 % | 74.0 % | 87.3 % |

Conversation topics: the booth looked for one NaN times a game and had nothing 0.0 % of the time.

Not-call lines from game 2 on: 65.9 % were said in the game just before; on average each had been said 8.3 times in the earlier games of the chain; 66.6 % three times or more.

Not-call lines heard before, by game number in the chain (shape): g1 0.0 %, g2 67.4 %, g3 78.4 %, g4 84.3 %, g5 88.2 %, g6 89.6 %, g7 90.7 %, g8 93.7 %, g9 92.9 %, g10 93.8 %

Top repeaters (call): uses across all games, games it was heard in

| uses | games | tag | line (shape) |
|---|---|---|---|
| 190 | 30/30 | batter.up | Here comes #N and he digs in. |
| 183 | 30/30 | batter.up | #N is up. |
| 173 | 30/30 | batter.up | Here comes #N. |
| 167 | 30/30 | batter.up | #N steps in, and he gets set. |
| 162 | 30/30 | ball | Ball #, and #N stays patient. |
| 160 | 30/30 | batter.up | #N steps in. |
| 156 | 30/30 | batter.up | Now it is #N. |
| 142 | 30/30 | ball | #N does not bite. Ball #. |
| 136 | 30/30 | ball | He does not bite. Ball #. |
| 136 | 30/30 | fielded.clean | Fielded by #N. |
| 133 | 30/30 | ball | He holds back, ball #. |
| 124 | 30/30 | ball | He lays off it, ball #. |
| 122 | 30/30 | ball | Misses the zone, ball #. |
| 115 | 30/30 | ball | Takes it for ball #. |
| 115 | 30/30 | ball | Off the plate, ball #. |
| 114 | 30/30 | ball | He takes it, ball #. |
| 105 | 30/30 | fielded.clean | Scooped up by #N. |
| 103 | 30/30 | fielded.clean | #N has it. |
| 73 | 30/30 | batter.up | And #N comes to the plate. |
| 104 | 29/30 | fielded.clean | #N gloves it. |
| 78 | 29/30 | ball | Not that #, ball #. |
| 81 | 28/30 | ball | Ball #, and #N lets it go. |
| 80 | 28/30 | ball | Ball #. |
| 74 | 28/30 | strike.called | Strike #, looking. |
| 62 | 28/30 | strike.called | He takes a strike, # and #. |
| 58 | 28/30 | contact.grounder | He chops # to #. |
| 55 | 28/30 | contact.grounder | He hits a grounder to #. |
| 55 | 28/30 | strike.called | Over the plate, strike #. |
| 46 | 28/30 | strike.foul | Fouled off, strike #. |
| 46 | 28/30 | contact.grounder | Ground ball, up the middle. |

Top repeaters (reaction): uses across all games, games it was heard in

| uses | games | tag | line (shape) |
|---|---|---|---|
| 27 | 21/30 | react | Wow! |
| 29 | 19/30 | react.k | Good pitch. |
| 23 | 18/30 | react.k | Ooh. |
| 29 | 17/30 | react.k | Nasty. |
| 23 | 16/30 | react.hit | Good, solid contact. |
| 23 | 16/30 | react.k | Well pitched. |
| 18 | 15/30 | react.hit | That is a quality at-bat. |
| 17 | 14/30 | react.hit | Nice piece of hitting. |
| 16 | 14/30 | react.out | Good play. |
| 14 | 14/30 | phrase.bis.k | Mm-hmm. Biscuits and gravy. |
| 19 | 13/30 | react.hit | He put a good swing on that. |
| 15 | 13/30 | react.out | Smooth. |
| 15 | 13/30 | react.hit | Good swing. |
| 18 | 12/30 | react.k | He had # answer for that. |
| 17 | 12/30 | react.hit | Great approach. |
| 14 | 12/30 | react.out | Routine. |
| 12 | 12/30 | phrase.bis.k | That is biscuits and gravy right there. |
| 16 | 11/30 | react.k | Great sequence there. |
| 15 | 11/30 | react.out | Clean. |
| 17 | 10/30 | react.out | Nice job by the defense. |
| 14 | 10/30 | react.out | That is how you do it. |
| 14 | 10/30 | react.hit | Beautiful swing. |
| 12 | 8/30 | react.k | That is a tough at-bat. |
| 7 | 6/30 | phrase.bis.hr | Grown-man swing. |
| 5 | 4/30 | phrase.bis.hr | That is a grown-man swing. |
| 1 | 1/30 | react.big | Incredible! |
| 1 | 1/30 | react.err | That is a tough #. |
| 1 | 1/30 | react.err | Ooh, that hurts. |
| 1 | 1/30 | react.big | Are you kidding me? |

Top repeaters (topic): uses across all games, games it was heard in

| uses | games | tag | line (shape) |
|---|---|---|---|
| 167 | 30/30 | batterVsPitcher | #N is # for # against #N tonight. |
| 134 | 30/30 | n.outs | # out. |
| 125 | 30/30 | n.outs | # down, # to go. |
| 117 | 30/30 | sameHand | It is righty on righty in this matchup. |
| 101 | 30/30 | twoOutRsp | # outs, and a runner in scoring position. |
| 101 | 30/30 | twoOutRsp | # out, runner in scoring position. |
| 101 | 30/30 | batterVsPitcher | This is the # look at #N for #N with # hits in # trips. |
| 98 | 30/30 | n.outs | # out, and the pressure is on. |
| 98 | 30/30 | n.outs | # outs here. |
| 92 | 30/30 | n.inning | Plenty of baseball left. |
| 87 | 30/30 | firstPitchBreaking | We will see if #N is ready for the fastball. |
| 87 | 30/30 | n.inning | Still a lot of game ahead. |
| 84 | 30/30 | firstPitchBreaking | And now the next pitch matters. |
| 76 | 30/30 | callback | #N has struck out # so far. |
| 74 | 30/30 | clockLow | #N is going to have to get set. The clock is running. |
| 74 | 30/30 | clockLow | He had better get going, the clock is ticking. |
| 69 | 30/30 | fastballStreak | We will see how long that lasts. |
| 61 | 30/30 | rattled | Trouble on the bases again for #N. |
| 59 | 30/30 | n.inning | It is the top of the # inning. |
| 49 | 30/30 | batterVsPitcher | Knowing what is coming helps. |
| 143 | 29/30 | thirdTime | # look at #N for #N. |
| 123 | 29/30 | sameHand | Righty against righty here. |
| 119 | 29/30 | pitchMix | About # percent fastballs from #N so far. |
| 118 | 29/30 | thirdTime | The # time #N has seen #N tonight. |
| 109 | 29/30 | fastballStreak | That is # fastballs in a row from #N. |
| 105 | 29/30 | firstPitchBreaking | Getting ahead of the count, and showing #N something to think about. |
| 70 | 29/30 | fastballStreak | If it ain't broke. |
| 68 | 29/30 | firstPitchBreaking | It is a way to get ahead without giving up the fastball. |
| 67 | 29/30 | firstPitchBreaking | He is trying to get ahead without giving up the fastball. |
| 64 | 29/30 | n.lead | #N lead by #. |

Top repeaters (segment): uses across all games, games it was heard in

| uses | games | tag | line (shape) |
|---|---|---|---|
| 260 | 30/30 | break.due | Due up for the #N in the bottom of the #: #N. |
| 188 | 30/30 | break.pitcher | #N through # innings: # hits, # strikeouts, # pitches. |
| 67 | 30/30 | break.back | Stay with us. We'll be right back from #N. |
| 66 | 30/30 | break.back | We'll be right back. |
| 60 | 30/30 | break.back | Time for a break. Back in a moment. |
| 60 | 30/30 | break.due | And we're back. Due up for the #N in the top of the #: #N. |
| 57 | 30/30 | break.clock | It's #-# here at #N # degrees. |
| 46 | 30/30 | break.pitcher | He is making it look easy. |
| 30 | 30/30 | close.final | The final here at #N: the #N #, the #N #. |
| 65 | 29/30 | break.due | We're back. Due up for the #N in the top of the #: #N. |
| 64 | 29/30 | break.due | Back here at #N. Due up for the #N in the top of the #: #N. |
| 47 | 29/30 | break.pitcher | Hitters are not getting comfortable against him. |
| 46 | 28/30 | break.pitcher | He has been in command. Nothing has come easy against him. |
| 55 | 27/30 | break.clock | It's #-#-# here at #N # degrees. |
| 56 | 25/30 | break.due | Due up for the #N in the top of the #: #N. |
| 27 | 24/30 | break.promo | Kids run the bases after the game, so stick around. |
| 36 | 22/30 | break.pitcher | #N through # innings: # hit, # strikeouts, # pitches. |
| 32 | 21/30 | break.recap | Middle of the #, #N #, #N #. #N sets them down in order. |
| 21 | 21/30 | close.signoff | For Hollis "Biscuit" Dupree, I'm Lyle Pemberton. Thanks for spending the night with us, and good night from #N. |
| 21 | 21/30 | open.starter.home | On the mound for the #N the #-year-old right-hander. |
| 36 | 20/30 | break.pitcher | That's a good night's work so far, Lyle. |
| 32 | 20/30 | break.recap | Middle of the #, #N #, #N #. # up, # down for #N. |
| 26 | 20/30 | break.recap | Middle of the #, #N #, #N #. #N needed just # hitters. |
| 25 | 20/30 | break.promo | The dot race is coming up on the big board in a couple of innings, and Biscuit has a favourite. |
| 20 | 20/30 | break.joke.biscuitName+ | Somebody asked me again why they call you Biscuit. |
| 23 | 19/30 | break.promo | Somebody proposed on the big board last inning. The crowd is taking credit for the yes. |
| 27 | 18/30 | break.recap | Middle of the #, #N #, #N #. A quick #-#-# top for #N. |
| 21 | 18/30 | break.pitcher | He is grinding through it. |
| 21 | 17/30 | break.recap | Middle of the #, tied at #. A quick #-#-# top for #N. |
| 20 | 17/30 | break.pitcher | He has had his moments, good and bad. |

Thinnest pools (tags by uses per distinct shape, at least 10 uses):

| tag | category | uses | distinct shapes | uses per shape |
|---|---|---|---|---|
| batter.up | call | 1183 | 8 | 147.9 |
| n.outs | topic | 455 | 4 | 113.8 |
| fielded.clean | call | 548 | 6 | 91.3 |
| break.back | segment | 193 | 3 | 64.3 |
| clockLow | topic | 309 | 5 | 61.8 |
| sameHand | topic | 679 | 13 | 52.2 |
| advance | call | 254 | 5 | 50.8 |
| break.due | segment | 513 | 11 | 46.6 |
| contact.grounder | call | 480 | 13 | 36.9 |
| n.inning | topic | 427 | 12 | 35.6 |
| strike.foul | call | 595 | 18 | 33.1 |
| firstPitchBreaking | topic | 1058 | 35 | 30.2 |
| close.final | segment | 30 | 1 | 30.0 |
| break.clock | segment | 119 | 4 | 29.8 |
| wall | call | 110 | 4 | 27.5 |
| react | reaction | 27 | 1 | 27.0 |
| break.pitcher | segment | 548 | 21 | 26.1 |
| n.lead | topic | 245 | 10 | 24.5 |
| fastballStreak | topic | 651 | 29 | 22.4 |
| n.score | topic | 179 | 8 | 22.4 |
| strike.foul.two | call | 285 | 13 | 21.9 |
| ball | call | 2365 | 108 | 21.9 |
| react.k | reaction | 150 | 7 | 21.4 |
| secondGuess | topic | 300 | 14 | 21.4 |
| safe | call | 361 | 18 | 20.1 |
| loaded | topic | 200 | 10 | 20.0 |
| zeroes | topic | 313 | 16 | 19.6 |
| sequence | topic | 973 | 50 | 19.5 |
| strike.swinging | call | 563 | 29 | 19.4 |
| break.promo | segment | 114 | 6 | 19.0 |
| batterVsPitcher | topic | 665 | 35 | 19.0 |
| rattled | topic | 432 | 23 | 18.8 |
| strike.called | call | 1069 | 60 | 17.8 |
| react.hit | reaction | 123 | 7 | 17.6 |
| twoOutRsp | topic | 404 | 23 | 17.6 |
| fold.count | call | 140 | 8 | 17.5 |
| hit.fc | call | 104 | 6 | 17.3 |
| run | call | 240 | 14 | 17.1 |
| pitch.change | call | 120 | 7 | 17.1 |
| contact.pop | call | 182 | 11 | 16.5 |
| cruising | topic | 577 | 36 | 16.0 |
| strikeout.count | call | 124 | 8 | 15.5 |
| react.out | reaction | 91 | 6 | 15.2 |
| longAtBat | topic | 136 | 9 | 15.1 |
| close.records | segment | 14 | 1 | 14.0 |
| thirdTime | topic | 555 | 40 | 13.9 |
| callback | topic | 345 | 26 | 13.3 |
| phrase.bis.k | reaction | 26 | 2 | 13.0 |
| break.joke.biscuitName | segment | 75 | 6 | 12.5 |
| joke.nineHomers | topic | 147 | 12 | 12.3 |
| joke.pressBoxFood | topic | 118 | 10 | 11.8 |
| contact.grounder.hard | call | 116 | 10 | 11.6 |
| visitTangent | topic | 81 | 7 | 11.6 |
| powerGrade | topic | 132 | 12 | 11.0 |
| ondeck | call | 99 | 9 | 11.0 |
| pitchMix | topic | 447 | 42 | 10.6 |
| threeBreakers | topic | 131 | 13 | 10.1 |
| coldBat | topic | 234 | 24 | 9.8 |
| open.hello | segment | 29 | 3 | 9.7 |
| tightLate | topic | 168 | 19 | 8.8 |

## After (this branch)

Same harness, same seeds, same games (the sim does not depend on the booth). With the booth's memory shared along each chain, as the app does
(one memory per visit, kept in localStorage; measured at 7917935):

30 games in 3 chains of 10, 107 min a game on average, 841 lines a game (438 not calls)

| lines | per game | exact repeat within the game | shape repeat within the game | shape heard in an earlier game of the chain | ... in the second half of the chain |
|---|---|---|---|---|---|
| all | 841 | 6.2 % | 18.8 % | 68.2 % | 83.9 % |
| everything but calls | 438 | 4.6 % | 14.3 % | 67.1 % | 84.3 % |
| call | 404 | 8.0 % | 23.7 % | 69.5 % | 83.4 % |
| reaction | 15 | 1.1 % | 1.1 % | 63.2 % | 88.8 % |
| topic | 334 | 6.0 % | 16.0 % | 70.6 % | 87.6 % |
| segment | 89 | 0.2 % | 10.3 % | 54.5 % | 71.1 % |

Conversation topics: the booth looked for one 1327 times a game and had nothing 88.3 % of the time.

Not-call lines from game 2 on: 44.7 % were said in the game just before; on average each had been said 3.5 times in the earlier games of the chain; 44.2 % three times or more.

Not-call lines heard before, by game number in the chain (shape): g1 0.0 %, g2 46.0 %, g3 60.7 %, g4 68.0 %, g5 76.7 %, g6 79.9 %, g7 81.2 %, g8 87.0 %, g9 86.2 %, g10 87.6 %

Top repeaters (call): uses across all games, games it was heard in

| uses | games | tag | line (shape) |
|---|---|---|---|
| 97 | 30/30 | ball | He takes it, ball #. |
| 93 | 30/30 | ball | #N does not bite. Ball #. |
| 92 | 30/30 | ball | Out of the zone, ball #. |
| 92 | 30/30 | ball | He lays off it, ball #. |
| 92 | 30/30 | ball | He does not bite. Ball #. |
| 91 | 30/30 | ball | A little too fine, ball #. |
| 91 | 30/30 | ball | Takes it for ball #. |
| 90 | 30/30 | ball | Ball #, just off the edge. |
| 90 | 30/30 | ball | Misses the zone, ball #. |
| 89 | 30/30 | ball | Ball #, and #N stays patient. |
| 89 | 30/30 | ball | Off the plate, ball #. |
| 88 | 30/30 | ball | Not quite, ball #. |
| 88 | 30/30 | ball | That # is a ball, number #. |
| 87 | 30/30 | ball | He spits on it. Ball #. |
| 85 | 30/30 | ball | Nothing doing there. Ball #. |
| 84 | 30/30 | ball | He holds back, ball #. |
| 47 | 30/30 | strike.called | The umpire rings it up, strike #. |
| 43 | 30/30 | strike.called | Gets the call, strike #. |
| 83 | 29/30 | ball | Ball #, and the count is # and #. |
| 50 | 29/30 | fielded.clean | And #N grabs it. |
| 44 | 29/30 | strike.called | He leaves the bat on his shoulder, strike #. |
| 43 | 29/30 | strike.called | Locates it, strike #. |
| 43 | 29/30 | strike.called | Taken for strike #. |
| 41 | 29/30 | strike.foul | Foul ball, and a souvenir for somebody. |
| 41 | 29/30 | strike.called | Taken, and that is strike #. |
| 58 | 28/30 | batter.up | Now it is #N. |
| 58 | 28/30 | batter.up | Now batting, #N. |
| 58 | 28/30 | fielded.clean | Fielded by #N. |
| 57 | 28/30 | batter.up | Here is #N. |
| 56 | 28/30 | batter.up | #N steps in. |

Top repeaters (reaction): uses across all games, games it was heard in

| uses | games | tag | line (shape) |
|---|---|---|---|
| 15 | 15/30 | phrase.bis.k | That is biscuits and gravy right there. |
| 12 | 12/30 | react.k | Filthy. |
| 12 | 12/30 | react.k | Put him away. |
| 12 | 12/30 | phrase.bis.k | Mm-hmm. Biscuits and gravy. |
| 11 | 11/30 | react.k | Well pitched. |
| 11 | 11/30 | react.hit | Great approach. |
| 11 | 11/30 | react.k | He set that up beautifully. |
| 11 | 11/30 | react.k | Good pitch. |
| 11 | 11/30 | react.k | That is a pitcher pitching. |
| 11 | 11/30 | react.k | Great sequence there. |
| 11 | 11/30 | react.k | Never had a chance. |
| 11 | 11/30 | react.k | Wipeout pitch. |
| 11 | 11/30 | react.hit | Good swing. |
| 11 | 11/30 | react.k | Could not catch up to it. |
| 11 | 11/30 | react.hit | Went with the pitch. |
| 11 | 11/30 | react.k | He had # answer for that. |
| 11 | 11/30 | react.k | Got him. |
| 11 | 11/30 | react.k | Nasty. |
| 10 | 10/30 | react.hit | Stayed on it. |
| 10 | 10/30 | react.hit | Good, solid contact. |
| 10 | 9/30 | react.out | He was right there. |
| 9 | 9/30 | react.k | Ooh. |
| 9 | 9/30 | react.out | Clean. |
| 9 | 9/30 | react.hit | Nice piece of hitting. |
| 9 | 9/30 | react.hit | He put a good swing on that. |
| 9 | 9/30 | react.k | That is a tough at-bat. |
| 9 | 8/30 | react.out | That is how you do it. |
| 8 | 8/30 | react.hit | Squared it up. |
| 8 | 8/30 | react.hit | That is a quality at-bat. |
| 8 | 8/30 | react.hit | Right on the barrel. |

Top repeaters (topic): uses across all games, games it was heard in

| uses | games | tag | line (shape) |
|---|---|---|---|
| 97 | 30/30 | batterVsPitcher | #N is # for # against #N tonight. |
| 82 | 30/30 | fastballStreak | That is # fastballs in a row from #N. |
| 75 | 30/30 | pitchMix | About # percent fastballs from #N so far. |
| 58 | 30/30 | n.outs | # out here in the #. |
| 58 | 30/30 | coldBat | #N has struck out # tonight. |
| 57 | 30/30 | coldBat | # strikeouts for #N so far. |
| 54 | 30/30 | n.inning | We are rolling along in the #. |
| 53 | 30/30 | rattled | #N has put a runner on in # of the last # batters. |
| 50 | 30/30 | batterVsPitcher | This is the # look at #N for #N with # hits in # trips. |
| 49 | 30/30 | twoOutRsp | A runner in scoring position with # away. |
| 49 | 30/30 | batterVsPitcher | This is the # look at #N for #N and so far # hits in # trips. |
| 48 | 30/30 | twoOutRsp | # out, runner in scoring position. |
| 46 | 30/30 | n.inning | Lots of baseball to play. |
| 45 | 30/30 | sequence | You will see that again tonight. |
| 45 | 30/30 | twoOutRsp | # down, and a runner in scoring position. |
| 40 | 30/30 | sameHand | Tougher look for #N. |
| 38 | 30/30 | pitchMix | #N has thrown the heater # percent of the time tonight. |
| 37 | 30/30 | pitchMix | #N has thrown the fastball # percent of the time tonight. |
| 36 | 30/30 | clockLow | The clock is in single digits on #N. |
| 61 | 29/30 | thirdTime | # look at #N for #N. |
| 59 | 29/30 | thirdTime | The # time #N has seen #N tonight. |
| 56 | 29/30 | n.outs | # down, # to go. |
| 45 | 29/30 | n.inning | Long way to go. |
| 43 | 29/30 | fastballStreak | #N has thrown # straight fastballs now. |
| 43 | 29/30 | n.inning | Plenty of baseball left. |
| 43 | 29/30 | cruising | # straight batters set down by #N. |
| 42 | 29/30 | cruising | #N has retired # in a row. |
| 42 | 29/30 | fastballStreak | #N has gone with # straight fastballs now. |
| 36 | 29/30 | clockLow | Clock is winding down on #N. |
| 36 | 29/30 | clockLow | He had better get going, the clock is ticking. |

Top repeaters (segment): uses across all games, games it was heard in

| uses | games | tag | line (shape) |
|---|---|---|---|
| 66 | 30/30 | break.due | Coming up for the #N in the bottom of the #: #N. |
| 66 | 30/30 | break.due | #N are due up for the #N in the bottom of the #. |
| 65 | 30/30 | break.due | Due up for the #N in the bottom of the #: #N. |
| 63 | 30/30 | break.due | For the #N in the bottom of the #, it will be #N. |
| 60 | 30/30 | break.pitcher | The line on #N so far: # innings, # hits, # strikeouts, # pitches. |
| 59 | 30/30 | break.pitcher | #N has gone # innings on # pitches: # hits and # strikeouts. |
| 65 | 29/30 | break.pitcher | #N through # innings: # hits, # strikeouts, # pitches. |
| 27 | 27/30 | break.back | Back with more in a moment. |
| 27 | 27/30 | break.back | Stay right there. |
| 27 | 27/30 | break.back | Time for a break. Back in a moment. |
| 26 | 26/30 | break.back | We'll be right back. |
| 26 | 26/30 | break.back | Stay with us. We'll be right back from #N. |
| 24 | 24/30 | break.pitcher | Efficient. Nothing wasted. |
| 29 | 22/30 | break.back | A quick break, and we'll be right back with the top of the #. |
| 22 | 22/30 | break.pitcher | I would have loved catching that, Lyle. |
| 22 | 21/30 | break.pitcher | He is ahead of everybody. That is the whole secret. |
| 22 | 21/30 | break.pitcher | He is making it look easy. |
| 21 | 21/30 | break.pitcher | Hitters are not getting comfortable against him. |
| 21 | 21/30 | open.starter.home | On the mound for the #N the #-year-old right-hander. |
| 20 | 19/30 | break.pitcher | Strike #, all night long. That is how you do it. |
| 19 | 19/30 | break.pitcher | He has been in command. Nothing has come easy against him. |
| 19 | 18/30 | break.clock | The clock at #N says #-#-#, and it is # degrees. |
| 18 | 17/30 | break.pitcher | That's a good night's work so far, Lyle. |
| 16 | 16/30 | break.clock | It's #-#-# here at #N # degrees. |
| 16 | 16/30 | break.clock | It's #-# here at #N # degrees. |
| 16 | 16/30 | break.back | Don't go anywhere. More baseball from #N after this. |
| 16 | 14/30 | break.due | Coming up for the #N in the top of the #: #N. |
| 14 | 14/30 | break.clock | The clock at #N says #-#, and it is # degrees. |
| 14 | 14/30 | break.pitcher | He is grinding through it. |
| 13 | 13/30 | close.bat | #N went # for # with # RBI and a home run. |

Thinnest pools (tags by uses per distinct shape, at least 10 uses):

| tag | category | uses | distinct shapes | uses per shape |
|---|---|---|---|---|
| batter.up | call | 1163 | 23 | 50.6 |
| fielded.clean | call | 568 | 12 | 47.3 |
| n.outs | topic | 330 | 10 | 33.0 |
| clockLow | topic | 206 | 7 | 29.4 |
| advance | call | 251 | 9 | 27.9 |
| strike.foul | call | 593 | 23 | 25.8 |
| n.inning | topic | 358 | 14 | 25.6 |
| secondGuess | topic | 292 | 12 | 24.3 |
| contact.grounder | call | 509 | 22 | 23.1 |
| ball | call | 2440 | 116 | 21.0 |
| break.back | segment | 193 | 10 | 19.3 |
| safe | call | 361 | 21 | 17.2 |
| strike.swinging | call | 588 | 35 | 16.8 |
| sameHand | topic | 419 | 26 | 16.1 |
| wall | call | 122 | 8 | 15.3 |
| zeroes | topic | 212 | 14 | 15.1 |
| strike.foul.two | call | 295 | 20 | 14.8 |
| strike.called | call | 1119 | 76 | 14.7 |
| loaded | topic | 200 | 14 | 14.3 |
| n.score | topic | 178 | 13 | 13.7 |
| phrase.bis.k | reaction | 27 | 2 | 13.5 |
| twoOutRsp | topic | 376 | 28 | 13.4 |
| run | call | 240 | 18 | 13.3 |
| fastballStreak | topic | 493 | 37 | 13.3 |
| joke.infieldSingle | topic | 119 | 9 | 13.2 |
| n.lead | topic | 254 | 20 | 12.7 |
| longAtBat | topic | 160 | 13 | 12.3 |
| sequence | topic | 703 | 59 | 11.9 |
| firstPitchBreaking | topic | 658 | 56 | 11.8 |
| joke.nineHomers | topic | 117 | 10 | 11.7 |
| break.due | segment | 513 | 44 | 11.7 |
| strikeout.count | call | 128 | 11 | 11.6 |
| hit.fc | call | 104 | 9 | 11.6 |
| contact.pop | call | 182 | 16 | 11.4 |
| break.pitcher | segment | 522 | 46 | 11.3 |
| visitTangent | topic | 87 | 8 | 10.9 |
| react.k | reaction | 163 | 15 | 10.9 |
| batterVsPitcher | topic | 379 | 35 | 10.8 |
| cruising | topic | 384 | 36 | 10.7 |
| pitch.change | call | 120 | 13 | 9.2 |
| anecdote.lyle.lineupCard | topic | 18 | 2 | 9.0 |
| coldBat | topic | 243 | 27 | 9.0 |
| clockRule | topic | 89 | 10 | 8.9 |
| threeBreakers | topic | 124 | 14 | 8.9 |
| callback | topic | 444 | 51 | 8.7 |
| react.hit | reaction | 127 | 15 | 8.5 |
| powerGrade | topic | 131 | 16 | 8.2 |
| strikeout.swinging | call | 368 | 45 | 8.2 |
| contact.grounder.hard | call | 117 | 15 | 7.8 |
| pitchMix | topic | 299 | 39 | 7.7 |
| break.clock | segment | 114 | 15 | 7.6 |
| thirdTime | topic | 241 | 32 | 7.5 |
| countTendency | topic | 495 | 69 | 7.2 |
| walk | call | 161 | 23 | 7.0 |
| anecdote.game.lights | topic | 14 | 2 | 7.0 |
| fold.count | call | 124 | 18 | 6.9 |
| rattled | topic | 226 | 33 | 6.8 |
| tightLate | topic | 169 | 25 | 6.8 |
| ondeck | call | 101 | 15 | 6.7 |
| hotBat | topic | 180 | 27 | 6.7 |

With `--memory off` (a fresh booth memory every game: the wider pool and the caps alone):

30 games in 3 chains of 10, 107 min a game on average, 839 lines a game (436 not calls)

| lines | per game | exact repeat within the game | shape repeat within the game | shape heard in an earlier game of the chain | ... in the second half of the chain |
|---|---|---|---|---|---|
| all | 839 | 5.6 % | 18.5 % | 69.7 % | 84.4 % |
| everything but calls | 436 | 4.1 % | 14.4 % | 69.3 % | 84.9 % |
| call | 404 | 7.2 % | 22.9 % | 70.2 % | 83.9 % |
| reaction | 15 | 0.7 % | 0.7 % | 63.6 % | 84.4 % |
| topic | 332 | 5.3 % | 15.5 % | 72.7 % | 88.0 % |
| segment | 89 | 0.2 % | 12.7 % | 57.2 % | 73.1 % |

Conversation topics: the booth looked for one 1328 times a game and had nothing 88.3 % of the time.

Not-call lines from game 2 on: 50.8 % were said in the game just before; on average each had been said 3.6 times in the earlier games of the chain; 45.9 % three times or more.

Not-call lines heard before, by game number in the chain (shape): g1 0.0 %, g2 53.9 %, g3 66.1 %, g4 72.4 %, g5 78.1 %, g6 79.8 %, g7 83.6 %, g8 86.2 %, g9 86.7 %, g10 88.3 %

## Before and after, in short

| not-call lines (conversation, segments, reactions) | before | after, no memory | after, with memory |
|---|---|---|---|
| lines a game | 495 | 436 | 438 |
| exact words repeated within the game | 16.7 % | 4.1 % | 4.6 % |
| same line (names masked) repeated within the game | 38.8 % | 14.4 % | 14.3 % |
| said in the game just before (games 2-10) | 65.9 % | 50.8 % | 44.7 % |
| times each line had been said in the earlier games (mean) | 8.3 | 3.6 | 3.5 |
| heard three times or more before | 66.6 % | 45.9 % | 44.2 % |
| heard at least once in an earlier game | 77.8 % | 69.3 % | 67.1 % |

How to read it: "heard at least once before" saturates once the pool has gone round (by game 10 most lines have been said once somewhere), so
it moves least. What a listener memorizes is how *often* a line comes back: before this pass a conversation line had been heard eight times in
the games before; now about three and a half, and the memory keeps the one from last game from coming straight back.

The talk is about 12 % thinner (495 -> 438 not-call lines a game, conversation lines 395 -> 334; measured at Broadcast tempo only): the stories that fired on almost every
plate appearance (a first-pitch breaking ball, two fastballs and a change, righty on righty, "two down, one to go") are now capped per game
(`STORY_CAPS` in `stories.ts`), and the booth's own anecdotes (about 7 a game, 18 lines) and the new running jokes fill part of that time.
If the booth feels too quiet, raise the caps in `STORY_CAPS` or shorten `ANECDOTE_GAP` / raise `MAX_ANECDOTES` in `booth.ts`.
(The owner did find it a tad quiet: see *A more talkative booth* below, which brings the talk back to 497 lines a game with fewer repeats.)

## What changed

- **The memory** (`src/audio/broadcast/memory.ts`): every template, every `{a|b}` choice, every story, anecdote and running joke the booth
  picks is stamped; the next pick prefers the never-heard, then the longest-ago (the freshest third shuffled, so it is not a fixed rotation).
  Keys are the line's shape: the template string, or a line written with tonight's names already in it, with the game's names, digits and
  number words masked, so "Here comes Smith" and "Here comes Jones" count as one line, and so do "We'll be right back from Kestrel Park" and
  "... from Cobalt Grounds" (the first version keyed the filled-in text, so such lines always looked new and won every time). The app keeps one memory for the visit and
  saves it in `localStorage` (`claudeball.booth.memory.v1`, about 5000 keys at most, a few tens of KB) every 150 picks, when the tab is hidden
  and when a game is torn down. Without a memory (tests calling the grammar directly) the old random choice is unchanged.
- **The booth's own stories** (`anecdotes.ts`): about 85 exchanges between Lyle and Biscuit that are not about tonight's players (so they can
  never be wrong about them): Biscuit's eleven years behind the plate, his nine home runs, the bullpen phone, Lyle's pencils and scorebooks,
  press boxes, the park. Each fits a kind of moment (the catcher batting, a mound visit, a pitching change, a blowout, a scoreless game,
  extra innings, a day or a night game, after a steal, a home run, an error, a double play, a big strikeout night, or any long lull).
- **Running jokes** (`cast.ts`): seven new ones with stages that build through a game (Lyle's pencils running out, Biscuit's diet, the dot
  race, the booth air conditioning, the catcher's infield single, what to say on a mound visit, the bullpen phone). Four begin per game at most,
  the ones heard longest ago. Nine more park promos.
- **Wider pools** for the most-heard lines: batter intros (8 -> 23 forms heard in the 30 games), fielded balls, balls and strikes, fouls, grounders, runner advances, the
  folded count, the analyst's quick reactions and pools for the home-run and robbed-homer reactions (were a fixed "Wow!" / "Oh!"); the
  answers of the busiest stories; break recaps, pitcher lines, "be right back" / "we're back" and the due-up line; the closing's final,
  records, game ball and sign-off; the opening's welcome, hello, weather, records, park, mascot, PA and handoff.
- **Callbacks**: a hitter's last trip now also recalls a double play, a sacrifice fly, reaching on an error or two walks; a fielder who made an
  error is reminded of it when he bats; the clubs' records coming in are set against tonight's score.
- **The PA** names the club the first time a player is announced ("Now batting for the Falcons, number 7, ...", "Now pitching for your
  Kings, ...", "Leading off for ..."), then the usual short form.
- **The custom voice's word list** (`tools/announcer/script/data/vocab.txt`, `npm run announcer:vocab`) now reads the booth's folder (it read
  only `src/audio/*.ts`), the generated parks, officials and managers, and the forms the booth builds (possessives, ages, clock times):
  1,627 -> 3,975 words. A test fails when a line the booth can say has a word missing (the custom voice drops a whole line on an unknown word).
- **The recording script** (`npm run announcer:script`) takes the booth's written lines (anecdotes, running jokes, catchphrases, promos;
  469 lines, about 45 minutes of audio) into new extended sessions E7-E10; no existing line changed id or session.

## Not changed

- The umpire's calls ("Ball!", "Strike three!") and the PA's short forms: formulaic on purpose, as in a real park.
- The catchphrases (rationed, and they are the characters' signatures).
- Calls are still the most repeated lines (a ball is a ball): 23 % of call shapes repeat within a game. Their pools are wider, and the memory
  rotates them.

## A more talkative booth (2026-10-30)

The owner, after playing: *"the booth is just a tad too quiet now, not like volume level but just not talkative enough."* Same harness, same seeds,
memory on, 3 chains of 10 games at each tempo; before is main at d51d9f4 (the numbers above), after is this pass:

| not-call lines | Broadcast before | Broadcast after | Standard before | Standard after | Quick before | Quick after |
|---|---|---|---|---|---|---|
| lines a game | 438 | **497** | 372 | 387 | 291 | 309 |
| conversation (topic) lines a game | 334 | 383 | 298 | 305 | 262 | 273 |
| analyst reactions a game | 15 | 21 | 14 | 22 | 14 | 20 |
| exact words repeated within the game | 4.6 % | 4.0 % | 4.8 % | 4.7 % | 4.9 % | 5.1 % |
| same line (names masked) repeated within the game | 14.3 % | **12.5 %** | 15.0 % | 14.9 % | 13.8 % | 13.9 % |
| said in the game just before (games 2-10) | 44.7 % | 41.3 % | 46.5 % | 46.5 % | 41.8 % | 42.9 % |
| times each line had been said in the earlier games (mean) | 3.5 | 3.3 | 3.7 | 3.7 | 3.3 | 3.4 |
| heard three times or more before | 44.2 % | 42.4 % | 46.8 % | 47.7 % | 43.0 % | 45.0 % |
| calls a game (balls, strikes, plays) | 404 | 399 | 391 | 398 | 373 | 376 |

**Why it was quiet.** Supply, not the caps: the booth asked for a topic ~1300 times a game at Broadcast and had nothing 88 % of the time. Raising
`STORY_CAPS` alone (tried: +13 lines) cost about 0.4 within-game repeats per line gained: those stories have small pools. The booth's own stories
and the running jokes never repeat within a game, but an anecdote needed a 10-second lull that was *not* a pitch (a walk-up, a mound visit, a
pitching change), so only ~7 fit a game.

**What changed.**
- A pitcher's routine between pitches counts as a lull for the booth's stories and jokes (`nextTopic` in `booth.ts`). At Broadcast tempo it
  leaves ~10 s (median 10.5 s, 120 of ~180 a game are 10 s or more), so a story starts there and runs on over a ball or a strike (the call is
  folded into the next line or dropped, as for any topic; calls a game: 404 -> 399). At Standard (~6 s) and Quick (~2 s) nothing changes there.
- The booth's stories: up to 26 a game, 75 s apart (were 10 and 240 s); about 17 a game now (were ~7). 28 new ones (114 in all), appended at
  the end of `ANECDOTES` so the recording script's sessions move as little as possible.
- Running jokes begun per game: 8 (were 4). The analyst chimes in on 60 % of the big calls (35 %; High 75 %, was 60 %).
- Neutral fillers when nothing else fits: 60 % of the time (40 %). The breath after a topic at Normal chatter: 4-9 s (5-11 s).
- Not changed: `STORY_CAPS` (see above).

At Broadcast the new talk is mostly the booth's stories, so the within-game repeat rate went down and fewer lines come straight back from the game
before. Standard and Quick gain less (their lulls are short) and their repeat numbers are flat. To go further: `MAX_ANECDOTES` / `ANECDOTE_GAP`
(with 114 stories and ~17 a game, one comes round again about every six or seven games), or more anecdotes.


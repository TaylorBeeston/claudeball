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

30 games in 3 chains of 10, 107 min a game on average, 893 lines a game (495 not calls)

| lines | per game | exact repeat within the game | shape repeat within the game | shape heard in an earlier game of the chain | ... in the second half of the chain |
|---|---|---|---|---|---|
| all | 893 | 15.5 % | 39.0 % | 75.2 % | 89.2 % |
| everything but calls | 495 | 16.7 % | 38.8 % | 77.8 % | 92.1 % |
| call | 398 | 14.0 % | 39.4 % | 72.0 % | 85.4 % |
| reaction | 14 | 24.9 % | 24.9 % | 74.1 % | 93.4 % |
| topic | 395 | 18.3 % | 40.2 % | 78.8 % | 93.1 % |
| segment | 86 | 7.7 % | 34.3 % | 74.0 % | 87.3 % |

Conversation topics: the booth looked for one (it asks again every 1.5 s while it has nothing, so this is a relative number) 1166 times a game and had nothing 83.8 % of the time.

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


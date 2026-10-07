# Booth openings

The pregame broadcast as the booth schedules it: the PA announcer's welcome, the opening segment while the home team takes the field and the starter warms up, the umpire's "Play ball!", and the handoff into the top of the first. Generated with the real sim and the booth on a fake clock (speaking times are the director's estimates; real voices differ a little, and the director skips an optional exchange that would not fit before the umpire's call):

```
npx tsx scripts/booth-transcript.ts <seed> normal 1 <tempo> <day|dusk|night> --opening
```

The PA line at 00:00.6 is listed first; the booth waits for it (browser voices cannot overlap, and it is better heard on its own with the HD voices too). "Now batting ..." is the PA's usual batter announcement (abbreviated here). Lines after the handoff are the usual between-pitch conversation.

**The cast** (`src/audio/broadcast/cast.ts`, fictional people): **Lyle Pemberton** (play-by-play: twenty-six seasons, a pencil scorebook, ballpark history, dry wit), **Hollis "Biscuit" Dupree** (analyst: eleven seasons as a backup catcher for four clubs, a .219 career hitter with nine home runs he remembers one by one, sees the game from behind the plate, quick to laugh at himself), and **Clem Ashworth** on the PA. Captions label them `LYLE`, `BISCUIT` and `PA`.

**Where the facts come from.** Clubs, lineups, starters, ages, velocities, pitch grades and usage: the sim's team data. The park, the umpires, the managers, the clubs' records coming in, the date and the mascot: `src/sim/gameinfo.ts` (generated, on its own random streams, so the game itself is unchanged; the park and the manager belong to the home club). Weather and first-pitch time: derived from the seed and the time of day the renderer shows (`weatherFor` in `pregame.ts`): the day sky is cloudless unless the day HDRI is loaded (then "partly cloudy"), dusk is a sunset out past left field (where the dusk sun is), night is a clear sky. The sim has no wind unless one is configured, so the breeze is flavour and nobody says it helps or hurts fly balls.

**Pregame length** (the sim's first break, `breakStart { pregame: true }`): 60-90 s at Broadcast tempo, about 36-54 s at Standard, about 15-22 s at Quick. The opening is fitted to it: the welcome always; then, most important first, the home starter, the records, the analyst's hello, the weather, the visiting starter, the lineups, the teams taking the field, the umpires, the managers, the park, the mascot, the PA man.

## Seed 11, day, Broadcast tempo

```
00:00.6 PA      Good afternoon, ladies and gentlemen, welcome to Heritage Field! Today, the Richmond Falcons visit your Madison Kings.
00:00.0 ---     pregame 76.4 s
00:09.3 PXP     Good afternoon, everybody, and welcome to Heritage Field, where the Kings host the Richmond Falcons on a Tuesday afternoon in late July. Lyle Pemberton here, next to Hollis Dupree.
00:21.5 COLOR   Biscuit to everybody but my mother, Lyle. Good to be here.
00:26.7 PXP     Plenty of sunshine, 93 degrees, hardly a breeze. First pitch at one-ten.
00:32.5 COLOR   Hot. Somebody bring the catchers a towel.
00:36.1 PXP     The Falcons: 55 and 53 on the year, seven and three over their last ten. The Kings: 56 and 51 on the year, winners of three straight.
00:47.8 COLOR   Not much between these two clubs.
00:50.8 PXP     On the mound for the Kings, Leo Brooks, the 27-year-old left-hander.
00:55.8 COLOR   He sits around 91 with the fastball. The curveball is his best pitch, a 65 on the scouting scale, and he throws it every so often.
01:06.8 PXP     For the Falcons, Garrett Edwards gets the start, a left-hander.
01:16.4 PA      Now batting ... Logan Barnes
01:16.6 UMP     Play ball!
01:16.9 PXP     Play ball, says the umpire. Barnes steps in against Brooks, and it's the top of the first.
01:32.6 ---     first pitch
```

## Seed 23, dusk, Broadcast tempo

```
00:00.6 PA      Good evening, ladies and gentlemen, welcome to Cobalt Grounds! Tonight, the Raleigh Voyagers visit your Salem Wolves.
00:00.0 ---     pregame 72.9 s
00:09.3 PXP     Good evening, everybody, and welcome to Cobalt Grounds, where the Wolves host the Raleigh Voyagers on a Saturday evening in mid-July. Lyle Pemberton here, alongside Hollis Dupree.
00:20.9 COLOR   Good to be here, Lyle. And it's Biscuit, folks. Nobody calls me Hollis.
00:27.3 PXP     The Voyagers: 54 and 45 on the year, winners of four of their last five. The Wolves: 48 and 50 on the year, winners of four straight.
00:38.8 COLOR   The Voyagers have the better record, but that does not hit or pitch tonight.
00:44.8 PXP     On the mound for the Wolves, Diego Silva, the 35-year-old left-hander.
00:50.1 COLOR   He sits around 89 with the sinker. The slider is his best pitch, a 60 on the scouting scale, and he throws it every so often. The command comes and goes, so the walks can pile up.
01:13.0 PA      Now batting ... Sam Kim
01:13.2 UMP     Play ball!
01:13.5 PXP     And there is the call to play ball. Kim to lead off against Silva, and it's the top of the first.
01:22.2 COLOR   Kim has 80-grade power.
01:24.5 PXP     That is why Silva is careful.
01:27.8 ---     first pitch
```

## Seed 42, night, Broadcast tempo

```
00:00.6 PA      Good evening, ladies and gentlemen, welcome to Kestrel Park! Tonight, the Eugene Foxes visit your Wichita Chargers.
00:00.0 ---     pregame 76.4 s
00:09.3 PXP     Good evening, everybody, and welcome to Kestrel Park, where the Chargers host the Eugene Foxes on a Monday night in early July. Lyle Pemberton here, next to Hollis Dupree.
00:21.4 COLOR   Good to be here, Lyle. And it's Biscuit, folks. Nobody calls me Hollis.
00:27.9 PXP     A clear, dark sky, 80 degrees, the flags hanging still. First pitch at eight-oh-five.
00:34.4 COLOR   Perfect weather for baseball.
00:36.5 PXP     The Foxes: 49 and 39 on the year, winners of four of their last five. The Chargers: 49 and 39 on the year, five and five over their last ten.
00:49.1 COLOR   Two clubs right on top of each other, so this one matters.
00:54.4 PXP     On the mound for the Chargers, Jon Gibson, the 26-year-old left-hander.
00:59.3 COLOR   He works at 92 with the fastball. The changeup is his best pitch, a 70 on the scouting scale, and he throws it every so often. He pounds the strike zone.
01:16.4 PA      Now batting ... Bryce Myers
01:16.6 UMP     Play ball!
01:16.9 PXP     And we have the call: play ball. Myers to lead off against Gibson, and it's the top of the first.
01:25.4 COLOR   70-grade control for Gibson. He lives on the edges.
01:29.6 PXP     Painting the corners.
01:32.7 ---     first pitch
```

## Seed 42, night, Standard tempo (same game, shorter pregame)

```
00:00.6 PA      Good evening, ladies and gentlemen, welcome to Kestrel Park! Tonight, the Eugene Foxes visit your Wichita Chargers.
00:00.0 ---     pregame 45.8 s
00:09.3 PXP     Good evening, everybody, and welcome to Kestrel Park, where the Chargers host the Eugene Foxes on a Monday night in early July. Lyle Pemberton here, next to Hollis Dupree.
00:21.4 PXP     On the mound for the Chargers, Jon Gibson, the 26-year-old left-hander.
00:26.6 COLOR   He works at 92 with the fastball. The changeup is his best pitch, a 70 on the scouting scale, and he throws it every so often. He pounds the strike zone.
00:45.8 PA      Now batting ... Bryce Myers
00:46.0 UMP     Play ball!
00:46.4 PXP     And we have the call: play ball. Myers to lead off against Gibson, and it's the top of the first.
00:54.9 COLOR   70-grade control for Gibson. He lives on the edges.
00:59.1 PXP     That is why the walks are rare.
01:00.2 ---     first pitch
```

## Seed 42, night, Quick tempo (the short welcome)

```
00:00.6 PA      Good evening, ladies and gentlemen, welcome to Kestrel Park! Tonight, the Eugene Foxes visit your Wichita Chargers.
00:00.0 ---     pregame 19.1 s
00:09.3 PXP     Good evening from Kestrel Park, where the Chargers host the Foxes. Lyle Pemberton with Hollis Dupree.
00:19.1 PA      Now batting ... Bryce Myers
00:19.3 UMP     Play ball!
00:19.6 PXP     And we have the call: play ball. Myers to lead off against Gibson, and it's the top of the first.
00:27.7 ---     first pitch
```

## After the opening: breaks, the conversation, the closing

Excerpts from seed 42, night, Broadcast tempo, the whole game (`npx tsx scripts/booth-transcript.ts 42 normal 9 broadcast night`).

### Breaks between half innings

The recap, the pitcher's line, a promo / the clock / a running joke, and who is due up. In every other long break there is a "commercial": the booth stops and comes back in time for the due-up line.

```
15:45.6 ---     break 35.8 s
15:50.4 PXP     After one, it's Chargers 3, Foxes 0. The Chargers scored three in the bottom, Abbott's two-run double the big blow.
15:59.2 PXP     Fireworks after the game tonight, weather permitting.
16:02.8 PXP     We'll be right back.
16:11.7 PXP     We're back. Due up for the Foxes in the top of the second: Ruiz, Campbell and Blanco.

19:40.1 ---     break 38.2 s
19:44.5 PXP     Middle of the second, Chargers 3, Foxes 0. A quick one-two-three top for Gibson.
19:51.1 PXP     Gibson through two innings: no hits, two strikeouts, 22 pitches.
19:55.8 COLOR   Hitters are not getting comfortable against him.
19:59.2 PXP     Somebody asked me again why they call you Biscuit.
20:03.3 COLOR   Double-A, a Sunday doubleheader, and a basket of buttermilk biscuits. I ate eleven between games, Lyle. Went oh for eight.
20:12.3 PXP     A legend was born.
20:14.5 PXP     Due up for the Chargers in the bottom of the second: Coleman, Campbell and Harris.

25:03.3 ---     break 51.1 s
25:05.5 PXP     Through two, Chargers 3, Foxes 0. Williams needed just three hitters.
25:11.0 PXP     Williams through two innings: four hits, two strikeouts, 32 pitches.
25:15.9 COLOR   He is grinding through it.
25:18.6 PXP     It's eight-forty-three here at Kestrel Park, 80 degrees.
25:22.2 PXP     Time for a break. Back in a moment.
25:43.6 PXP     Back here at Kestrel Park. Due up for the Foxes in the top of the third: Anderson, Thomas and Guerrero.
```

### Running jokes, callbacks, second-guessing, a catcher's tangent

```
21:57.5 PXP     Here is a catcher with a bat in his hands, Biscuit. Any advice?
22:03.7 COLOR   Swing hard in case you hit it. That was my whole plan for eleven years.
24:03.0 PXP     Last time up, Harris hit a double in the first.
24:07.5 COLOR   Williams will remember that one.
45:43.1 PXP     Last time up, Abbott drove in two runs with a double in the first.
45:49.0 COLOR   Williams will remember that one.
54:29.5 PXP     Another catcher up. Should I ask about the nine home runs, Hollis?
54:35.2 COLOR   You already asked. But number four was off a lefty, and nobody hit that lefty.
54:42.0 PXP     The wind was blowing out. Of course it was.
75:36.0 PXP     The press-box sliders have arrived, folks. The kind you eat.
75:40.7 COLOR   I will be the judge of those, Lyle.
75:50.6 COLOR   Williams was done. 87 pitches, and he was laboring.
75:55.1 PXP     Agreed. Edwards takes it from here.
82:20.7 PXP     Campbell has struck out twice so far.
82:24.0 COLOR   Edwards has had his number so far.
90:28.8 PXP     A visit from the catcher. You made a few of those, Biscuit.
90:34.3 COLOR   Half the time you are buying time for the bullpen. The other half you are asking what he wants for dinner.
90:43.3 PXP     I will let the folks at home decide.
97:55.8 COLOR   Gibson was done. 91 pitches, and he was laboring.
98:00.4 PXP     Agreed. Fisher takes it from here.
117:32.5 PXP     Last time up, Coleman homered in the sixth.
117:36.5 COLOR   Let's see if he can do it again.
121:15.2 PXP     Quick update on the sliders: there are none left.
121:19.6 COLOR   That is called a scouting report, Lyle. Somebody had to do it.
121:32.1 COLOR   I would have let Edwards face one more, Lyle. 40 pitches, and he was still throwing strikes.
121:39.8 PXP     Not me. I take the fresh arm there every time, and Guerrero is ready.
121:46.4 COLOR   Well, that is why he manages and I talk.
127:28.2 PXP     Last time up, Campbell homered in the seventh.
127:32.1 COLOR   He will be looking for more of the same.
```

### Catchphrases (rationed: once or twice a game each)

```
19:07.6 COLOR   That is biscuits and gravy right there.
126:55.0 PXP   ! Ruiz gets all of it! Home run! Pack a lunch!
```

### Calling each other by name (now and then)

```
08:04.6 PXP     Well, Biscuit, getting ahead of the count, and showing Cruz something to think about.
14:55.2 COLOR   Well, Lyle, one hit and it is a run.
22:22.0 PXP     Well, Biscuit, and the slider is the pitch that gets mixed in.
35:57.2 COLOR   Yeah, Lyle, that can disappear in a hurry.
43:38.8 COLOR   Yeah, Lyle, still a lot of game ahead.
48:25.3 PXP     Well, Biscuit, if Coleman has noticed, he can sit on it.
52:11.3 PXP     Yeah, Biscuit, hitters usually see it better each time through.
54:29.5 PXP     Another catcher up. Should I ask about the nine home runs, Hollis?
56:44.9 PXP     Yeah, Biscuit, he has seen enough of Williams by now.
58:53.2 COLOR   Well, Lyle, everything is working for Williams right now.
```

### The closing

```
131:04.9 PXP   ! It's over! Wichita Chargers come away with it, 8 to 3.
131:10.0 PXP     The final here at Kestrel Park: the Chargers 8, the Foxes 3.
131:15.4 PXP     The difference: Abbott's two-run double in the first, breaking the tie.
131:20.6 COLOR   That is the one they will be talking about.
131:24.6 COLOR   Gibson gave them six and a third: two hits, two earned, six strikeouts. Give him the game ball.
131:32.6 PXP     The Chargers improve to 50 and 39; the Foxes fall to 49 and 40.
131:38.5 COLOR   Fun one tonight, Lyle.
131:40.7 PXP     For Hollis "Biscuit" Dupree, I'm Lyle Pemberton. Thanks for spending the night with us, and good night from Kestrel Park.
```

## What needs your ears

- **The two characters with real voices.** With the HD voices (Kokoro) Lyle is `am_michael` and Biscuit `bm_george` (a British-accented preset: if a former catcher with an English accent sounds wrong to you, `bm_lewis` or `am_eric` are the other male presets to try; change `voice.kokoro` in `cast.ts`). With browser voices both are now male voices when the browser has three (the analyst used to get a female voice first).
- **Pace of the opening.** Do the 0.2-0.6 s beats between turns and the length of the welcome feel like a broadcast, or rushed?
- **The handoff timing.** With the HD voices the handoff starts about 0.3 s after the umpire's "Play ball!" (the PA ducks under the booth). With browser voices, which cannot overlap, it waits until the PA and the umpire are done: checked in Chrome, the order is "Now pitching" -> "Play ball!" -> "Now batting" -> the handoff.
- **Catchphrases and running jokes**: rationed (once or twice a game each, jokes in stages 10-25 minutes apart). Tell me which ones land and which grate.
- **Breaks**: the "We'll be right back ... And we're back" commercial in every other long break: do you like the silent "commercial", or should the booth keep talking through every break?
- **The closing** plays over the game-over screen (45 s). Should the summary screen wait for the sign-off?

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

## What needs your ears

- **The two characters with real voices.** With the HD voices (Kokoro) Lyle is `am_michael` and Biscuit `bm_george` (a British-accented preset: if a former catcher with an English accent sounds wrong to you, `bm_lewis` or `am_eric` are the other male presets to try; change `voice.kokoro` in `cast.ts`). With browser voices both are now male voices when the browser has three (the analyst used to get a female voice first).
- **Pace of the opening.** Do the 0.2-0.6 s beats between turns and the length of the welcome feel like a broadcast, or rushed?
- **The handoff timing.** With the HD voices the handoff starts about 0.3 s after the umpire's "Play ball!" (the PA ducks under the booth). With browser voices, which cannot overlap, it waits until the PA and the umpire are done: checked in Chrome, the order is "Now pitching" -> "Play ball!" -> "Now batting" -> the handoff.
- **Catchphrases and running jokes** (stage 2) are written but rationed (one or two a game): tell me which ones land.

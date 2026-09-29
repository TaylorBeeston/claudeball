import { DEFAULT_ENV } from './ball';
import { DEFAULT_FENCE, MOUND_DIST } from './field';
import { Rng } from './rng';
import { newDecState } from './dispatch';
import { createAI } from './ai';
import { generateTeam } from './roster';
import { accelOfRating, sprintOf } from './attributes';
import { strikeZoneFor } from './pitching';
import type { BatterLine, FieldPosition, GameConfig, PitcherLine, PlayerInfo, Team, TeamSide } from './types';
import type { LineupSlot, PlayerRT, TeamRT, World } from './world';

export const emptyBatLine = (): BatterLine => ({ pa: 0, ab: 0, h: 0, doubles: 0, triples: 0, hr: 0, bb: 0, so: 0, hbp: 0, rbi: 0, r: 0, sb: 0, cs: 0, sf: 0, sh: 0 });
export const emptyPitLine = (): PitcherLine => ({ outs: 0, bf: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, hbp: 0, pitches: 0, strikes: 0, wp: 0 });

/** Default defensive alignment (x toward 1B, z toward CF). */
export const DEFAULT_SPOTS: Record<Exclude<FieldPosition, 'DH'>, { x: number; z: number }> = {
  P: { x: 0, z: MOUND_DIST },
  C: { x: 0, z: -1.1 },
  '1B': { x: -17.6, z: 23.0 },
  '2B': { x: -8.6, z: 34.5 },
  SS: { x: 9.0, z: 33.5 },
  '3B': { x: 17.6, z: 23.0 },
  LF: { x: 33, z: 83 },
  CF: { x: 0, z: 92 },
  RF: { x: -33, z: 83 },
};

export const DUGOUT = { home: { x: 30, z: 10 }, away: { x: -30, z: 10 } }; // home dugout on the third-base side

function makePlayerRT(info: PlayerInfo, team: TeamRT): PlayerRT {
  return {
    info,
    team,
    bat: emptyBatLine(),
    pit: emptyPitLine(),
    pitchCount: 0,
    inGame: false,
    used: false,
    fieldPos: null,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    facing: 0,
    lookAt: null,
    goal: null,
    reactUntil: 0,
    vmax: sprintOf(info.ratings.speed),
    accel: accelOfRating(info.ratings.acceleration),
    role: 'fielder',
    anim: 'idle',
    animStart: 0,
    animDur: 0,
    animUntil: 0,
    hasBall: false,
    fatigue: 0,
    onField: false,
    leap: null,
    home: null,
    legs: 0,
    form: 0,
    rattle: 0,
    gait: null,
    wallTick: -9999,
    plan: { kind: 'idle', base: 0, tx: 0, tz: 0, reactTick: 0, biasX: 0, biasZ: 0, biasY: 0, biasT: 0, wall: null, askSeq: 0, lastSig: '', recheckTick: 0, asking: false, tagTarget: null, holdUntil: 0, releaseAt: 0, throwBase: 0, throwTo: null, lastAttempt: -999, wasPrimary: false, delays: 0 },
  };
}

export function makeTeamRT(team: Team, side: TeamSide, dh: boolean): TeamRT {
  const players = new Map<string, PlayerRT>();
  const t: TeamRT = {
    side,
    team,
    players,
    lineup: [],
    batIdx: 0,
    bench: [],
    bullpen: [],
    pitcher: undefined as unknown as PlayerRT,
    defense: new Map(),
    runs: 0,
    hits: 0,
    errors: 0,
    lob: 0,
    linescore: [],
    dhLostPitcherHits: false,
  };
  for (const info of team.roster) players.set(info.id, makePlayerRT(info, t));
  const sp = players.get(team.startingPitcherId)!;
  t.pitcher = sp;
  sp.inGame = true;
  sp.used = true;
  sp.fieldPos = 'P';
  t.defense.set('P', sp);
  const lineup: LineupSlot[] = [];
  for (const l of team.lineup) {
    const p = players.get(l.playerId)!;
    p.inGame = true;
    p.used = true;
    p.fieldPos = l.position;
    if (l.position === 'DH') {
      if (dh) lineup.push({ player: p, position: 'DH' });
      else {
        // no DH: the pitcher bats in the DH slot; the DH sits
        p.inGame = false;
        p.used = false;
        p.fieldPos = null;
        lineup.push({ player: sp, position: 'P' });
      }
    } else {
      lineup.push({ player: p, position: l.position });
      t.defense.set(l.position, p);
    }
  }
  t.lineup = lineup;
  for (const id of team.bench) {
    const p = players.get(id);
    if (p && !p.inGame) t.bench.push(p);
  }
  if (!dh) {
    const dhPlayer = team.lineup.find((l) => l.position === 'DH');
    if (dhPlayer) {
      const p = players.get(dhPlayer.playerId)!;
      if (!t.bench.includes(p)) t.bench.push(p);
    }
  }
  for (const id of team.bullpen) t.bullpen.push(players.get(id)!);
  return t;
}

export function createWorld(cfg: GameConfig): World {
  const rng = new Rng(cfg.seed);
  const teamSeed = cfg.teamSeed ?? cfg.seed;
  const dh = cfg.dh ?? true;
  const homeTeam = cfg.homeTeam ?? generateTeam(`${teamSeed}:home`, { side: 'home' });
  const awayTeam = cfg.awayTeam ?? generateTeam(`${teamSeed}:away`, { side: 'away' });
  const home = makeTeamRT(homeTeam, 'home', dh);
  const away = makeTeamRT(awayTeam, 'away', dh);
  const fence = cfg.fence ?? DEFAULT_FENCE;
  const env = DEFAULT_ENV(fence);
  if (cfg.wind) {
    env.windX = cfg.wind.x;
    env.windZ = cfg.wind.z;
  }
  env.clScale = 0.82;
  const ballBody = { x: 0, y: 1.2, z: MOUND_DIST, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, rolling: false };
  const w: World = {
    cfg: { ...cfg, dh, innings: cfg.innings ?? 9, extraInningsRunner: cfg.extraInningsRunner ?? true, pace: cfg.pace ?? 1 },
    rng,
    aiRng: new Rng(`${cfg.seed}:ai`),
    dec: newDecState(cfg.providers),
    ai: undefined as unknown as World['ai'],
    paStage: 0,
    prep: { alignmentDone: false, pickoffDone: false, pitch: null, stealsDone: false, readyBy: 0, steal: null },
    swingObs: null,
    swingDecided: false,
    buntNow: null,
    align: {},
    env,
    tick: 0,
    acc: 0,
    phase: 'pregame',
    phaseUntil: 0,
    teams: { home, away },
    battingTeam: away,
    fieldingTeam: home,
    inning: 1,
    half: 'top',
    outs: 0,
    count: { balls: 0, strikes: 0 },
    batter: null,
    batStance: 'R',
    zone: strikeZoneFor(1.85),
    pitcher: home.pitcher,
    catcher: home.defense.get('C')!,
    runners: [],
    exiting: [],
    leavers: [],
    ret: null,
    hornKind: null,
    ball: {
      body: ballBody,
      mode: 'held',
      holder: home.pitcher,
      flags: { bounced: false, bounceSpeed: 0, surface: 'grass', wallHit: false, wallSpeed: 0, overFence: false },
      throwTo: null,
      throwBase: null,
      thrower: null,
      throwTarget: null,
      lob: null,
      path: [],
      pathStart: 0,
      pathDirty: true,
      lastTouch: null,
      touchedGround: false,
      touchedWall: false,
      lastBounceTick: 0,
    },
    play: null,
    pitch: null,
    pitchTick: 0,
    pitchAim: null,
    pitchCrossed: false,
    pitchInZone: false,
    swingPlan: null,
    swing: null,
    swingStarted: false,
    swingContact: false,
    swingEnd: 0,
    catcherHandled: false,
    stealing: new Set(),
    pitchClock: 0,
    lastCall: null,
    lastPlay: '',
    gameOver: false,
    winner: null,
    events: [],
    listeners: new Map(),
    seq: { lastType: null, lastMph: 0, count: 0 },
    fbMphSeen: 92,
    umpBias: { width: 0, low: 0, high: 0, noise: 0.02 },
    pendingPitchingChange: null,
    inningRuns: 0,
    paPitches: 0,
    paDone: false,
    tsTickPlayOver: 0,
    pendingAdvance: [],
    halfStartTick: 0,
    umpires: [
      { id: 'ump-hp', name: 'Home Plate Umpire', position: 'HP', x: 0.25, z: -2.6 },
      { id: 'ump-1b', name: 'First Base Umpire', position: '1B-U', x: -24.5, z: 24.0 },
      { id: 'ump-2b', name: 'Second Base Umpire', position: '2B-U', x: 6, z: 42.0 },
      { id: 'ump-3b', name: 'Third Base Umpire', position: '3B-U', x: 24.5, z: 24.0 },
    ],
    ballInPlayEver: false,
    jitter: 0,
    passedBallFlag: false,
    batterKeepsPA: false,
    foulReset: false,
    wildPitchFlag: false,
    walkOffPending: false,
    buntPlan: null,
  };
  // umpire zone tendencies for this game (physical noise: some umps squeeze, some expand)
  w.umpBias = { width: rng.normal(0, 0.012), low: rng.normal(0, 0.02), high: rng.normal(0, 0.02), noise: 0.018 + Math.abs(rng.normal(0, 0.004)) };
  w.ai = createAI(w);
  return w;
}

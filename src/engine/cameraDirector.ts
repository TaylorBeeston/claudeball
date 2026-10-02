/**
 * Broadcast camera director. Decisions come only from sim events and state:
 *  pitch  – classic center-field camera, telephoto, shallow depth of field
 *  follow – high-home camera panning with the ball in flight, zooming out to keep it framed
 *  fielder– telephoto on whoever fields / catches the ball
 *  base   – low camera near the base a throw is heading to
 *  replay – last play from a second angle in slow motion (from recorded sim history)
 *  cutaway– crowd / dugout / wide stadium shots between half-innings
 *  action – high-home camera framing the ball, the fielder / throw target and every runner in motion
 *  hrwall / trot / homeplate – home-run sequence: ball leaving over the wall, crowd reaction, batter tracked leg by leg around
 *                the bases, celebration at the plate, then a slow-motion replay from a second angle
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BASES, toScene } from './dims';
import { isFielderRole } from './roles';
import { availableKinds, computeRig, DEFAULT_BULLPENS, planNext, type BrollKind, type BrollRig, type BrollShot, type Landmarks } from './broll';
import { apertureFor, RackFocus, slabFor } from './autofocus';
import { interpolateState, type SimDriver, type TimedEvent } from './simAdapter';
import type { GameEvent, GameState, PlayerSnap } from './types';
import type { Stadium } from './stadium';

export type ShotName = 'pitch' | 'follow' | 'fielder' | 'base' | 'replay' | 'cutaway' | 'wide' | 'action' | 'hrwall' | 'trot' | 'homeplate' | 'umpire' | 'coach' | 'toss' | 'broll';

interface Desired {
  pos: Vector3;
  tgt: Vector3;
  fov: number;
  focus: number;
  aperture: number;
  lp: number; // position follow rate
  lt: number; // target follow rate
  lf: number; // fov follow rate
}

interface Replay {
  frames: GameState[];
  t: number;
  end: number;
  variant: 'infield' | 'outfield' | 'hr' | 'close';
  until: number;
  cam: Vector3 | null;
  /** playback speed (1 = real time) */
  speed: number;
  /** on-screen caption (default REPLAY) */
  caption: string | null;
  /** where a close play happened (scene) */
  focus?: Vector3;
  /** replay that follows this one (the normal-speed second angle) */
  next?: Replay | null;
}

const HOME_HIGH = new Vector3(0, 17, -26);
const CF_CAM = new Vector3(-2.6, 10.5, 121);

export interface DirectorOutput {
  renderState: GameState;
  focus: number;
  aperture: number;
  label: string | null;
  shot: ShotName;
  /** true on the frame a hard cut happened */
  cut: boolean;
  replaying: boolean;
  /** playback speed of the replay being shown (animation time scale) */
  replaySpeed: number;
  /** > 0 on the frame of a cut that should melt in from the previous picture: seconds the dissolve lasts */
  dissolve: number;
  /** the last picture should be kept (a dissolve may be asked for soon) */
  capture: boolean;
}

export class CameraDirector {
  auto = true;
  /** [3B side (+X), 1B side (−X)] camera/target pairs aimed at the real dugouts */
  dugoutShots: { pos: Vector3; target: Vector3 }[] = [];
  replaysEnabled = true;
  shot: ShotName = 'wide';
  private shotStart = 0;
  private clock = 0;
  private pos = new Vector3(0, 30, -50);
  private tgt = new Vector3(0, 2, 40);
  private fov = 35;
  private des: Desired;
  private ballSm = new Vector3();
  private focusTarget = new Vector3();
  private fielderId: string | null = null;
  private baseTarget = new Vector3();
  private orbit: OrbitControls;
  private inPlay = false;
  private playStart = 0;
  private playEnd = 0;
  private holdUntil = 0;
  private pendingReplay = false;
  private ballFar = 0;
  private cutawayIdx = 0;
  private cutawayUntil = 0;
  private cutaway: 'crowd' | 'wide' | 'dugout' | 'ondeck' = 'wide';
  /** side-cast shots (a coach sending a runner, a ball kid's toss to the stands) */
  private crewUntil = 0;
  private crewId: string | null = null;
  private crewRunner: string | null = null;
  private lastCoachCut = -99;
  private tossFan = new Vector3();
  private kidTossing = false;
  private lastOnDeckCut = -99;
  /** the interesting play waiting for a lull to be shown again (with the REPLAY tag) */
  private deferred: { t0: number; t1: number; variant: 'infield' | 'outfield' | 'hr'; cam: Vector3 | null; at: number } | null = null;
  private playScore = 0;
  private playOuts = 0;
  /** B-roll planner state */
  readonly landmarks: Landmarks;
  brollEnabled = true;
  /** hold the current B-roll shot (screenshots / tests) */
  brollLock = false;
  private broll: { shot: BrollShot; start: number } | null = null;
  private brollRig: BrollRig | null = null;
  private brollRecent: { kind: BrollKind; subject?: string }[] = [];
  private brollSeq = 0;
  private shownThisLull = 0;
  private lullTrack: { kind: string; first: number; mode: 'total' | 'remaining'; simStart: number; clockStart: number; inferred: boolean } | null = null;
  private breakUntil = 0;
  private reaction: { team: number; at: number } | null = null;
  private beat: { kind: BrollKind; until: number } | null = null;
  private dissolveReq = 0;
  private wantCapture = false;
  /** the lull the game is in right now (null: none), for tests and the HUD */
  lullInfo: { kind: string; remaining: number } | null = null;
  private onDeckPending = -99;
  private replay: Replay | null = null;
  /** a contested play (close play / tag) waiting for its slow-motion replay */
  private close: { simT: number; base: number | null; pos: Vector3; umpireId?: string } | null = null;
  private umpireUntil = 0;
  private rack = new RackFocus(0.22, 6);
  private focusSubject = new Vector3();
  private lastEventText = '';
  private lastCutFrame = false;
  private events: TimedEvent[] = [];
  private shotSeq = 0;
  private lastWindup = -99;
  private throwClock = -99;
  private crowdPick = -1;
  private actionQuiet = 0;
  private legIdx = -1;
  private legSince = 0;
  /** home-run sequence state (null when there is none) */
  private hr: { batterId: string; stage: 'wall' | 'crowd' | 'trot' | 'home' | 'replay'; t: number; contactSimT: number; simT: number; pos: Vector3; dir: Vector3; side: number; still: number; homeSince: number; robbed: boolean } | null = null;

  constructor(
    private camera: PerspectiveCamera,
    private sim: SimDriver,
    dom: HTMLElement,
    private stadium: Stadium,
  ) {
    this.des = { pos: this.pos.clone(), tgt: this.tgt.clone(), fov: 35, focus: 60, aperture: 0, lp: 3, lt: 3, lf: 3 };
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enabled = false;
    this.orbit.target.set(0, 2, 30);
    this.orbit.maxDistance = 400;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    sim.on((e) => this.events.push(e));
    this.landmarks = { crowdShots: stadium.crowdShots, dugoutShots: this.dugoutShots, scoreboard: null, bullpens: DEFAULT_BULLPENS };
  }

  setAuto(auto: boolean) {
    this.auto = auto;
    this.orbit.enabled = !auto;
    if (!auto) this.sim.hold = false;
    if (!auto) {
      // free orbit starts from a clear vantage point above the first-base side of the infield
      this.orbit.target.set(0, 1, 32);
      this.camera.position.set(-38, 34, 4);
      this.camera.fov = 45;
      this.camera.near = 0.5;
      this.camera.far = 900;
      this.camera.updateProjectionMatrix();
      this.orbit.update();
    } else this.cut('pitch');
  }

  private cut(s: ShotName) {
    if (s === 'trot') {
      this.legIdx = -1;
      this.legSince = this.clock;
    }
    this.shot = s;
    this.sim.hold = s === 'replay'; // the live game waits while a replay plays
    this.shotStart = this.clock;
    this.lastCutFrame = true;
    this.shotSeq++;
  }

  private handleEvent(te: TimedEvent, live: GameState) {
    const e = te.event;
    if (this.sim.skipping) return;
    switch (e.type) {
      case 'pitch':
        this.hr = null;
        this.replay = null;
        this.inPlay = false;
        this.pendingReplay = false;
        this.cut('pitch');
        break;
      case 'contact':
        this.playScore = e.exitVelo >= 45 ? 1 : 0; // 100 mph and up
        this.playOuts = 0;
        this.hr = null;
        this.inPlay = true;
        this.playStart = te.simTime;
        this.ballFar = 0;
        this.fielderId = null;
        this.cut('follow');
        this.holdUntil = 0;
        break;
      case 'catch':
        if (this.inPlay && !this.hr) {
          const p = live.players.find((q) => q.id === e.playerId);
          if (this.shot === 'base' || (this.shot === 'fielder' && this.clock - this.shotStart < 0.7)) break;
          // catch at a base after a throw => base shot; otherwise fielder shot
          this.fielderId = e.playerId;
          if (p && this.thrown) {
            this.cut('base');
            this.holdUntil = this.clock + 2.4;
          } else {
            this.cut('fielder');
            this.holdUntil = this.clock + 1.5;
          }
        }
        break;
      case 'throw': {
        if (this.hr) break;
        this.thrown = true;
        this.throwClock = this.clock;
        const t = toScene(e.target);
        this.baseTarget.copy(t);
        this.cut('base');
        this.holdUntil = this.clock + 3.2;
        break;
      }
      case 'foul':
        this.holdUntil = this.clock + 1.6;
        break;
      case 'signs_given':
        this.beat = { kind: 'catcherSigns', until: this.clock + 1.2 };
        break;
      case 'shake_off':
        this.beat = { kind: 'shakeOff', until: this.clock + 1.2 };
        break;
      case 'time_called':
        this.beat = { kind: 'batterFace', until: this.clock + 1.2 };
        break;
      case 'on_deck':
        // the next hitter got up in the dugout: the cutaway waits until he is loose at his circle (see update)
        this.onDeckPending = this.clock;
        break;
      case 'coach_signal':
        // the third-base coach waving a runner home during a play
        if (e.signal === 'go' && e.base === 3 && this.inPlay && !this.hr && this.shot !== 'replay' && this.clock - this.lastCoachCut > 25 && live.players.some((q) => q.id === e.coachId)) {
          this.crewId = e.coachId;
          this.crewRunner = e.runnerId ?? null;
          this.lastCoachCut = this.clock;
          this.crewUntil = this.clock + 2.4;
          this.cut('coach');
        }
        break;
      case 'ball_tossed_to_fan':
        this.tossFan.copy(toScene(e.pos, new Vector3()));
        break;
      case 'homerun': {
        // the ball just cleared the fence: show it leaving, then the crowd, then the trot (see updateHr)
        const b = live.ball.pos;
        const fence = e.pos ?? b;
        const pos = toScene(fence, new Vector3());
        const dir = new Vector3(pos.x, 0, pos.z);
        if (dir.lengthSq() < 1) dir.set(0, 0, 1);
        dir.normalize();
        this.hr = { batterId: e.batterId, stage: 'wall', t: this.clock, contactSimT: this.playStart, simT: te.simTime, pos, dir, side: dir.x >= 0 ? -1 : 1, still: 0, homeSince: -1, robbed: false };
        this.inPlay = true;
        this.pendingReplay = false;
        this.holdUntil = 0;
        this.ballSm.copy(pos);
        this.cut('hrwall');
        break;
      }
      case 'robbed_hr': {
        // a fielder took the home run away: him at the wall, the crowd's reaction, then the play again from a second angle
        const pos = toScene(e.pos ?? live.ball.pos, new Vector3());
        const dir = new Vector3(pos.x, 0, pos.z);
        if (dir.lengthSq() < 1) dir.set(0, 0, 1);
        dir.normalize();
        this.hr = { batterId: e.batterId, stage: 'wall', t: this.clock, contactSimT: this.playStart, simT: te.simTime, pos, dir, side: dir.x >= 0 ? -1 : 1, still: 0, homeSince: -1, robbed: true };
        this.inPlay = true;
        this.pendingReplay = false;
        this.holdUntil = 0;
        this.fielderId = e.playerId;
        if (this.shot !== 'fielder') this.cut('fielder');
        break;
      }
      case 'wall_leap':
        this.playScore += 2;
        if (this.inPlay && !this.hr) {
          this.fielderId = e.playerId;
          this.cut('fielder');
          this.holdUntil = this.clock + 2.4;
        }
        break;
      case 'tag':
        // a play at a base: a low camera at the bag while the tag goes in
        if (this.inPlay && !this.hr && e.result !== 'avoided') {
          const t = e.pos ? toScene(e.pos, new Vector3()) : e.base ? new Vector3(BASES[Math.min(3, e.base) - 1]?.x ?? 0, 0, BASES[Math.min(3, e.base) - 1]?.z ?? 0) : null;
          if (t) {
            this.baseTarget.copy(t);
            if (this.shot !== 'base') this.cut('base');
            this.holdUntil = this.clock + 2.6;
          }
        }
        break;
      case 'safe':
        if (!this.hr) this.noteClosePlay(e, te.simTime, live); // also plays with no batted ball (steals, pickoffs)
        break;
      case 'out':
      case 'run':
        if (e.type === 'run') this.playScore += 1;
        if (e.type === 'out' && ++this.playOuts >= 2) this.playScore += 2; // a double play
        if (e.type === 'run') this.reaction = { team: live.half === 'top' ? 0 : 1, at: this.clock };
        if (e.type === 'out' && !this.hr) this.noteClosePlay(e, te.simTime, live);
        this.holdUntil = Math.max(this.holdUntil, this.clock + 2.2);
        this.playEnd = te.simTime;
        if (this.inPlay && !this.hr) this.pendingReplay = true;
        break;
      case 'half_inning':
        this.hr = null;
        this.crowdPick = -1;
        this.inPlay = false;
        this.shownThisLull = 0;
        if (this.brollEnabled && !this.sim.skipping) {
          // the break between half-innings is B-roll time; the sim's phase / lull says how long, a mock sim gets a fixed break
          if (live.phase === undefined && live.lull === undefined) this.breakUntil = this.clock + 7;
          this.cut('pitch');
        } else {
          this.cutawayIdx = (this.cutawayIdx + 1) % 3;
          this.cutaway = (['crowd', 'dugout', 'wide'] as const)[this.cutawayIdx];
          this.cutawayUntil = this.clock + 5.5;
          this.cut('cutaway');
        }
        break;
      case 'game_end':
        this.cut('wide');
        this.holdUntil = this.clock + 999;
        break;
    }
  }
  private thrown = false;

  update(dt: number, live: GameState, ball: Vector3, players: Map<string, Vector3>): DirectorOutput {
    this.clock += dt;
    this.lastCutFrame = false;
    for (const te of this.events.splice(0)) {
      if (te.event.type === 'contact') this.thrown = false;
      this.handleEvent(te, live);
    }
    // windup marks the start of the next pitch: leave hold / cutaway states
    const pit = live.players.find((p) => p.role === 'pitcher');
    if (pit?.anim === 'windup' && live.time - this.lastWindup > 2) {
      this.lastWindup = live.time;
      if (this.hr && this.hr.stage === 'home') this.hrReplayOrEnd(live); // next batter is up: replay now rather than never
      const hrBusy = this.hr && this.hr.stage !== 'home' && this.hr.stage !== 'replay';
      if (this.shot !== 'pitch' && this.shot !== 'replay' && this.shot !== 'wide' && !(this.shot === 'coach' && this.clock < this.crewUntil) && !hrBusy && !(this.hr && this.hr.stage === 'replay')) {
        this.inPlay = false;
        this.hr = null;
        this.cut('pitch');
      }
    }
    this.updateBroll(live, pit);
    // a ball kid starts to toss a foul ball to the stands while the game is waiting: show it (a pitch coming ends the shot at its windup)
    const kidToss = live.players.find((p) => p.role === 'ballkid' && p.anim === 'ballkid_toss');
    if (kidToss && !this.kidTossing && !this.hr && !this.inPlay && this.shot !== 'replay' && this.shot !== 'cutaway' && !this.sim.skipping && pit?.anim !== 'windup' && pit?.anim !== 'pitch') {
      this.crewId = kidToss.id;
      this.crewUntil = this.clock + 3.2;
      this.cut('toss');
    }
    this.kidTossing = !!kidToss;
    if (!this.brollEnabled && this.clock - this.onDeckPending < 40 && !this.inPlay && !this.hr && this.shot === 'pitch' && !this.sim.hold && !this.sim.skipping && pit?.anim === 'idle' && this.clock - this.lastOnDeckCut > 40) {
      const od = live.players.find((q) => q.role === 'ondeck');
      // loose at the circle: at field level, standing, a few metres up the line
      if (od && od.pos.y > -0.2 && Math.hypot(od.vel.x, od.vel.z) < 0.3 && Math.abs(od.pos.x) > 6 && Math.abs(od.pos.x) < 14 && od.pos.z < 4) {
        this.onDeckPending = -99;
        this.lastOnDeckCut = this.clock;
        this.cutaway = 'ondeck';
        this.cutawayUntil = this.clock + 3.4;
        this.cut('cutaway');
      }
    }
    if (pit?.anim !== 'windup' && pit?.anim !== 'pitch') this.lastWindup = Math.min(this.lastWindup, live.time - 3);

    let rs = live;
    let label: string | null = null;
    if (!this.auto) {
      this.orbit.update();
      this.tgt.copy(this.orbit.target);
      this.pos.copy(this.camera.position);
      return { renderState: live, focus: this.pos.distanceTo(this.tgt), aperture: 0, label: null, shot: this.shot, cut: false, replaying: false, replaySpeed: 1, dissolve: 0, capture: false };
    }

    // ---- transitions driven by state -----------------------------------------------------
    if (this.hr) this.updateHr(live, dt);
    else if (this.inPlay) {
      const b = live.ball;
      this.ballFar = Math.max(this.ballFar, Math.hypot(b.pos.x, b.pos.z));
      const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
      const running = this.runnersInMotion(live).length > 0;
      if (this.shot === 'follow') {
        const settled = b.pos.y < 0.6 && speed < 6;
        const heldByPlayer = live.players.some((p) => Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z) < 0.7 && b.pos.y > 0.8 && speed < 1);
        if ((settled || heldByPlayer) && this.clock - this.shotStart > 1.0) {
          this.fielderId = this.nearestFielder(live);
          // runners on the move: frame the whole play rather than one fielder
          if (running) this.enterAction();
          else if (this.fielderId) this.cut('fielder');
          this.holdUntil = this.clock + 1.6;
        }
      }
      if (this.holdUntil && this.clock > this.holdUntil && (this.shot === 'base' || this.shot === 'fielder')) {
        this.holdUntil = 0;
        if (running) this.enterAction();
        else this.endPlay(live);
      }
      if (this.shot === 'follow' && this.clock - this.shotStart > 9) {
        if (running) this.enterAction();
        else {
          this.inPlay = false;
          this.cut('pitch');
        }
      }
      if (this.shot === 'action') {
        // stay with the play while anybody is running; leave once it is quiet (or after a long time)
        this.actionQuiet = running || this.thrown && this.clock - this.throwClock < 2.5 ? 0 : this.actionQuiet + dt;
        if (this.actionQuiet > 1.4 || this.clock - this.shotStart > 26) this.endPlay(live);
      }
    }
    if (this.shot === 'umpire' && this.clock > this.umpireUntil) this.endPlay(live);
    if ((this.shot === 'coach' || this.shot === 'toss') && this.clock > this.crewUntil) {
      if (this.shot === 'coach' && this.inPlay) this.enterAction();
      else this.cut('pitch');
    }
    if (this.shot === 'cutaway' && this.clock > this.cutawayUntil) this.cut('pitch');
    if (this.shot === 'wide' && this.clock - this.shotStart > 8 && !live.over) this.cut('pitch');

    // ---- replay playback ---------------------------------------------------------------------
    if (this.shot === 'replay' && this.replay) {
      const r = this.replay;
      r.t += dt * r.speed * 60; // frames at 60 Hz
      if (r.t >= r.end - 1 && r.next) {
        // slow-motion close play finished: the normal-speed replay from the second angle follows
        this.replay = r.next;
        this.ballSm.copy(r.next.focus ?? this.ballSm);
        this.lastCutFrame = true;
      } else if (r.t >= r.end - 1) {
        this.replay = null;
        this.inPlay = false;
        this.hr = null;
        this.pendingReplay = false;
        this.cut('pitch');
      } else {
        const i = Math.floor(r.t);
        rs = interpolateState(r.frames[i], r.frames[i + 1], r.t - i);
        label = r.caption ?? 'REPLAY';
      }
    }

    this.computeDesired(rs, live, dt, players);
    this.applySmoothing(dt);
    const af = this.autofocus(rs, live, dt);
    void ball;
    const dissolve = this.lastCutFrame ? this.dissolveReq : 0;
    this.dissolveReq = 0;
    return { renderState: rs, focus: af.focus, aperture: af.aperture, label, shot: this.shot, cut: this.lastCutFrame, replaying: !!label && this.shot === 'replay', replaySpeed: this.shot === 'replay' && this.replay ? this.replay.speed : 1, dissolve, capture: this.wantCapture };
  }

  /** The non-pitch time the game is in, with how many real seconds of it are left (null when pitching is about to happen / going on). */
  private lullNow(live: GameState): { kind: string; remaining: number } | null {
    let l: { kind: string; sec: number } | null = live.lull && typeof live.lull === 'object' && live.lull.kind ? live.lull : null;
    let inferred = false;
    if (!l && (live.phase === 'halfInningBreak' || live.phase === 'halfBreak')) {
      l = { kind: 'break', sec: 0 };
      inferred = true;
    }
    if (!l && this.breakUntil > this.clock) {
      l = { kind: 'break', sec: 0 };
      inferred = true;
    }
    if (!l) {
      this.lullTrack = null;
      return null;
    }
    let tr = this.lullTrack;
    if (!tr || tr.kind !== l.kind) tr = this.lullTrack = { kind: l.kind, first: l.sec, mode: 'total', simStart: live.time, clockStart: this.clock, inferred };
    let remaining: number;
    if (inferred) remaining = this.breakUntil > this.clock ? this.breakUntil - this.clock : 6; // the phase ends the break: always room for one more shot
    else {
      if (l.sec < tr.first - 0.5) tr.mode = 'remaining';
      remaining = tr.mode === 'remaining' ? l.sec : tr.first - (live.time - tr.simStart);
      remaining /= Math.max(1, this.sim.speed); // sim seconds -> real seconds when the game runs fast
    }
    return { kind: l.kind, remaining };
  }

  private brollSubjectsKey = 0;

  /** Plan and fly B-roll while the game is in a lull; get back to the pitch camera before the delivery. */
  private updateBroll(live: GameState, pit: PlayerSnap | undefined) {
    if (this.brollLock && this.shot === 'broll') return;
    const lull = this.brollEnabled && this.auto ? this.lullNow(live) : null;
    this.lullInfo = lull;
    this.wantCapture = !!lull || this.shot === 'broll';
    if (!lull) this.shownThisLull = 0;
    const calm = !this.hr && !this.inPlay && !this.close && !this.replay && !this.sim.skipping && !live.over && pit?.anim !== 'windup' && pit?.anim !== 'pitch';
    if (this.shot === 'broll') {
      if (!lull || !calm) return this.endBroll();
      const cur = this.broll!;
      const el = this.clock - cur.start;
      const beat = this.beat && this.beat.until > this.clock && el >= 2.5;
      if (el >= cur.shot.hold || lull.remaining < 0.8 || beat) {
        const next = this.planBroll(live, lull);
        if (next) this.startBroll(next);
        else this.endBroll();
      }
      return;
    }
    if (!lull || !calm || this.shot !== 'pitch' || this.clock - this.shotStart < 0.7) return;
    const dr = this.deferred;
    if (dr && this.clock - dr.at > 12) {
      if (this.clock - dr.at > 150 || !this.replaysEnabled) this.deferred = null;
      else if (this.sim.speed <= 1.01 && (lull.kind === 'break' || lull.kind === 'walkup' || lull.kind === 'review' || lull.kind === 'pitchingChange') && lull.remaining >= (lull.kind === 'break' ? 3 : 8)) {
        if (this.startDeferredReplay()) return;
      }
    }
    const next = this.planBroll(live, lull);
    if (next) this.startBroll(next);
  }

  private planBroll(live: GameState, lull: { kind: string; remaining: number }): BrollShot | null {
    const reaction = this.reaction && this.clock - this.reaction.at < 14 ? this.reaction : null;
    const { available, subjects } = availableKinds(live, this.landmarks, { reaction: !!reaction });
    const beat = this.beat && this.beat.until > this.clock && available.has(this.beat.kind) ? this.beat.kind : null;
    const cur = this.broll && this.shot === 'broll' ? this.broll.shot.kind : null;
    if (beat && beat !== cur && lull.remaining - 0.8 >= 2.5) {
      this.beat = null;
      const shot: BrollShot = { kind: beat, subject: subjects[beat], variant: this.brollSeq * 97 + 11, hold: Math.min(3.2, lull.remaining - 0.8), transition: 'cut' };
      return shot;
    }
    const seed = ++this.brollSeq * 1013 + Math.floor(live.time * 10);
    const shot = planNext({
      lull: { kind: lull.kind as never, remaining: lull.remaining },
      available,
      subjects,
      recent: this.brollRecent,
      seed,
      reactionTeam: reaction ? reaction.team : null,
      shownThisLull: this.shownThisLull,
    });
    if (shot && shot.kind === 'dugoutReaction') this.reaction = null;
    return shot;
  }

  private startBroll(shot: BrollShot) {
    this.broll = { shot, start: this.clock };
    this.brollRecent.push({ kind: shot.kind, subject: shot.subject });
    if (this.brollRecent.length > 12) this.brollRecent.shift();
    this.shownThisLull++;
    if (shot.transition === 'dissolve') this.dissolveReq = 0.6;
    this.cut('broll');
  }

  private endBroll() {
    const was = this.broll?.shot;
    this.broll = null;
    if (this.shot !== 'broll') return;
    if (was?.transition === 'dissolve') this.dissolveReq = 0.45;
    this.cut('pitch');
  }

  /** Runners / the batter-runner that are actually moving (ball in play). */
  private runnersInMotion(s: GameState): PlayerSnap[] {
    return s.players.filter(
      (p) => (p.role === 'runner' || p.role === 'batter') && p.team >= 0 && Math.hypot(p.vel.x, p.vel.z) > 1.5 && (p.anim === 'run' || p.anim === 'trot' || p.anim === 'run_turn' || p.anim === 'slide'),
    );
  }

  private enterAction() {
    if (this.shot === 'action') return;
    this.actionQuiet = 0;
    this.cut('action');
  }

  /** The play is over: replay it if that was wanted and possible, otherwise back to the pitcher. */
  private endPlay(live: GameState) {
    this.noteDeferred(false);
    const okToReplay = this.replaysEnabled && this.sim.speed <= 1.01 && !this.sim.skipping;
    if (okToReplay && this.close && this.startCloseReplay(live)) {
      this.close = null;
      this.cut('replay');
      return;
    }
    this.close = null;
    const canReplay = okToReplay && this.pendingReplay && this.startReplay(live);
    if (canReplay) this.cut('replay');
    else {
      this.inPlay = false;
      this.cut('pitch');
    }
  }

  /** Home-run sequence: wall (ball leaving) → crowd → trot around the bases → celebration at the plate → replay. */
  private updateHr(live: GameState, dt: number) {
    const h = this.hr!;
    const st = this.clock - h.t;
    const next = (stage: NonNullable<typeof this.hr>['stage'], shot: ShotName) => {
      h.stage = stage;
      h.t = this.clock;
      h.still = 0;
      this.cut(shot);
    };
    const runner = live.players.find((p) => p.id === h.batterId);
    switch (h.stage) {
      case 'wall':
        if (st > (h.robbed ? 2.6 : 2.2)) {
          const cs = this.stadium.crowdShots;
          if (cs.length) {
            // the crowd section nearest to where the ball left the park
            let best = 0, bd = 1e9;
            cs.forEach((c, i) => {
              const d = Math.hypot(c.pos.x - h.pos.x, c.pos.z - h.pos.z);
              if (d < bd) { bd = d; best = i; }
            });
            this.crowdPick = best;
            this.cutaway = 'crowd';
            this.cutawayUntil = Infinity;
            next('crowd', 'cutaway');
          } else if (h.robbed) this.hrReplayOrEnd(live);
          else next('trot', 'trot');
        }
        break;
      case 'crowd':
        if (st > 2.8) {
          if (h.robbed) this.hrReplayOrEnd(live);
          else next('trot', 'trot');
        }
        break;
      case 'trot': {
        const nearHome = !!runner && Math.hypot(runner.pos.x, runner.pos.z) < 9 && runner.pos.z < 12 && this.clock - this.shotStart > 3;
        if (nearHome || !runner || st > 60) next('home', 'homeplate');
        break;
      }
      case 'home': {
        // hold on the plate for the celebration (from when he arrives), then replay the homer
        const arrived = !runner || runner.anim === 'celebrate' || Math.hypot(runner.pos.x, runner.pos.z) < 1.8;
        if (arrived && h.homeSince < 0) h.homeSince = this.clock;
        if ((h.homeSince >= 0 && this.clock - h.homeSince > 2.4) || st > 9) this.hrReplayOrEnd(live);
        break;
      }
      case 'replay':
        break;
    }
  }

  /** End of a home-run / robbed-home-run sequence: replay it (the live game waits) or go back to the pitcher. */
  private hrReplayOrEnd(live: GameState) {
    const h = this.hr;
    if (!h) return;
    this.pendingReplay = true;
    this.noteDeferred(true);
    if (this.replaysEnabled && this.sim.speed <= 1.01 && !this.sim.skipping && this.startReplay(live, true)) {
      h.stage = 'replay';
      h.t = this.clock;
      this.cut('replay');
    } else {
      this.hr = null;
      this.inPlay = false;
      this.cut('pitch');
    }
  }

  /** A contested out / safe call (`closePlay` or a margin under a tenth of a second): the umpire live, then the slow-motion replay. */
  private noteClosePlay(e: Extract<GameEvent, { type: 'out' | 'safe' }>, simT: number, live: GameState) {
    // slow motion only when the sim calls it a close play (|margin| < 0.10 s)
    const closeCall = e.closePlay === true;
    if (!closeCall) return;
    const base = (e.type === 'safe' ? e.base : e.base) ?? null;
    const b = base && base >= 1 && base <= 3 ? BASES[base - 1] : { x: 0, z: 0 };
    this.close = { simT, base, pos: new Vector3(b.x, 0, b.z) };
    this.pendingReplay = true;
    this.playScore += 2;
    // cut to the umpire making the call, briefly, live
    this.umpireUntil = this.clock + 1.7;
    this.holdUntil = this.clock + 4;
    if (this.replaysEnabled) this.cut('umpire');
    void live;
  }

  /** Slow-motion replay of a close play from a low camera at the base, then a normal-speed replay from the opposite side. */
  private startCloseReplay(live: GameState): boolean {
    const c = this.close;
    if (!c) return false;
    const hist = this.sim.history;
    const t0 = c.simT - 1.3, t1 = c.simT + 0.9; // from the throw / the run into the bag to just after the call
    const i0 = hist.findIndex((s) => s.time >= t0);
    if (i0 < 0) return false;
    let i1 = hist.length - 1;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].time <= t1) { i1 = i; break; }
    if (i1 - i0 < 40) return false;
    const frames = hist.slice(i0, i1 + 1);
    const centre = new Vector3(0, 0, 19.4);
    const out = c.pos.clone().sub(centre).setY(0);
    if (out.lengthSq() < 1) out.set(0, 0, -1);
    out.normalize();
    const side = new Vector3(-out.z, 0, out.x);
    const cam1 = c.pos.clone().addScaledVector(out, 6.5).addScaledVector(side, 5.5).setY(1.25);
    const cam2 = c.pos.clone().addScaledVector(out, 9).addScaledVector(side, -9).setY(3.2);
    const focus = c.pos.clone().setY(0.9);
    const second: Replay = { frames, t: 0, end: frames.length, variant: 'close', until: 0, cam: cam2, speed: 0.5, caption: null, focus };
    this.replay = { frames, t: 0, end: frames.length, variant: 'close', until: 0, cam: cam1, speed: 0.3, caption: 'CLOSE PLAY', focus, next: second };
    this.ballSm.copy(focus);
    void live;
    return true;
  }

  /**
   * The camera operator's focus: the subject depends on the shot (the plate region before a pitch, the ball in flight once it is thrown,
   * the ball on the follow cam, the fielder on his cam, ...), the focus distance is racked to it smoothly (and snaps on a cut), and the
   * aperture is whatever keeps a slab of `slabFor(shot)` metres around the subject sharp. Wide shots stay in deep focus.
   */
  private autofocus(rs: GameState, live: GameState, dt: number): { focus: number; aperture: number } {
    const subj = this.focusSubject;
    switch (this.shot) {
      case 'pitch': {
        // before release the strike zone region (batter + catcher), while the pitch is in flight the ball, so the pitch is seen sharp all the way in
        const b = rs.ball;
        const flying = b.visible && b.vel.z < -8 && b.pos.z > 0.3 && b.pos.z < 19.5;
        if (flying) subj.set(b.pos.x, b.pos.y, Math.max(0, b.pos.z));
        else {
          const batter = rs.players.find((p) => p.role === 'batter');
          subj.set((batter?.pos.x ?? 0) * 0.5, 1.0, 0);
        }
        break;
      }
      case 'follow':
        subj.copy(this.ballSm);
        break;
      default:
        subj.copy(this.focusTarget);
    }
    const dist = Math.max(1, subj.distanceTo(this.pos));
    const focus = this.lastCutFrame ? (this.rack.snap(dist), dist) : this.rack.step(dist, dt);
    const slab = this.shot === 'broll' && this.brollRig ? this.brollRig.slab : slabFor(this.shot, { ballHeight: live.ball.pos.y, cutaway: this.cutaway });
    // a shot that asks for a shallower look than its slab allows (des.aperture) keeps its own, never deeper focus than the slab needs
    const aperture = slab === 0 ? 0 : Math.min(apertureFor(focus, slab), Math.max(this.des.aperture, 0.0001) * 1.6 + 0.12);
    return { focus, aperture };
  }

  private nearestFielder(s: GameState): string | null {
    let best: string | null = null;
    let bd = 1e9;
    for (const p of s.players) {
      if (p.team < 0 || !isFielderRole(p.role)) continue;
      const d = Math.hypot(p.pos.x - s.ball.pos.x, p.pos.z - s.ball.pos.z);
      if (d < bd) {
        bd = d;
        best = p.id;
      }
    }
    return best;
  }

  /** Remember an interesting play (a home run, a wall catch, a double play, a hard hit that scored, a close call) to show again in a quiet moment. */
  private noteDeferred(homeRun: boolean) {
    if (!this.replaysEnabled) return;
    const h = this.hr;
    if (homeRun && h) {
      const mid = new Vector3(h.pos.x * 0.5, 0, h.pos.z * 0.5);
      const perp = new Vector3(h.dir.z, 0, -h.dir.x).multiplyScalar(-h.side);
      this.deferred = { t0: h.contactSimT - 0.8, t1: h.simT + 2.6, variant: 'hr', cam: mid.addScaledVector(perp, 46).setY(7.5), at: this.clock };
      return;
    }
    if (this.playScore < 2 || this.hr) return;
    this.deferred = { t0: this.playStart - 0.8, t1: Math.min(Math.max(this.playEnd, this.playStart + 2) + 0.6, this.playStart + 6.5), variant: this.ballFar > 55 ? 'outfield' : 'infield', cam: null, at: this.clock };
    this.playScore = 0;
  }

  /** The queued play, from the sim's history, in slow motion with the REPLAY tag (the live game waits). */
  private startDeferredReplay(): boolean {
    const d = this.deferred;
    this.deferred = null;
    const hist = this.sim.history;
    if (!d || hist.length < 30) return false;
    const i0 = hist.findIndex((st) => st.time >= d.t0);
    if (i0 < 0) return false;
    let i1 = hist.length - 1;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].time <= d.t1) { i1 = i; break; }
    if (i1 - i0 < 30) return false;
    const frames = hist.slice(i0, i1 + 1);
    this.replay = { frames, t: 0, end: frames.length, variant: d.variant, until: 0, cam: d.cam, speed: d.variant === 'hr' ? 0.5 : 0.6, caption: null };
    this.ballSm.copy(toScene(frames[0].ball.pos));
    this.cut('replay');
    return true;
  }

  private startReplay(live: GameState, homeRun = false): boolean {
    const hist = this.sim.history;
    if (hist.length < 30) return false;
    const h = this.hr;
    const t0 = (homeRun && h ? h.contactSimT : this.playStart) - 0.8;
    const t1 = homeRun && h ? h.simT + (h.robbed ? 1.6 : 2.6) : Math.min(Math.max(this.playEnd, this.playStart + 2) + 0.6, this.playStart + 6.5);
    let i0 = hist.findIndex((s) => s.time >= t0);
    if (i0 < 0) return false;
    let i1 = hist.length - 1;
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].time <= t1) { i1 = i; break; }
    if (i1 - i0 < 30) return false;
    const frames = hist.slice(i0, i1 + 1);
    let cam: Vector3 | null = null;
    if (homeRun && h) {
      // second angle: from across the field, low and wide of the flight line, looking at the ball all the way out
      const mid = new Vector3(h.pos.x * 0.5, 0, h.pos.z * 0.5);
      const perp = new Vector3(h.dir.z, 0, -h.dir.x).multiplyScalar(h.side);
      cam = mid.addScaledVector(perp, 46).setY(7.5);
    }
    this.replay = { frames, t: 0, end: frames.length, variant: homeRun ? 'hr' : this.ballFar > 55 ? 'outfield' : 'infield', until: 0, cam, speed: 0.5, caption: null };
    this.ballSm.copy(toScene(frames[0].ball.pos)); // the replay camera starts on the ball at contact, not where the live shot left it
    void live;
    return true;
  }

  private tele(width: number, dist: number) {
    return MathUtils.radToDeg(2 * Math.atan((width / this.camera.aspect / 2) / Math.max(dist, 1)));
  }

  private computeDesired(rs: GameState, live: GameState, dt: number, players: Map<string, Vector3>) {
    const d = this.des;
    const ball = toScene(rs.ball.pos, new Vector3());
    switch (this.shot) {
      case 'pitch': {
        d.pos.copy(CF_CAM);
        const batter = rs.players.find((p) => p.role === 'batter');
        const bx = batter ? batter.pos.x * 0.3 : 0;
        d.tgt.set(bx, 1.05, 8.2);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = this.tele(8.6, dist);
        d.focus = dist;
        d.aperture = 1.0;
        d.lp = d.lt = d.lf = 6;
        this.focusTarget.copy(d.tgt);
        // pitch in flight: subtle tilt/pan to hold the ball inside the frame
        if (rs.ball.visible && rs.ball.vel.z < -10) {
          d.tgt.x = MathUtils.lerp(d.tgt.x, ball.x * 0.35, 0.5);
        }
        break;
      }
      case 'follow': {
        d.pos.copy(HOME_HIGH);
        // lead the ball slightly; anticipate where it is going
        const lead = new Vector3(rs.ball.vel.x, rs.ball.vel.y * 0.2, rs.ball.vel.z).multiplyScalar(0.12);
        const want = ball.clone().add(lead);
        if (this.clock - this.shotStart < 0.05) this.ballSm.copy(want);
        this.ballSm.lerp(want, 1 - Math.exp(-dt * 6));
        // high balls: aim between the ball and the ground beneath it so the field stays in frame, then
        // widen the lens so the ball itself is still inside the picture
        const hi = MathUtils.clamp((this.ballSm.y - 6) / 55, 0, 0.62);
        d.tgt.set(this.ballSm.x, this.ballSm.y * (1 - hi), this.ballSm.z);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = MathUtils.clamp(this.tele(44 + dist * 0.25, dist), 7, 34);
        const vTo = (p: Vector3) => Math.atan2(p.y - d.pos.y, Math.hypot(p.x - d.pos.x, p.z - d.pos.z));
        const dv = Math.abs(vTo(this.ballSm) - vTo(d.tgt));
        d.fov = Math.max(d.fov, MathUtils.radToDeg(dv) * 2.6 + 6);
        d.focus = dist;
        d.aperture = 0.12;
        d.lp = 2; d.lt = 9; d.lf = 1.6;
        this.focusTarget.copy(this.ballSm);
        break;
      }
      case 'fielder': {
        const fp = (this.fielderId && players.get(this.fielderId)) || this.ballSm;
        const target = fp.clone().setY(1.1);
        const far = Math.hypot(target.x, target.z) > 42;
        if (far) d.pos.set(target.x * 0.25 - 4, 16, -26);
        else d.pos.set(target.x + Math.sign(target.x || 1) * -18, 3.2, target.z - 10);
        if (!far) {
          // stay on the foul-territory side of the field so the play faces camera
          d.pos.set(target.x >= 0 ? target.x + 22 : target.x - 22, 3.4, Math.max(target.z - 6, 4));
        }
        d.tgt.copy(target);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = this.tele(far ? 13 : 9.5, dist);
        d.focus = dist;
        d.aperture = 0.8;
        d.lp = 1.6; d.lt = 5; d.lf = 3;
        this.focusTarget.copy(target);
        break;
      }
      case 'base': {
        const t = this.baseTarget;
        const c = new Vector3(0, 0, 19.4);
        const out = t.clone().sub(c).setY(0);
        if (out.lengthSq() < 1) out.set(0, 0, 1);
        out.normalize();
        d.pos.set(t.x + out.x * 11 + out.z * 6, 2.4, t.z + out.z * 11 - out.x * 6);
        const follow = ball.clone().lerp(t, 0.55);
        d.tgt.copy(follow).setY(1.2);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = this.tele(20, dist);
        d.focus = dist;
        d.aperture = 0.6;
        d.lp = 3; d.lt = 4; d.lf = 3;
        this.focusTarget.copy(d.tgt);
        break;
      }
      case 'replay': {
        if (this.replay?.variant === 'close' && this.replay.cam && this.replay.focus) {
          // low at the base, looking at the play; a subtle push-in as the slow motion runs
          const r = this.replay;
          d.pos.copy(r.cam!);
          const f = r.focus!;
          this.ballSm.lerp(ball, 1 - Math.exp(-dt * 4));
          d.tgt.copy(f).lerp(this.ballSm, 0.35);
          const dist = d.pos.distanceTo(d.tgt);
          d.fov = this.tele(9.5, dist) * (1 - 0.2 * MathUtils.clamp(r.t / r.end, 0, 1));
          d.focus = dist;
          d.aperture = 0.5;
          d.lp = d.lt = 20; d.lf = 6;
          this.focusTarget.copy(d.tgt);
          break;
        }
        const inf = this.replay?.variant === 'infield';
        if (this.replay?.cam) d.pos.copy(this.replay.cam);
        else if (inf) d.pos.set(-40, 4.2, 30);
        else d.pos.set(40, 6.5, 44);
        const want = ball.clone();
        this.ballSm.lerp(want, 1 - Math.exp(-dt * 5));
        d.tgt.copy(this.ballSm);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = MathUtils.clamp(this.tele(26 + dist * 0.2, dist), 9, 40);
        d.focus = dist;
        d.aperture = 0.4;
        d.lp = 4; d.lt = 8; d.lf = 2;
        this.focusTarget.copy(this.ballSm);
        break;
      }
      case 'umpire': {
        // the umpire making the call on a close play: medium close-up from in front of him
        const c = this.close;
        let best: { pos: Vector3; facing: number } | null = null, bd = 1e9;
        for (const p of rs.players) {
          if (p.role !== 'umpire' || !c) continue;
          const pp = toScene(p.pos, new Vector3());
          const dd = pp.distanceTo(c.pos);
          if (dd < bd) { bd = dd; best = { pos: pp, facing: p.facing }; }
        }
        const u = best ?? { pos: c ? c.pos.clone() : new Vector3(0, 0, 0), facing: 0 };
        const fwd = new Vector3(Math.sin(u.facing), 0, Math.cos(u.facing));
        d.pos.copy(u.pos).addScaledVector(fwd, 6).addScaledVector(new Vector3(-fwd.z, 0, fwd.x), 1.2).setY(1.6);
        d.tgt.copy(u.pos).setY(1.4);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = this.tele(3.4, dist);
        d.focus = dist;
        d.aperture = 0.7;
        d.lp = d.lt = d.lf = 20;
        this.focusTarget.copy(d.tgt);
        break;
      }
      case 'broll': {
        if (!this.broll) break;
        this.brollRig = computeRig(this.broll.shot, { state: rs, lm: this.landmarks, t: this.clock - this.broll.start, aspect: this.camera.aspect, battingSide: rs.half === 'top' ? 0 : 1 }, this.brollRig ?? undefined);
        const r = this.brollRig;
        d.pos.copy(r.pos);
        d.tgt.copy(r.tgt);
        d.fov = r.fov;
        d.focus = d.pos.distanceTo(r.focus);
        d.aperture = r.slab > 0 ? 1 : 0;
        d.lp = r.lp; d.lt = r.lt; d.lf = r.lf;
        this.focusTarget.copy(r.focus);
        break;
      }
      case 'coach': {
        // the third-base coach windmilling, the runner coming at him: from behind the coach, the runner in the frame
        const coach = rs.players.find((p) => p.id === this.crewId);
        const run = this.crewRunner ? rs.players.find((p) => p.id === this.crewRunner) : null;
        const c = coach ? toScene(coach.pos, new Vector3()) : new Vector3(23.7, 0, 15.1);
        const r = run ? toScene(run.pos, new Vector3()) : new Vector3(0, 0, 38);
        const dir = r.clone().sub(c).setY(0);
        if (dir.lengthSq() < 0.01) dir.set(-1, 0, 0);
        dir.normalize();
        d.pos.copy(c).addScaledVector(dir, -5.5).addScaledVector(new Vector3(-dir.z, 0, dir.x), 1.4).setY(1.7);
        d.tgt.copy(c).lerp(r, 0.35).setY(1.3);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = this.tele(9, dist);
        d.focus = d.pos.distanceTo(c);
        d.aperture = 0.5;
        d.lp = d.lt = d.lf = 5;
        this.focusTarget.copy(c).setY(1.3);
        break;
      }
      case 'toss': {
        // a ball kid's toss into the stands: from the field side, the kid, the ball's arc and the fan in the frame
        const kid = rs.players.find((p) => p.id === this.crewId);
        const k = kid ? toScene(kid.pos, new Vector3()) : this.tossFan.clone().setY(0);
        const mid = k.clone().lerp(this.tossFan, 0.5);
        const side = new Vector3(-Math.sign(this.tossFan.x || 1), 0, 0.2).normalize();
        d.pos.copy(mid).addScaledVector(side, 13).setY(2.0);
        const bd = rs.deadBall && rs.deadBall.state === 'tossed' ? toScene(rs.deadBall.pos, new Vector3()) : null;
        d.tgt.copy(bd ?? mid).setY(Math.max(1.6, bd ? bd.y : 1.8));
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = this.tele(16, dist);
        d.focus = dist;
        d.aperture = 0.5;
        d.lp = 6; d.lt = 9; d.lf = 5;
        this.focusTarget.copy(d.tgt);
        break;
      }
      case 'action': {
        // frame the ball, the fielder with it / the throw target, and every runner in motion from the high-home camera
        const pts: Vector3[] = [];
        const runners = this.runnersInMotion(rs);
        for (const r of runners) pts.push(toScene(r.pos, new Vector3()).setY(1));
        if (rs.ball.visible && rs.ball.pos.y < 40) pts.push(ball.clone().setY(Math.max(0.5, Math.min(ball.y, 8))));
        if (this.fielderId) {
          const fp = players.get(this.fielderId);
          if (fp) pts.push(fp.clone().setY(1));
        }
        if (this.thrown && this.clock - this.throwClock < 3) pts.push(this.baseTarget.clone().setY(1));
        if (!pts.length) pts.push(ball);
        const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
        d.pos.set(cx * 0.25, 19, -27);
        let azMin = 9, azMax = -9, elMin = 9, elMax = -9, dsum = 0;
        for (const p of pts) {
          const dx = p.x - d.pos.x, dz = p.z - d.pos.z, dy = p.y - d.pos.y;
          const hd = Math.hypot(dx, dz);
          const az = Math.atan2(dx, dz), el = Math.atan2(dy, hd);
          azMin = Math.min(azMin, az); azMax = Math.max(azMax, az);
          elMin = Math.min(elMin, el); elMax = Math.max(elMax, el);
          dsum += Math.hypot(hd, dy);
        }
        const azC = (azMin + azMax) / 2, elC = (elMin + elMax) / 2, dist = dsum / pts.length;
        d.tgt.set(d.pos.x + Math.sin(azC) * Math.cos(elC) * dist, d.pos.y + Math.sin(elC) * dist, d.pos.z + Math.cos(azC) * Math.cos(elC) * dist);
        const needV = (elMax - elMin) * 1.4 + 0.16;
        const needH = ((azMax - azMin) * 1.4 + 0.2) / this.camera.aspect;
        d.fov = MathUtils.clamp(MathUtils.radToDeg(Math.max(needV, needH)), 16, 55);
        d.focus = dist;
        d.aperture = 0.1;
        d.lp = 2; d.lt = 3.5; d.lf = 2;
        this.focusTarget.copy(d.tgt);
        break;
      }
      case 'hrwall': {
        // ball leaving the park, seen in profile from just inside the fence; keep it framed as it flies into the seats
        const h = this.hr;
        if (h) {
          const perp = new Vector3(h.dir.z, 0, -h.dir.x).multiplyScalar(h.side);
          d.pos.copy(h.pos).addScaledVector(perp, 26).addScaledVector(h.dir, -12).setY(5.5);
          this.ballSm.lerp(ball, 1 - Math.exp(-dt * 10));
          d.tgt.copy(this.ballSm);
          const dist = d.pos.distanceTo(d.tgt);
          d.fov = MathUtils.clamp(this.tele(34, dist), 9, 36);
          d.focus = dist;
        }
        d.aperture = 0.25;
        d.lp = 20; d.lt = 9; d.lf = 3;
        this.focusTarget.copy(this.ballSm);
        break;
      }
      case 'trot': {
        // batter tracked around the bases: a low camera outside the diamond on the side of the current leg
        const h = this.hr;
        const r = h && rs.players.find((p) => p.id === h.batterId);
        const rp = r ? toScene(r.pos, new Vector3()) : new Vector3(0, 0, 0);
        const path = [new Vector3(0, 0, 0), new Vector3(BASES[0].x, 0, BASES[0].z), new Vector3(BASES[1].x, 0, BASES[1].z), new Vector3(BASES[2].x, 0, BASES[2].z)];
        const dists = path.map((a, i) => {
          const b = path[(i + 1) % 4];
          const ab = b.clone().sub(a);
          const t = MathUtils.clamp(rp.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
          return a.clone().addScaledVector(ab, t).distanceTo(rp);
        });
        let leg = dists.indexOf(Math.min(...dists));
        // stay on the current leg's camera until another leg is clearly closer (no flicker at the bags)
        if (this.legIdx >= 0 && dists[this.legIdx] <= dists[leg] + 2.5) leg = this.legIdx;
        if (this.legIdx < 0) {
          this.legIdx = leg;
          this.legSince = this.clock;
        } else if (leg !== this.legIdx && this.clock - this.legSince > 1.2) {
          this.legIdx = leg;
          this.legSince = this.clock;
          this.lastCutFrame = true; // hard cut to the next leg's camera
        }
        const a = path[this.legIdx], b = path[(this.legIdx + 1) % 4];
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const centre = new Vector3(0, 0, 19.4);
        const n = new Vector3(-(b.z - a.z), 0, b.x - a.x).normalize();
        if (n.dot(mid.clone().sub(centre)) < 0) n.negate();
        d.pos.copy(mid).addScaledVector(n, 17).setY(3.0);
        const lead = r ? new Vector3(r.vel.x, 0, r.vel.z).multiplyScalar(0.5) : new Vector3();
        d.tgt.copy(rp).add(lead).setY(1.15);
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = MathUtils.clamp(this.tele(12, dist), 8, 40);
        d.focus = dist;
        d.aperture = 0.7;
        d.lp = 3; d.lt = 6; d.lf = 3;
        this.focusTarget.copy(d.tgt);
        break;
      }
      case 'homeplate': {
        // the plate: batter arriving, teammates gathering
        const h = this.hr;
        const r = h && rs.players.find((p) => p.id === h.batterId);
        const rp = r ? toScene(r.pos, new Vector3()) : new Vector3(0, 0, 0);
        d.pos.set(-8.5, 1.7, 6.5);
        d.tgt.set(rp.x * 0.6, 1.25, Math.max(0.3, rp.z * 0.6));
        const dist = d.pos.distanceTo(d.tgt);
        d.fov = MathUtils.clamp(this.tele(8, dist), 12, 40);
        d.focus = dist;
        d.aperture = 0.8;
        d.lp = 4; d.lt = 5; d.lf = 3;
        this.focusTarget.copy(d.tgt);
        break;
      }
      case 'cutaway': {
        const cs = this.stadium.crowdShots;
        if (this.cutaway === 'crowd') {
          const s = cs[this.crowdPick >= 0 ? this.crowdPick : this.shotSeq % cs.length];
          const t = this.clock - this.shotStart;
          d.pos.copy(s.pos).x += Math.sin(t * 0.2) * 1.0;
          d.tgt.copy(s.target);
          d.fov = 15;
        } else if (this.cutaway === 'dugout') {
          // the batting team's dugout (the sim seats the home team on the third-base side)
          const shots = this.dugoutShots;
          const s = shots[live.half === 'top' ? 1 : 0] ?? shots[0]; // [3B (+X, home), 1B (−X, away)]: the away team bats in the top
          if (s) {
            const t = this.clock - this.shotStart;
            d.pos.copy(s.pos).x += Math.sin(t * 0.25) * 0.6;
            d.tgt.copy(s.target);
          } else {
            d.pos.set(3, 1.7, 15);
            d.tgt.set(19, 1.2, 2.5);
          }
          d.fov = 26;
        } else if (this.cutaway === 'ondeck') {
          // the batter on deck, taking his swings: from the front, a little to the side, a shallow telephoto
          const od = rs.players.find((p) => p.role === 'ondeck');
          const batting = live.half === 'top' ? -1 : 1; // the away team's dugout is on the first-base side (−X)
          const o = od ? toScene(od.pos, new Vector3()) : new Vector3(batting * 8.6, 0, -5.2);
          const f = od ? od.facing : Math.atan2(-batting, 0.3);
          const fwd = new Vector3(Math.sin(f), 0, Math.cos(f));
          const t = this.clock - this.shotStart;
          d.pos.copy(o).addScaledVector(fwd, 7).addScaledVector(new Vector3(-fwd.z, 0, fwd.x), 2.2 + Math.sin(t * 0.3) * 0.4).setY(1.5);
          d.tgt.copy(o).setY(1.0);
          d.fov = this.tele(4.6, d.pos.distanceTo(d.tgt));
        } else {
          const t = this.clock - this.shotStart;
          d.pos.set(-30 + t * 3, 45 - t, -80);
          d.tgt.set(0, 6, 60);
          d.fov = 38;
        }
        d.focus = d.pos.distanceTo(d.tgt);
        d.aperture = this.cutaway === 'wide' ? 0 : 0.6;
        d.lp = d.lt = d.lf = 20;
        this.focusTarget.copy(d.tgt);
        break;
      }
      case 'wide': {
        const t = this.clock - this.shotStart;
        d.pos.set(-58 + t * 4.5, 34 - t * 0.6, -42);
        d.tgt.set(0, 4, 48);
        d.fov = 44;
        d.focus = d.pos.distanceTo(d.tgt);
        d.aperture = 0;
        d.lp = d.lt = d.lf = 20;
        this.focusTarget.copy(d.tgt);
        break;
      }
    }
    void BASES;
  }

  private applySmoothing(dt: number) {
    const d = this.des;
    if (this.lastCutFrame) {
      this.pos.copy(d.pos);
      this.tgt.copy(d.tgt);
      this.fov = d.fov;
    } else {
      this.pos.lerp(d.pos, 1 - Math.exp(-dt * d.lp));
      this.tgt.lerp(d.tgt, 1 - Math.exp(-dt * d.lt));
      this.fov += (d.fov - this.fov) * (1 - Math.exp(-dt * d.lf));
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.tgt);
    if (Math.abs(this.camera.fov - this.fov) > 0.005) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    // keep depth precision tight for telephoto shots
    const dist = this.pos.distanceTo(this.tgt);
    const near = MathUtils.clamp(dist * 0.05, 0.3, 4);
    const far = MathUtils.clamp(dist * 2.2 + 120, 200, 800);
    if (Math.abs(this.camera.near - near) > 0.05 || Math.abs(this.camera.far - far) > 1) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /** A new game: forget the last one's plays and start from the pitcher's camera. */
  reset() {
    this.events = [];
    this.hr = null;
    this.replay = null;
    this.close = null;
    this.inPlay = false;
    this.pendingReplay = false;
    this.holdUntil = 0;
    this.thrown = false;
    this.fielderId = null;
    this.umpireUntil = 0;
    this.crewUntil = 0;
    this.lastCoachCut = -99;
    this.lastOnDeckCut = -99;
    this.onDeckPending = -99;
    this.broll = null;
    this.brollRecent = [];
    this.shownThisLull = 0;
    this.lullTrack = null;
    this.breakUntil = 0;
    this.reaction = null;
    this.beat = null;
    this.cutawayUntil = 0;
    this.actionQuiet = 0;
    this.lastEventText = '';
    this.cut('pitch');
  }

  lastText() {
    return this.lastEventText;
  }
}

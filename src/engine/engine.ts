import {
  Frustum,
  Matrix4,
  NeutralToneMapping,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  PCFShadowMap,
  Scene,
  SRGBColorSpace,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Environment, type TimeOfDay } from './environment';
import { buildField } from './field';
import { buildStadium, type Stadium } from './stadium';
import { PostFX } from './postfx';
import { AdaptiveScale, QUALITY, QUALITY_ORDER, loadEffects, pixelRatioFor, type LoadEffects, type QualityName } from './quality';
import { SimDriver, type SimConfig } from './simAdapter';
import { BallView, BatView, PlayerManager } from './players';
import { Puppet } from './characters';
import { CameraDirector } from './cameraDirector';
import { Hud } from './hud';
import { StadiumLights } from './stadiumLights';
import { ContactShadows } from './contactShadows';
import { installCharacterShading, setShadingQuality } from './characterShading';
import { makeLayout, SideCast, type Box } from './sideCast';
import { loadAssets, type Assets, type LoadProgress } from './assets';
import { prepareEngine, rewarm, type PrepareOptions, type PrepareResult } from './warmup';
import { GltfPuppet, templateNameFor } from './gltfCharacter';
import { Box3, Mesh, MeshStandardMaterial, CircleGeometry } from 'three';
import type { GameState } from './types';
import { perf } from './perf';
import { FLAGS } from './flags';

export interface EngineOptions {
  seed?: number;
  forceMock?: boolean;
  quality?: QualityName;
  timeOfDay?: TimeOfDay;
  hud?: boolean;
  /** innings / chosen teams for the sim (the menu's game setup) */
  simConfig?: SimConfig;
}

/** Farthest knob-to-shoulder distance (m) the batter's arms can plausibly cover: arm length plus IK slack. */
const BAT_REACH_MAX = 0.95;
/** Seconds over which the bat moves from the batter's hands to the sim's pose at the start of a swing. */
const BAT_BLEND = 0.07;

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 16 / 9, 0.3, 700);
  readonly env: Environment;
  readonly post: PostFX;
  readonly stadium: Stadium;
  /** pins the number of shadow-casting tower spots (tests / screenshots on a loaded machine); undefined = adaptive */
  lightShadowCap?: number;
  readonly lights: StadiumLights;
  readonly contact = new ContactShadows();
  /** bench, on-deck batter, base coaches and ball kids (made up here unless the sim sends them) */
  readonly side = new SideCast();
  private tossBall: Object3D | null = null;
  /** a foul ball on the ground / in flight with nobody holding it, and the bat the hitter dropped (both from the sim) */
  private deadBallObj: Object3D | null = null;
  private droppedBat: Object3D | null = null;
  readonly adaptive = new AdaptiveScale();
  readonly sim: SimDriver;
  readonly players: PlayerManager;
  readonly ball: BallView;
  readonly bat: BatView;
  readonly director: CameraDirector;
  readonly hud: Hud | null;
  quality = QUALITY.high;
  qualityName: QualityName = 'high';
  private timer = new Timer();
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private time = 0;
  fps = 60;
  private gbufferHidden: Object3D[] = [];
  private sbTimer = 0;
  private hudTimer = 0;
  private landed = false;
  private batted = false;
  private live: GameState;
  private raf = 0;
  private tmpV = new Vector3();
  private frustum = new Frustum();
  private viewProj = new Matrix4();
  private batAge = 0;
  private gripFrom = { pos: new Vector3(), quat: new Quaternion() };
  private prevFar: Vector3 | null = null;
  private fieldGroup: Object3D;
  assets: Assets | null = null;
  /** benchmark mode: every frame advances the game by this many seconds, whatever the real frame time */
  fixedDt?: number;
  /** menu mode: the sim stays frozen, the camera drifts around the park and the hot keys are off */
  attract = false;
  /** false while a menu / pause screen has the keyboard */
  keysEnabled = true;
  private attractT = 0;
  /** touch-first device (phones, tablets): the pixel-ratio policy trades the preset's DPR cap for a pixel budget */
  coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  constructor(root: HTMLElement, opts: EngineOptions = {}) {
    this.el = root;
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Khronos PBR Neutral: keeps the hue and saturation of albedo (ACES pushed lit skin to a pale cream); the contrast comes from the grade pass
    this.renderer.toneMapping = NeutralToneMapping;
    installCharacterShading();
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    root.style.cssText = 'position:fixed;inset:0;overflow:hidden;background:#000;';
    root.appendChild(this.canvas);

    this.env = new Environment(this.scene, this.renderer, this.camera, this.quality);
    this.fieldGroup = buildField(this.env);
    this.scene.add(this.fieldGroup);
    this.stadium = buildStadium(this.env);
    this.scene.add(this.stadium.group);
    this.gbufferHidden.push(...this.stadium.gbufferHidden);
    this.env.onStadiumLights((on) => this.stadium.setLightsOn(on));
    this.lights = new StadiumLights(this.scene);
    this.lights.setTowers(this.stadium.towers);
    this.gbufferHidden.push(this.lights.group);
    this.scene.add(this.contact.mesh);
    this.gbufferHidden.push(this.contact.mesh);

    this.sim = new SimDriver(opts.seed ?? 20260928, opts.forceMock, opts.simConfig);
    this.players = new PlayerManager(this.env);
    this.players.lodOff = FLAGS.nolod;
    this.scene.add(this.players.group);
    this.ball = new BallView(this.env);
    this.bat = new BatView(this.env);
    this.scene.add(this.ball.group, this.bat.obj);
    this.gbufferHidden.push(...this.ball.gbufferHidden);

    this.post = new PostFX(this.renderer, this.scene, this.camera, this.quality);
    this.hookGBufferVisibility();
    this.hookShadowPhase();
    if (perf.on) this.attachPerf();
    this.director = new CameraDirector(this.camera, this.sim, this.canvas, this.stadium);
    this.live = this.sim.state;
    this.director.faceLookup = (id, out) => this.players.faceOf(id, out);

    this.hud =
      opts.hud === false
        ? null
        : new Hud(root, {
            togglePause: () => (this.sim.paused = !this.sim.paused),
            setSpeed: (x) => (this.sim.speed = x),
            skipHalf: () => this.sim.skipToNextHalfInning(),
            skipBatter: () => this.sim.skipToNextBatter(),
            setAuto: (a) => this.director.setAuto(a),
            setQuality: (q) => this.setQuality(q as QualityName),
            setTimeOfDay: (t) => this.setTimeOfDay(t as TimeOfDay),
            setReplays: (on) => (this.director.replaysEnabled = on),
          });

    this.sim.on((te) => {
      this.hud?.onEvent(te.event, this.sim.state);
      if (te.event.type === 'contact') {
        this.landed = false;
        this.batted = true;
        this.stadium.crowd.excite(te.event.exitVelo > 40 ? 0.7 : 0.35);
      }
      if (te.event.type === 'tag' && te.event.fielderId) this.players.noteTag(te.event.fielderId, te.event.result, te.simTime, te.event.runnerId);
      if (te.event.type === 'run') this.stadium.crowd.excite(1);
      if (te.event.type === 'robbed_hr') this.stadium.crowd.excite(0.8); // the groan / gasp
      if (te.event.type === 'out') this.stadium.crowd.excite(0.25);
    });
    this.sim.on((te) => {
      this.side.note(te.event);
      if (te.event.type === 'ball_tossed_to_fan') this.stadium.crowd.excite(0.55); // the stands go for it
      if (te.event.type === 'ball_kid_retrieve') this.stadium.crowd.excite(0.12);
    });
    this.sim.on((te) => (te.event.type === 'pitch' || te.event.type === 'throw' || te.event.type === 'catch') && (this.batted = false));
    this.sim.onPitchCross((x, y, inZone) => this.hud?.pitchCrossed(x, y, inZone ? 's' : 'b'));

    this.canvas.addEventListener('webglcontextrestored', () => this.env.setTimeOfDay(this.env.todName));
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));

    this.setQuality(opts.quality ?? 'high');
    if (opts.timeOfDay) this.setTimeOfDay(opts.timeOfDay);
    this.director.setAuto(true);
    this.resize();
  }

  /** Load Blender assets from /assets and swap them in for the procedural placeholders. */
  async loadAssets(onProgress?: (p: LoadProgress) => void): Promise<Assets> {
    const a = await loadAssets(this.renderer, undefined, onProgress);
    this.assets = a;
    if (a.field) {
      this.fieldGroup.visible = false;
      this.scene.add(a.field);
      a.field.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) for (const mt of Array.isArray(m.material) ? m.material : [m.material]) this.env.register(mt as MeshStandardMaterial);
      });
      // dugout cutaway cameras from the real dugout nodes: 9 m out on the field side, looking in
      for (const name of ['Dugout_3B', 'Dugout_1B']) {
        const o = a.field.getObjectByName(name);
        if (!o) continue;
        const c = new Box3().setFromObject(o).getCenter(new Vector3());
        const inward = new Vector3(0, 0, 14).sub(c).setY(0).normalize();
        this.director.dugoutShots.push({ pos: c.clone().addScaledVector(inward, 17).setY(3.2), target: c.clone().setY(-0.2) });
      }
      // the dugouts' real boxes: where the bench players sit
      const boxOf = (name: string): Box | null => {
        const o = a.field!.getObjectByName(name);
        if (!o) return null;
        const b = new Box3().setFromObject(o);
        return { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } };
      };
      const benchBox = boxOf('Dugout_3B_Bench') ?? boxOf('Dugout_1B_Bench');
      this.side.setLayout(makeLayout([boxOf('Dugout_1B'), boxOf('Dugout_3B')], benchBox ? benchBox.max.y : undefined));
      // B-roll landmarks: the bullpens (away −X, home +X) and the scoreboard
      const centre = (o: Object3D | undefined | null) => (o ? new Box3().setFromObject(o).getCenter(new Vector3()) : null);
      const pens = ['Bullpen_L', 'Bullpen_R'].map((n) => centre(a.field!.getObjectByName(n))).filter((v): v is Vector3 => !!v).sort((p, q) => p.x - q.x);
      if (pens.length === 2) this.director.landmarks.bullpens = [pens[0].setY(0), pens[1].setY(0)];
      const sb = centre(a.stadium?.getObjectByName('Scoreboard'));
      if (sb) this.director.landmarks.scoreboard = sb;
      // ground under the stands / beyond the field mesh
      const under = new Mesh(new CircleGeometry(520, 48).rotateX(-Math.PI / 2), this.env.register(new MeshStandardMaterial({ color: 0x1a1d1a, roughness: 1 })));
      under.position.y = -0.06;
      under.receiveShadow = true;
      this.scene.add(under);
    }
    if (a.stadium) {
      this.stadium.adoptGltf(a.stadium as never, a.mirrored);
      this.lights.setTowers(this.stadium.towers);
    }
    if (a.ball) this.ball.useModel(a.ball, this.env);
    if (a.bat) this.bat.useModel(a.bat, this.env);
    this.bat.useDonut(a.donut ?? null);
    if (a.characters.size) {
      this.players.makePuppet = (snap) => {
        // every player is built from the full base file (all hair / beard / accessory variants, morph targets) and configured per role and
        // per person; umpires keep their fixed dark outfit; files without the variants fall back to the role-specific ones
        const base = a.characters.get('player_base');
        const own = snap.role === 'ballkid' ? 'player_ballkid' : snap.role === 'coach1b' || snap.role === 'coach3b' || snap.role === 'batboy' || snap.role === 'manager' ? 'player_coach' : null;
        const name = own && a.characters.has(own) ? own : snap.role === 'umpire' ? (snap.position && snap.position !== 'HP' && a.characters.has('player_umpire_base') ? 'player_umpire_base' : 'player_umpire') : base?.full ? 'player_base' : templateNameFor(snap);
        const tpl = a.characters.get(name) ?? base;
        return tpl ? new GltfPuppet(tpl, snap, a.gear, a.manifest) : new Puppet(snap.id);
      };
      this.players.reset();
    }
    this.env.setQuality(this.quality);
    return a;
  }

  /**
   * Everything that has to happen before the first frame the player sees: assets, sky, shader compilation, a warm-up render of every
   * variant and a few frames of a dummy game (see `warmup.ts`). The canvas should stay hidden until this resolves.
   */
  prepare(opts: PrepareOptions): Promise<PrepareResult> {
    return prepareEngine(this, opts);
  }

  /** Compile and draw everything again after a quality / time-of-day change (so the next visible frame does not hitch). */
  rewarm(): Promise<void> {
    return rewarm(this);
  }

  /** Start a fresh game (same seed + config reproduces it exactly). The camera, HUD and puppets are reset; `paused` / `speed` are kept. */
  newGame(seed: number, cfg: SimConfig = {}) {
    this.sim.load(seed, cfg);
    this.players.reset();
    this.director.reset();
    this.hud?.reset();
    this.live = this.sim.state;
    this.landed = false;
    this.batted = false;
    this.batAge = 0;
    this.prevFar = null;
    this.adaptive.reset();
    this.resize();
  }

  private attractCamera(dt: number) {
    // a slow arc across the outfield side of the park, looking in at the diamond and the stands behind it
    const t = (this.attractT += dt);
    const th = 0.85 * Math.sin(t * 0.06);
    const r = 78 + 8 * Math.sin(t * 0.045);
    const cam = this.camera;
    cam.position.set(Math.sin(th) * r, 13 + 5 * Math.sin(t * 0.04 + 1), 30 + Math.cos(th) * r);
    cam.lookAt(0, 4, 8 + 6 * Math.sin(t * 0.05));
    if (cam.fov !== 38 || cam.near !== 0.5) {
      cam.fov = 38;
      cam.near = 0.5;
      cam.far = 900;
      cam.updateProjectionMatrix();
    }
  }

  private onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (!this.keysEnabled || tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tods = ['day', 'dusk', 'night'] as const;
    switch (e.key.toLowerCase()) {
      case ' ':
        this.sim.paused = !this.sim.paused;
        e.preventDefault();
        break;
      case '1': this.sim.speed = 1; break;
      case '2': this.sim.speed = 2; break;
      case '3': this.sim.speed = 4; break;
      case 'n': this.sim.skipToNextHalfInning(); break;
      case '.': this.sim.skipToNextBatter(); break;
      case 'c': this.director.setAuto(!this.director.auto); break;
      case 'b': this.hud?.toggleBox(); break;
      case 'q': this.setQuality(QUALITY_ORDER[(QUALITY_ORDER.indexOf(this.qualityName) + 1) % 4]); break;
      case 't': this.setTimeOfDay(tods[(tods.indexOf(this.env.todName) + 1) % 3]); break;
    }
  }

  /** Objects that must be invisible while the depth/normal pre-pass runs (glows, trails, decals). */
  hideFromGBuffer(...objs: Object3D[]) {
    this.gbufferHidden.push(...objs);
  }

  private hookGBufferVisibility() {
    const ao = this.post.ao as unknown as { _renderOverride: (...a: unknown[]) => void };
    const orig = ao._renderOverride.bind(ao);
    ao._renderOverride = (...args: unknown[]) => {
      const vis = this.gbufferHidden.map((o) => o.visible);
      for (const o of this.gbufferHidden) o.visible = false;
      this.players.phase('gbuf');
      this.stadium.crowdVisible(false);
      // GTAO's prepass is a second `renderer.render`, which would render every shadow map again (the main pass has just done it): no shadows here
      const sm = this.renderer.shadowMap;
      const wasAuto = sm.autoUpdate;
      sm.autoUpdate = false;
      try {
        orig(...args);
      } finally {
        sm.autoUpdate = wasAuto;
        this.players.phase('main');
        this.stadium.crowdVisible(true);
      }
      this.gbufferHidden.forEach((o, i) => (o.visible = vis[i]));
    };
  }

  /** the shadow passes draw each puppet as one merged proxy mesh (visible only while they run; the main pass list is built before they start) */
  private hookShadowPhase() {
    const sm = this.renderer.shadowMap;
    const orig = sm.render.bind(sm);
    sm.render = (...args: Parameters<typeof orig>) => {
      this.players.phase('shadow');
      try {
        orig(...args);
      } finally {
        this.players.phase('main');
      }
    };
  }

  /** profiler hooks (`?perf=1` / `?bench=1`): the composer's passes, the shadow pass and the GTAO prepass are timed on CPU and GPU */
  private attachPerf() {
    const post = this.post;
    perf.attach(this.renderer, post.passList());
    perf.wrap(post.ao, '_renderOverride', 'gtao_gbuf');
    perf.setOverlayExtra(() => ({ preset: this.qualityName, scale: this.adaptive.scale.toFixed(2), dpr: this.renderer.getPixelRatio().toFixed(2), px: `${this.renderer.domElement.width}x${this.renderer.domElement.height}` }));
  }

  setQuality(name: QualityName) {
    this.qualityName = name;
    this.quality = QUALITY[name];
    this.env.setQuality(this.quality);
    this.post.setQuality(this.quality);
    this.stadium.crowd.setDensity(this.quality.crowdDensity);
    this.stadium.crowd.setAnimate(this.quality.crowdAnimate);
    this.lights.setQuality(name);
    setShadingQuality(name, this.quality.msaa > 0);
    this.lights.setTextureUnits(this.renderer.capabilities.maxTextures);
    this.adaptive.full();
    this.loadApplied = -1;
    this.applyLoad();
    this.resize();
  }

  private loadApplied = -1;
  private lodCutTmp: [number, number] = [0.2, 0.08];
  fx: LoadEffects = loadEffects(0);

  /** the adaptive controller's CPU-side level -> what is actually switched (see `loadEffects`); cheap when the level did not change */
  private applyLoad() {
    const lv = this.adaptive.level;
    if (lv === this.loadApplied) return;
    this.loadApplied = lv;
    const fx = (this.fx = loadEffects(lv));
    const q = this.quality;
    this.stadium.crowd.setSectors(Math.min(q.crowdSectors, fx.crowdSectors));
    this.stadium.crowd.setAnimate(q.crowdAnimate && fx.crowdAnimate);
    this.post.setNoAo(fx.noAo);
    this.env.setFarShadowEvery(fx.farShadowEvery);
  }

  setTimeOfDay(t: TimeOfDay): Promise<void> {
    // the settings store (UI) remembers the choice; the tower lights follow at once, the sky / HDRI when its texture is ready
    this.lights.setTimeOfDay(t);
    return this.env.setTimeOfDay(t);
  }

  /** Create the lazily-made loose props (dead foul ball, dropped bat, the ball kid's toss ball), hidden, so the warm-up draws them once. */
  ensureLooseProps(): Object3D[] {
    if (!this.deadBallObj) {
      this.deadBallObj = this.ball.makeHandBall();
      this.deadBallObj.visible = false;
      this.scene.add(this.deadBallObj);
    }
    if (!this.droppedBat) {
      this.droppedBat = this.bat.makeHandBat(false);
      this.droppedBat.name = 'DroppedBat';
      this.droppedBat.visible = false;
      this.scene.add(this.droppedBat);
    }
    if (!this.tossBall) {
      this.tossBall = this.ball.makeHandBall();
      this.tossBall.visible = false;
      this.scene.add(this.tossBall);
    }
    return [this.deadBallObj, this.droppedBat, this.tossBall];
  }

  /** the sim's dead foul ball and the dropped bat, drawn where they lie (a ball a kid carries is in his hand instead) */
  private updateLoose(rs: GameState) {
    const db = rs.deadBall;
    const showBall = !!db && db.state !== 'carried';
    if (showBall && !this.deadBallObj) {
      this.deadBallObj = this.ball.makeHandBall();
      this.scene.add(this.deadBallObj);
    }
    if (this.deadBallObj) {
      this.deadBallObj.visible = showBall;
      if (showBall) this.deadBallObj.position.set(db!.pos.x, Math.max(0.037, db!.pos.y), db!.pos.z);
    }
    const d = rs.bat.dropped;
    if (d && !this.droppedBat) {
      this.droppedBat = this.bat.makeHandBat(false);
      this.droppedBat.name = 'DroppedBat';
      this.scene.add(this.droppedBat);
    }
    if (this.droppedBat) {
      this.droppedBat.visible = !!d;
      if (d) {
        // lying flat on the ground, pointing a little toward the first-base side (the same way every time: no flicker)
        this.droppedBat.position.set(d.x, Math.max(0.034, d.y + 0.034), d.z);
        this.droppedBat.rotation.set(0, 0.5, Math.PI / 2, 'YXZ');
      }
    }
  }

  /** the ball a kid tosses to a fan, drawn on its arc */
  private updateTossBall() {
    const t = this.side.toss;
    if (!t.visible) {
      if (this.tossBall) this.tossBall.visible = false;
      return;
    }
    if (!this.tossBall) {
      this.tossBall = this.ball.makeHandBall();
      this.scene.add(this.tossBall);
    }
    this.tossBall.visible = true;
    this.tossBall.position.set(t.pos.x, t.pos.y, t.pos.z);
  }

  resize() {
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight;
    const dpr = pixelRatioFor(this.quality, window.devicePixelRatio || 1, w, h, this.coarse) * this.adaptive.scale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, dpr);
    this.env.resize();
  }

  start() {
    this.timer.connect(document);
    const loop = (ts: number) => {
      this.raf = requestAnimationFrame(loop);
      perf.frameBegin(ts);
      this.timer.update(ts);
      // benchmarks step the game by a fixed dt per frame, so every preset plays out the same game
      this.tick(this.fixedDt ?? Math.min(this.timer.getDelta(), 0.25));
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  /** One frame. `render = false` only updates (sim, director, puppets), e.g. to build the puppets before the shaders are compiled. */
  tick(dt: number, render = true) {
    const t0 = performance.now();
    this.time += dt;
    const { state } = this.sim.advance(dt);
    this.live = state;
    if (perf.on) perf.lap('sim');

    // director picks camera + which state to render (live or replay)
    const liveBall = new Vector3(state.ball.pos.x, state.ball.pos.y, state.ball.pos.z);
    const out = this.director.update(dt, state, liveBall, this.players.positions);
    const rs = out.renderState;
    if (perf.on) perf.lap('director');
    if (this.attract) this.attractCamera(dt);
    const animDt = this.attract ? dt : this.sim.paused ? 0 : dt * (out.replaying ? out.replaySpeed : Math.min(this.sim.speed, 3));
    // The sim keeps the bat's knob within arm's reach of the batter's shoulders, so the bat follows the sim pose and the arm
    // IK meets it. Only if it is out of reach anyway (mismatched body/sim, teleports) do the hands keep the bat instead.
    let useGrip = !rs.bat.visible;
    const grip = this.players.batterGrip(rs);
    if (!useGrip && grip && this.players.batterShoulder(rs, this.tmpV)) {
      useGrip = this.tmpV.distanceTo(new Vector3(rs.bat.pos.x, rs.bat.pos.y, rs.bat.pos.z)) > BAT_REACH_MAX;
    }
    this.bat.hold(useGrip ? grip : null, this.scene);
    this.batAge = rs.bat.visible ? this.batAge + animDt : 0;
    const blend = this.batAge / BAT_BLEND;
    if (grip && !useGrip && blend < 1) {
      grip.updateWorldMatrix(true, false);
      grip.getWorldPosition(this.gripFrom.pos);
      grip.getWorldQuaternion(this.gripFrom.quat);
      this.bat.update(rs, this.gripFrom, blend);
    } else this.bat.update(rs);
    // the side cast moves with the live game (not the replay) and is added to whichever state is drawn
    this.side.setClips((n) => !!this.assets?.manifest?.clips?.[n]);
    const extras = this.side.update(state, animDt, (e) => this.sim.emit(e));
    const drawn = extras.length ? { ...rs, players: [...rs.players, ...extras] } : rs;
    if (perf.on) perf.lap('bat+side');
    this.players.makeBat = () => this.bat.makeHandBat();
    this.camera.updateMatrixWorld();
    this.players.frustum = this.frustum.setFromProjectionMatrix(this.viewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    this.players.lodK = 1 / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.lodCutTmp[0] = this.quality.puppetLod[0] * this.fx.lodScale;
    this.lodCutTmp[1] = this.quality.puppetLod[1] * this.fx.lodScale;
    this.players.lodCut = this.lodCutTmp;
    this.players.update(drawn, animDt, this.ball.worldPos, this.bat, () => this.ball.makeHandBall(), this.camera.position);
    if (perf.on) perf.lap('puppets');
    this.contact.visible = this.quality.name !== 'low';
    if (this.contact.visible) this.contact.update(this.players.feet());
    this.updateTossBall();
    this.updateLoose(rs);
    // the ball a pitcher / fielder carries is drawn by his puppet; at release it becomes the sim's ball without a pop
    const held = this.players.ballHeld;
    if (this.ball.heldByPlayer && !held && rs.ball.visible) {
      const sim = new Vector3(rs.ball.pos.x, rs.ball.pos.y, rs.ball.pos.z);
      if (sim.distanceTo(this.players.heldPos) < 1.5) this.ball.released(this.players.heldPos, sim);
    }
    this.ball.heldByPlayer = held;
    this.ball.update(rs, animDt, this.camera.position, this.batted || out.replaying);

    // batted distance once it first lands
    if (!this.landed && !out.replaying && state.ball.visible && state.ball.pos.y < 0.12 && state.ball.pos.z > 1) {
      this.landed = true;
      this.hud?.setDistance(Math.hypot(state.ball.pos.x, state.ball.pos.z));
    }
    if ((this.sbTimer -= dt) < 0) {
      this.sbTimer = 0.3;
      this.stadium.updateScoreboard(state);
    }
    if (perf.on) perf.lap('ball+props');
    this.hud?.update(state, dt);
    this.hud?.showReplay(out.replaying, state.half === 'top' ? state.teams.home.color : state.teams.away.color, out.label);
    if (this.hud && (this.hudTimer -= dt) < 0) {
      this.hudTimer = 0.5;
      this.hud.setFps(this.fps, this.adaptive.scale);
    }

    if (perf.on) perf.lap('hud');
    // pan motion blur: how far a distant point ahead of the camera slid across the screen since last frame
    {
      const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(this.camera.quaternion).multiplyScalar(200).add(this.camera.position);
      if (this.prevFar && !out.cut && !this.attract) {
        const a = this.prevFar.clone().project(this.camera);
        const cap = 0.04;
        const mx = Math.max(-cap, Math.min(cap, (-a.x * 0.5) * 0.5)), my = Math.max(-cap, Math.min(cap, (-a.y * 0.5) * 0.5));
        this.post.setMotion(Math.abs(mx) < 0.0015 ? 0 : mx, Math.abs(my) < 0.0015 ? 0 : my);
      } else this.post.setMotion(0, 0);
      this.prevFar = fwd.clone();
    }
    this.post.capture = out.capture;
    if (out.dissolve > 0) this.post.startDissolve(out.dissolve);
    this.post.setFocus(out.focus, out.aperture * (this.director.auto && !this.attract ? 1 : 0));
    if (perf.on) perf.lap('post-setup');
    this.stadium.crowd.update(this.time, dt);
    if (perf.on) perf.lap('crowd');
    this.lights.update(this.time);
    // slow frames: the shadow-casting tower spots go first (then all tower shadows)
    this.lights.setShadowCap(this.lightShadowCap ?? Math.min(this.fx.towerShadows, this.adaptive.scale < 0.62 ? 0 : this.adaptive.scale < 0.78 ? 1 : 99));
    this.camera.updateMatrixWorld();
    this.env.update();
    this.env.resize();
    if (perf.on) perf.lap('env');
    if (!render) return;
    if (location.search.includes('nopost')) this.renderer.render(this.scene, this.camera);
    else this.post.render(this.time, dt);
    if (perf.on) {
      perf.lap('render');
      perf.setScale(this.adaptive.scale);
    }
    const ms = performance.now() - t0;
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.08;
    if (this.adaptive.update(ms, dt * 1000, dt)) {
      this.applyLoad();
      this.resize();
    }
    perf.frameEnd();
  }

  get liveState() {
    return this.live;
  }
}

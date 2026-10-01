import {
  ACESFilmicToneMapping,
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
import { AdaptiveScale, QUALITY, QUALITY_ORDER, type QualityName } from './quality';
import { SimDriver } from './simAdapter';
import { BallView, BatView, PlayerManager } from './players';
import { Puppet } from './characters';
import { CameraDirector } from './cameraDirector';
import { Hud } from './hud';
import { StadiumLights } from './stadiumLights';
import { loadAssets, type Assets } from './assets';
import { GltfPuppet, templateNameFor } from './gltfCharacter';
import { Box3, Mesh, MeshStandardMaterial, CircleGeometry } from 'three';
import type { GameState } from './types';

export interface EngineOptions {
  seed?: number;
  forceMock?: boolean;
  quality?: QualityName;
  timeOfDay?: TimeOfDay;
  hud?: boolean;
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
  private batAge = 0;
  private gripFrom = { pos: new Vector3(), quat: new Quaternion() };
  private prevFar: Vector3 | null = null;
  private fieldGroup: Object3D;
  assets: Assets | null = null;

  constructor(root: HTMLElement, opts: EngineOptions = {}) {
    this.el = root;
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
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

    this.sim = new SimDriver(opts.seed ?? 20260928, opts.forceMock);
    this.players = new PlayerManager(this.env);
    this.scene.add(this.players.group);
    this.ball = new BallView(this.env);
    this.bat = new BatView(this.env);
    this.scene.add(this.ball.group, this.bat.obj);
    this.gbufferHidden.push(...this.ball.gbufferHidden);

    this.post = new PostFX(this.renderer, this.scene, this.camera, this.quality);
    this.hookGBufferVisibility();
    this.director = new CameraDirector(this.camera, this.sim, this.canvas, this.stadium);
    this.live = this.sim.state;

    this.hud =
      opts.hud === false
        ? null
        : new Hud(root, {
            togglePause: () => (this.sim.paused = !this.sim.paused),
            setSpeed: (x) => (this.sim.speed = x),
            skipHalf: () => this.sim.skipToNextHalfInning(),
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
    this.sim.on((te) => (te.event.type === 'pitch' || te.event.type === 'throw' || te.event.type === 'catch') && (this.batted = false));
    this.sim.onPitchCross((x, y, inZone) => this.hud?.pitchCrossed(x, y, inZone ? 's' : 'b'));

    this.canvas.addEventListener('webglcontextrestored', () => this.env.setTimeOfDay(this.env.todName));
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));

    this.setQuality(opts.quality ?? 'high');
    // the time of day chosen in the menu is kept between sessions (an explicit option / ?tod= wins)
    let storedTod: string | null = null;
    try {
      storedTod = localStorage.getItem('claudeball.tod');
    } catch {
      /* storage unavailable */
    }
    const startTod = opts.timeOfDay ?? (storedTod === 'day' || storedTod === 'dusk' || storedTod === 'night' ? storedTod : undefined);
    if (startTod) this.setTimeOfDay(startTod);
    this.director.setAuto(true);
    this.resize();
  }

  /** Load Blender assets from /assets and swap them in for the procedural placeholders. */
  async loadAssets(): Promise<Assets> {
    const a = await loadAssets(this.renderer);
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
    if (a.characters.size) {
      this.players.makePuppet = (snap) => {
        // every player is built from the full base file (all hair / beard / accessory variants, morph targets) and configured per role and
        // per person; umpires keep their fixed dark outfit; files without the variants fall back to the role-specific ones
        const base = a.characters.get('player_base');
        const name = snap.role === 'umpire' ? (snap.position && snap.position !== 'HP' && a.characters.has('player_umpire_base') ? 'player_umpire_base' : 'player_umpire') : base?.full ? 'player_base' : templateNameFor(snap);
        const tpl = a.characters.get(name) ?? base;
        return tpl ? new GltfPuppet(tpl, snap, a.gear, a.manifest) : new Puppet(snap.id);
      };
      this.players.reset();
    }
    this.env.setQuality(this.quality);
    return a;
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.tagName === 'SELECT') return;
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
      orig(...args);
      this.gbufferHidden.forEach((o, i) => (o.visible = vis[i]));
    };
  }

  setQuality(name: QualityName) {
    this.qualityName = name;
    this.quality = QUALITY[name];
    this.env.setQuality(this.quality);
    this.post.setQuality(this.quality);
    this.stadium.crowd.setDensity(this.quality.crowdDensity);
    this.stadium.crowd.setAnimate(this.quality.crowdAnimate);
    this.lights.setQuality(name);
    this.resize();
  }

  setTimeOfDay(t: TimeOfDay) {
    this.env.setTimeOfDay(t);
    this.lights.setTimeOfDay(t);
    try {
      localStorage.setItem('claudeball.tod', t);
    } catch {
      /* storage unavailable */
    }
  }

  resize() {
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxDpr) * this.adaptive.scale;
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
      this.timer.update(ts);
      this.tick(Math.min(this.timer.getDelta(), 0.25));
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  tick(dt: number) {
    const t0 = performance.now();
    this.time += dt;
    const { state } = this.sim.advance(dt);
    this.live = state;

    // director picks camera + which state to render (live or replay)
    const liveBall = new Vector3(state.ball.pos.x, state.ball.pos.y, state.ball.pos.z);
    const out = this.director.update(dt, state, liveBall, this.players.positions);
    const rs = out.renderState;
    const animDt = this.sim.paused ? 0 : dt * (out.replaying ? out.replaySpeed : Math.min(this.sim.speed, 3));
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
    this.players.update(rs, animDt, this.ball.worldPos, this.bat, () => this.ball.makeHandBall());
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
    this.hud?.update(state, dt);
    this.hud?.showReplay(out.replaying, state.half === 'top' ? state.teams.home.color : state.teams.away.color, out.label);
    if (this.hud && (this.hudTimer -= dt) < 0) {
      this.hudTimer = 0.5;
      this.hud.setFps(this.fps, this.adaptive.scale);
    }

    // pan motion blur: how far a distant point ahead of the camera slid across the screen since last frame
    {
      const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(this.camera.quaternion).multiplyScalar(200).add(this.camera.position);
      if (this.prevFar && !out.cut) {
        const a = this.prevFar.clone().project(this.camera);
        const cap = 0.04;
        const mx = Math.max(-cap, Math.min(cap, (-a.x * 0.5) * 0.5)), my = Math.max(-cap, Math.min(cap, (-a.y * 0.5) * 0.5));
        this.post.setMotion(Math.abs(mx) < 0.0015 ? 0 : mx, Math.abs(my) < 0.0015 ? 0 : my);
      } else this.post.setMotion(0, 0);
      this.prevFar = fwd.clone();
    }
    this.post.setFocus(out.focus, out.aperture * (this.director.auto ? 1 : 0));
    this.stadium.crowd.update(this.time, dt);
    this.lights.update(this.time);
    // slow frames: the shadow-casting tower spots go first (then all tower shadows)
    this.lights.setShadowCap(this.lightShadowCap ?? (this.adaptive.scale < 0.62 ? 0 : this.adaptive.scale < 0.78 ? 1 : 99));
    this.camera.updateMatrixWorld();
    this.env.update();
    this.env.resize();
    if (location.search.includes('nopost')) this.renderer.render(this.scene, this.camera);
    else this.post.render(this.time, dt);
    const ms = performance.now() - t0;
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.08;
    if (this.adaptive.update(Math.max(ms, dt * 1000), dt)) this.resize();
  }

  get liveState() {
    return this.live;
  }
}

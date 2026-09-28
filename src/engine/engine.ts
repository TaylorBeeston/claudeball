import {
  ACESFilmicToneMapping,
  Object3D,
  PerspectiveCamera,
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
import { CameraDirector } from './cameraDirector';
import { Hud } from './hud';
import type { GameState } from './types';

export interface EngineOptions {
  seed?: number;
  forceMock?: boolean;
  quality?: QualityName;
  timeOfDay?: TimeOfDay;
  hud?: boolean;
}

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 16 / 9, 0.3, 700);
  readonly env: Environment;
  readonly post: PostFX;
  readonly stadium: Stadium;
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
    this.scene.add(buildField(this.env));
    this.stadium = buildStadium(this.env);
    this.scene.add(this.stadium.group);
    this.gbufferHidden.push(...this.stadium.gbufferHidden);
    this.env.onStadiumLights((on) => this.stadium.setLightsOn(on));

    this.sim = new SimDriver(opts.seed ?? 20260928, opts.forceMock);
    this.players = new PlayerManager(this.env);
    this.scene.add(this.players.group);
    this.ball = new BallView(this.env);
    this.bat = new BatView(this.env);
    this.scene.add(this.ball.group, this.bat.mesh);
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
      if (te.event.type === 'run') this.stadium.crowd.excite(1);
      if (te.event.type === 'out') this.stadium.crowd.excite(0.25);
    });
    this.sim.on((te) => te.event.type === 'pitch' && (this.batted = false));
    this.sim.onPitchCross((x, y, inZone) => this.hud?.pitchCrossed(x, y, inZone ? 's' : 'b'));

    this.canvas.addEventListener('webglcontextrestored', () => this.env.setTimeOfDay(this.env.todName));
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));

    this.setQuality(opts.quality ?? 'high');
    if (opts.timeOfDay) this.setTimeOfDay(opts.timeOfDay);
    this.director.setAuto(true);
    this.resize();
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
    this.resize();
  }

  setTimeOfDay(t: TimeOfDay) {
    this.env.setTimeOfDay(t);
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
    const liveBall = new Vector3(-state.ball.pos.x, state.ball.pos.y, state.ball.pos.z);
    const out = this.director.update(dt, state, liveBall, this.players.positions);
    const rs = out.renderState;
    const animDt = this.sim.paused ? 0 : dt * (out.replaying ? 0.5 : Math.min(this.sim.speed, 3));
    this.bat.update(rs);
    this.ball.update(rs, animDt, this.camera.position, this.batted || out.replaying);
    this.players.update(rs, animDt, this.ball.worldPos, this.bat);

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
    this.hud?.showReplay(out.replaying, state.half === 'top' ? state.teams.home.color : state.teams.away.color);
    if (this.hud && (this.hudTimer -= dt) < 0) {
      this.hudTimer = 0.5;
      this.hud.setFps(this.fps, this.adaptive.scale);
    }

    this.post.setFocus(out.focus, out.aperture * (this.director.auto ? 1 : 0));
    this.stadium.crowd.update(this.time, dt);
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

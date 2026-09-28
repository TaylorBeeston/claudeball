import {
  ACESFilmicToneMapping,
  Clock,
  Object3D,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Environment, type TimeOfDay } from './environment';
import { buildField } from './field';
import { buildStadium, type Stadium } from './stadium';
import { PostFX } from './postfx';
import { AdaptiveScale, QUALITY, type QualityName } from './quality';

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 16 / 9, 0.3, 700);
  readonly env: Environment;
  readonly post: PostFX;
  readonly stadium: Stadium;
  readonly adaptive = new AdaptiveScale();
  quality = QUALITY.high;
  private clock = new Clock();
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private time = 0;
  fps = 60;
  frameMs = 16;
  private gbufferHidden: Object3D[] = [];
  private frameHooks: ((dt: number, t: number) => void)[] = [];

  constructor(root: HTMLElement) {
    this.el = root;
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = 2; // PCFSoftShadowMap
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
    this.post = new PostFX(this.renderer, this.scene, this.camera, this.quality);
    this.hookGBufferVisibility();

    this.camera.position.set(0, 12, -22);
    this.camera.lookAt(0, 1, 30);
    this.setQuality('high');
    this.canvas.addEventListener('webglcontextrestored', () => this.env.setTimeOfDay(this.env.todName));
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Objects that must be invisible while the depth/normal pre-pass runs (glows, trails, decals). */
  hideFromGBuffer(...objs: Object3D[]) {
    this.gbufferHidden.push(...objs);
  }

  private hookGBufferVisibility() {
    const ao = (this.post as unknown as { ao: { _renderOverride: (...a: unknown[]) => void } }).ao;
    const orig = ao._renderOverride.bind(ao);
    ao._renderOverride = (...args: unknown[]) => {
      const vis = this.gbufferHidden.map((o) => o.visible);
      for (const o of this.gbufferHidden) o.visible = false;
      orig(...args);
      this.gbufferHidden.forEach((o, i) => (o.visible = vis[i]));
    };
  }

  setQuality(name: QualityName) {
    this.quality = QUALITY[name];
    this.env.setQuality(this.quality);
    this.post.setQuality(this.quality);
    this.stadium.crowd.setDensity(this.quality.crowdDensity);
    this.stadium.crowd.setAnimate(this.quality.crowdAnimate);
    this.renderer.shadowMap.enabled = true;
    this.resize();
  }

  setTimeOfDay(t: TimeOfDay) {
    this.env.setTimeOfDay(t);
  }

  onFrame(cb: (dt: number, t: number) => void) {
    this.frameHooks.push(cb);
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
    this.clock.start();
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(this.clock.getDelta(), 0.25);
      this.tick(dt);
    };
    loop();
  }

  tick(dt: number) {
    this.time += dt;
    const t0 = performance.now();
    for (const cb of this.frameHooks) cb(dt, this.time);
    this.stadium.crowd.update(this.time, dt);
    this.camera.updateMatrixWorld();
    this.env.update();
    if (location.search.includes('nopost')) this.renderer.render(this.scene, this.camera);
    else this.post.render(this.time, dt);
    this.frameMs = performance.now() - t0;
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.08;
    if (this.adaptive.update(dt * 1000, dt)) this.resize();
  }

  lookAt(p: Vector3) {
    this.camera.lookAt(p);
  }
}

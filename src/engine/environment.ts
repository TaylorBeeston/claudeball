import {
  BufferGeometry,
  Camera,
  Color,
  CubeCamera,
  Float32BufferAttribute,
  HalfFloatType,
  HemisphereLight,
  Material,
  Mesh,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderer,
} from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { QualitySettings } from './quality';

export type TimeOfDay = 'day' | 'dusk' | 'night';

interface TodPreset {
  sunDir: [number, number, number];
  sunColor: number;
  sunIntensity: number;
  env: number;
  exposure: number;
  hemi: [number, number, number];
  lightsOn: boolean;
  sky: { turbidity: number; rayleigh: number; mie: number; g: number };
  fog: number;
  fogDensity: number;
}

const PRESETS: Record<TimeOfDay, TodPreset> = {
  day: {
    sunDir: [0.52, 0.7, 0.5],
    sunColor: 0xfff0dc,
    sunIntensity: 3.4,
    env: 0.9,
    exposure: 0.62,
    hemi: [0xbcd6ff, 0x506038, 0.35],
    lightsOn: false,
    sky: { turbidity: 3.2, rayleigh: 1.1, mie: 0.004, g: 0.82 },
    fog: 0xbfd2e6,
    fogDensity: 0.00045,
  },
  dusk: {
    sunDir: [0.62, 0.11, 0.72],
    sunColor: 0xffa860,
    sunIntensity: 3.0,
    env: 0.7,
    exposure: 0.55,
    hemi: [0x8aa0d0, 0x40382a, 0.4],
    lightsOn: true,
    sky: { turbidity: 6, rayleigh: 2.2, mie: 0.006, g: 0.9 },
    fog: 0xc0907a,
    fogDensity: 0.0006,
  },
  night: {
    sunDir: [0.3, 0.86, 0.2],
    sunColor: 0xfff1de,
    sunIntensity: 2.4,
    env: 0.16,
    exposure: 0.75,
    hemi: [0x5f7cae, 0x1c2818, 0.5],
    lightsOn: true,
    sky: { turbidity: 1, rayleigh: 0.12, mie: 0.001, g: 0.7 },
    fog: 0x0a1020,
    fogDensity: 0.0006,
  },
};

export class Environment {
  csm!: CSM;
  readonly sunDir = new Vector3();
  tod: TodPreset = PRESETS.day;
  todName: TimeOfDay = 'day';
  private hemi: HemisphereLight;
  private skyScene = new Scene();
  private sky = new Sky();
  private stars: Points;
  private cubeRT: WebGLCubeRenderTarget;
  private cubeCam: CubeCamera;
  private pmrem: PMREMGenerator;
  private envRT: ReturnType<PMREMGenerator['fromCubemap']> | null = null;
  private materials = new Set<Material>();
  private onLights: ((on: boolean) => void)[] = [];

  constructor(
    private scene: Scene,
    private renderer: WebGLRenderer,
    private camera: Camera,
    private q: QualitySettings,
  ) {
    this.hemi = new HemisphereLight(0xffffff, 0x444444, 0.3);
    scene.add(this.hemi);
    this.sky.scale.setScalar(50000);
    this.skyScene.add(this.sky);
    const sg = new BufferGeometry();
    const pos: number[] = [];
    for (let i = 0; i < 1800; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      if (u < 0.02) continue;
      pos.push(Math.cos(th) * s * 20000, u * 20000, Math.sin(th) * s * 20000);
    }
    sg.setAttribute('position', new Float32BufferAttribute(pos, 3));
    this.stars = new Points(sg, new PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }));
    this.skyScene.add(this.stars);
    this.cubeRT = new WebGLCubeRenderTarget(512, { type: HalfFloatType, generateMipmaps: true });
    this.cubeCam = new CubeCamera(1, 100000, this.cubeRT);
    this.pmrem = new PMREMGenerator(renderer);
    this.buildCSM();
    this.setTimeOfDay('day');
  }

  private buildCSM() {
    this.csm?.remove();
    this.csm?.dispose();
    this.csm = new CSM({
      camera: this.camera as never,
      parent: this.scene,
      cascades: this.q.shadowCascades,
      maxFar: 380,
      mode: 'practical',
      shadowMapSize: this.q.shadowMapSize,
      shadowBias: -0.00025,
      lightDirection: this.sunDir.clone().negate(),
      lightIntensity: this.tod?.sunIntensity ?? 3,
      lightMargin: 120,
    });
    this.csm.fade = true;
    for (const l of this.csm.lights) {
      l.shadow.normalBias = 0.04;
      l.shadow.radius = 2.5;
      l.color.setHex(this.tod?.sunColor ?? 0xffffff);
    }
    for (const m of this.materials) this.hook(m);
  }

  setQuality(q: QualitySettings) {
    const rebuild = q.shadowCascades !== this.q.shadowCascades || q.shadowMapSize !== this.q.shadowMapSize;
    this.q = q;
    if (rebuild) {
      this.buildCSM();
      for (const m of this.materials) m.needsUpdate = true;
    }
  }

  /** Register a lit material so it receives cascaded shadows. */
  register<T extends Material>(m: T, patch?: (shader: unknown) => void): T {
    if (patch) (m as Material & { userData: Record<string, unknown> }).userData.patch = patch;
    this.materials.add(m);
    this.hook(m);
    return m;
  }

  private hook(m: Material) {
    this.csm.setupMaterial(m);
    const patch = m.userData.patch as ((s: unknown) => void) | undefined;
    if (patch) {
      const base = m.onBeforeCompile;
      m.onBeforeCompile = (shader, r) => {
        base.call(m, shader, r);
        patch(shader);
      };
    }
  }

  onStadiumLights(cb: (on: boolean) => void) {
    this.onLights.push(cb);
    cb(this.tod.lightsOn);
  }

  setTimeOfDay(name: TimeOfDay) {
    this.todName = name;
    const t = (this.tod = PRESETS[name]);
    this.sunDir.set(...t.sunDir).normalize();
    const u = this.sky.material.uniforms;
    u['turbidity'].value = t.sky.turbidity;
    u['rayleigh'].value = t.sky.rayleigh;
    u['mieCoefficient'].value = t.sky.mie;
    u['mieDirectionalG'].value = t.sky.g;
    u['sunPosition'].value.copy(this.sunDir);
    this.stars.visible = name === 'night';
    const wasVisible = this.scene.background;
    void wasVisible;
    this.cubeCam.update(this.renderer, this.skyScene);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture);
    this.scene.background = this.cubeRT.texture;
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = t.env;
    this.scene.backgroundIntensity = name === 'night' ? 1 : 0.55;
    this.scene.fog = null;
    this.hemi.color.setHex(t.hemi[0]);
    this.hemi.groundColor.setHex(t.hemi[1]);
    this.hemi.intensity = t.hemi[2];
    this.csm.lightDirection.copy(this.sunDir).negate();
    for (const l of this.csm.lights) {
      l.color.setHex(t.sunColor);
      l.intensity = t.sunIntensity;
    }
    this.renderer.toneMappingExposure = t.exposure;
    for (const cb of this.onLights) cb(t.lightsOn);
  }

  get exposure() {
    return this.tod.exposure;
  }

  update() {
    this.csm.update();
  }

  resize() {
    this.csm.updateFrustums();
  }

  fogColor() {
    return new Color(this.tod.fog);
  }

  /** Small utility for materials that should ignore the sun (e.g. glow). */
  static isMesh(o: unknown): o is Mesh {
    return (o as Mesh).isMesh === true;
  }
}

import {
  AdditiveBlending,
  BufferGeometry,
  Camera,
  Color,
  DataTexture,
  DirectionalLight,
  FogExp2,
  DataUtils,
  EquirectangularReflectionMapping,
  Euler,
  Matrix4,
  CubeCamera,
  Float32BufferAttribute,
  HalfFloatType,
  HemisphereLight,
  Material,
  Mesh,
  PMREMGenerator,
  BackSide,
  CanvasTexture,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderer,
} from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { QualitySettings } from './quality';

export type TimeOfDay = 'day' | 'dusk' | 'night';

interface TodPreset {
  sunDir: [number, number, number];
  skySun: [number, number, number];
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
    sunDir: [0.7, 0.62, 0.22],
    skySun: [0.7, 0.62, 0.22],
    sunColor: 0xfff0dc,
    sunIntensity: 5.6,
    env: 1.25,
    exposure: 1.14,
    hemi: [0xbcd6ff, 0x506038, 0.35],
    lightsOn: false,
    sky: { turbidity: 2.0, rayleigh: 2.4, mie: 0.002, g: 0.7 },
    fog: 0xbfd2e6,
    fogDensity: 0.0011,
  },
  dusk: {
    sunDir: [0.62, 0.11, 0.72],
    skySun: [0.62, 0.11, 0.72],
    sunColor: 0xffa860,
    sunIntensity: 3.0,
    env: 0.55,
    exposure: 1.08,
    hemi: [0x8aa0d0, 0x40382a, 0.28],
    lightsOn: true,
    sky: { turbidity: 6, rayleigh: 2.2, mie: 0.006, g: 0.9 },
    // a cool evening haze (the old salmon fog washed the stands and the skyline out to pink)
    fog: 0x7d7488,
    fogDensity: 0.0008,
  },
  night: {
    sunDir: [0.3, 0.86, 0.2],
    skySun: [0.3, -0.18, -0.6],
    sunColor: 0xfff1de,
    // a night game: the towers do the lighting (see stadiumLights.ts); only a faint moon-blue ambient and a dim moon remain
    sunIntensity: 0.45,
    env: 0.1,
    exposure: 1.2,
    hemi: [0x6f88c0, 0x1c2a20, 0.12],
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
  /** unshadowed stadium fill for dusk (the sun is behind the stands) */
  private fill = new DirectionalLight(0xfff0dc, 0);
  private skyScene = new Scene();
  private sky = new Sky();
  /** the night's stars (scene object: the engine keeps it out of the depth / normal prepass) */
  readonly stars: Points;
  private nightSky: Mesh;
  private cubeRT: WebGLCubeRenderTarget;
  private cubeCam: CubeCamera;
  private pmrem: PMREMGenerator;
  private envRT: ReturnType<PMREMGenerator['fromCubemap']> | null = null;
  private materials = new Set<Material>();
  private onLights: ((on: boolean) => void)[] = [];
  private hdri = new Map<TimeOfDay, { tex: DataTexture; sun: Vector3 } | null>();
  private hdriEnv: ReturnType<PMREMGenerator['fromEquirectangular']> | null = null;
  private hdriToken = 0;
  /** whether a photographic HDRI sky is currently active (else the procedural Sky) */
  hdriActive = false;
  /** desired sun azimuth for the HDRI sun after rotation (sim/scene axes) */
  private static readonly SUN_AZ = new Vector3(0.7, 0, 0.22);

  constructor(
    private scene: Scene,
    private renderer: WebGLRenderer,
    private camera: Camera,
    private q: QualitySettings,
  ) {
    this.hemi = new HemisphereLight(0xffffff, 0x444444, 0.3);
    scene.add(this.hemi);
    this.fill.position.set(0.3, 0.86, 0.2).multiplyScalar(100);
    scene.add(this.fill);
    this.sky.scale.setScalar(50000);
    // clamp the sky's HDR so the sun glare cannot dominate bloom / DoF; the sun itself is the directional light
    this.sky.material.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( min( texColor, vec3( 2.2 ) ), 1.0 );');
    };
    this.skyScene.add(this.sky);
    // night: a dark navy dome with the city's warm glow low on the horizon (in the background cube, so it also lights the night a little)
    this.nightSky = new Mesh(
      new SphereGeometry(40000, 32, 16),
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        uniforms: {},
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `varying vec3 vDir;
          void main(){
            float h = clamp(vDir.y, -0.2, 1.0);
            vec3 zenith = vec3(0.004, 0.007, 0.018), mid = vec3(0.010, 0.016, 0.034), glow = vec3(0.060, 0.042, 0.030);
            vec3 c = mix(mid, zenith, smoothstep(0.05, 0.75, h));
            c = mix(c, glow, (1.0 - smoothstep(-0.02, 0.22, h)) * 0.9);
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    this.nightSky.visible = false;
    this.skyScene.add(this.nightSky);
    // stars are drawn in the scene itself (a few pixels each at any focal length; the 512 px background cube made them squares or blobs);
    // fewer and dimmer toward the horizon, where the city's light washes them out
    const sg = new BufferGeometry();
    const pos: number[] = [];
    const col: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 2600; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      if (u < 0.06 || rnd() > Math.min(1, (u - 0.06) * 2.2)) continue;
      pos.push(Math.cos(th) * s * 600, u * 600, Math.sin(th) * s * 600);
      const b = Math.min(1.6, Math.pow(rnd(), 3) * 1.4 + 0.25);
      const warm = rnd();
      col.push(b * (0.9 + 0.1 * warm), b * 0.95, b * (1.05 - 0.15 * warm));
    }
    sg.setAttribute('position', new Float32BufferAttribute(pos, 3));
    sg.setAttribute('color', new Float32BufferAttribute(col, 3));
    const dot = document.createElement('canvas');
    dot.width = dot.height = 16;
    const g = dot.getContext('2d')!;
    const gr = g.createRadialGradient(8, 8, 0, 8, 8, 8);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 16, 16);
    this.stars = new Points(
      sg,
      new PointsMaterial({ size: 2.4, sizeAttenuation: false, vertexColors: true, map: new CanvasTexture(dot), fog: false, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
    );
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -10;
    this.stars.visible = false;
    scene.add(this.stars);
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
    this.setFarShadowEvery(this.farEvery);
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

  /** Settles when the photographic sky for the current time of day is applied (immediately when only the procedural sky exists). */
  skyReady: Promise<void> = Promise.resolve();

  /** Download and decode the HDRI skies for these times of day ahead of use (they are cached; a missing file is remembered too). */
  preloadSky(names: TimeOfDay[]): Promise<unknown> {
    return Promise.all(names.filter((n) => (n as string) !== 'night').map((n) => this.loadHdri(n)));
  }

  setTimeOfDay(name: TimeOfDay): Promise<void> {
    this.todName = name;
    const t = (this.tod = PRESETS[name]);
    this.sunDir.set(...t.sunDir).normalize();
    const u = this.sky.material.uniforms;
    u['turbidity'].value = t.sky.turbidity;
    u['rayleigh'].value = t.sky.rayleigh;
    u['mieCoefficient'].value = t.sky.mie;
    u['mieDirectionalG'].value = t.sky.g;
    u['sunPosition'].value.set(...t.skySun).normalize();
    this.stars.visible = name === 'night';
    this.sky.visible = name !== 'night';
    this.nightSky.visible = name === 'night';
    const wasVisible = this.scene.background;
    void wasVisible;
    this.cubeCam.update(this.renderer, this.skyScene);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture);
    this.scene.background = this.cubeRT.texture;
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = t.env;
    this.scene.backgroundIntensity = name === 'night' ? 1 : 1.0;
    this.scene.fog = new FogExp2(t.fog, t.fogDensity);
    this.fill.intensity = name === 'dusk' ? 2.2 : 0;
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
    this.hdriActive = false;
    return (this.skyReady = this.applyHdri(name));
  }

  /** Which `sky_<tod>.hdr` files exist (from the `/hdri/index.json` manifest); none when the manifest or files are absent. */
  private static hdriFiles: Promise<Set<string>> | null = null;
  private static availableHdris() {
    return (Environment.hdriFiles ??= fetch(`${import.meta.env.BASE_URL}hdri/index.json`)
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? (r.json() as Promise<string[]>) : []))
      .catch(() => [] as string[])
      .then((l) => new Set(l)));
  }

  private async loadHdri(name: TimeOfDay) {
    if (this.hdri.has(name)) return this.hdri.get(name)!;
    try {
      if (!(await Environment.availableHdris()).has(`sky_${name}.hdr`)) throw new Error('no HDRI'); // procedural sky
      const tex = await new HDRLoader().loadAsync(`${import.meta.env.BASE_URL}hdri/sky_${name}.hdr`);
      tex.mapping = EquirectangularReflectionMapping;
      const data = tex.image.data as Uint16Array;
      const w = tex.image.width, h = tex.image.height;
      // locate the sun (brightest texel), then clamp so the disc cannot swamp bloom / IBL
      let best = 0, bi = 0;
      for (let i = 0; i < w * h; i++) {
        const l = DataUtils.fromHalfFloat(data[i * 4]) + DataUtils.fromHalfFloat(data[i * 4 + 1]) + DataUtils.fromHalfFloat(data[i * 4 + 2]);
        if (l > best) { best = l; bi = i; }
      }
      const cap = name === 'night' ? 12 : 30;
      const capH = DataUtils.toHalfFloat(cap);
      for (let i = 0; i < w * h * 4; i++) if (i % 4 !== 3 && DataUtils.fromHalfFloat(data[i]) > cap) data[i] = capH;
      const u = ((bi % w) + 0.5) / w, v = 1 - (Math.floor(bi / w) + 0.5) / h;
      const az = (u - 0.5) * Math.PI * 2, el = (v - 0.5) * Math.PI;
      const sun = new Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
      tex.needsUpdate = true;
      const r = { tex, sun };
      this.hdri.set(name, r);
      return r;
    } catch {
      this.hdri.set(name, null); // file missing: keep the procedural sky (run `npm run hdri`)
      return null;
    }
  }

  private async applyHdri(name0: TimeOfDay) {
    const name: TimeOfDay = name0;
    const token = ++this.hdriToken;
    if ((name0 as string) === 'night') return; // night keeps the procedural sky + stars (the HDRI options carry unwanted light pollution)
    const h = await this.loadHdri(name);
    if (!h || token !== this.hdriToken) return;
    // rotate the sky so its sun sits on the side of the park we light from
    let sunDir = h.sun.clone();
    const rot = new Euler(0, 0, 0);
    if (name !== 'night') {
      const want = Math.atan2(Environment.SUN_AZ.z, Environment.SUN_AZ.x);
      const have = Math.atan2(h.sun.z, h.sun.x);
      // three samples the sky with the inverse of this rotation, so the sun's azimuth moves by (have - want) -> `want` needs the opposite sign
      rot.y = have - want;
      const el = Math.asin(h.sun.y);
      sunDir = new Vector3(Math.cos(el) * Math.cos(want), h.sun.y, Math.cos(el) * Math.sin(want));
    }
    this.scene.background = h.tex;
    this.scene.backgroundRotation.copy(rot);
    this.scene.environmentRotation.copy(rot);
    this.hdriEnv?.dispose();
    this.hdriEnv = this.pmrem.fromEquirectangular(h.tex);
    this.scene.environment = this.hdriEnv.texture;
    const t = this.tod;
    this.scene.environmentIntensity = name === 'day' ? 1.1 : name === 'dusk' ? 0.7 : 0.12;
    this.scene.backgroundIntensity = name === 'dusk' ? 0.45 : 1.0;
    if (name !== 'night') {
      this.sunDir.copy(sunDir).normalize();
      this.csm.lightDirection.copy(this.sunDir).negate();
      // sun colour/intensity follow elevation
      const el = Math.asin(this.sunDir.y);
      const k = Math.min(1, Math.max(0.15, el / 0.9));
      for (const l of this.csm.lights) {
        l.intensity = t.sunIntensity * (0.55 + 0.45 * k);
        l.color.setRGB(1, 0.72 + 0.28 * k, 0.5 + 0.5 * k);
      }
    }
    this.hdriActive = true;
  }

  get exposure() {
    return this.tod.exposure;
  }

  update() {
    this.csm.update();
    // the star dome travels with the camera (no parallax: they are infinitely far away)
    if (this.stars.visible) this.stars.position.copy((this.camera as unknown as { position: Vector3 }).position);
    if (this.farEvery > 1) {
      // the far cascades are redrawn every n-th frame (their maps stay valid for a moment: they are broad and soft)
      const redraw = this.frame++ % this.farEvery === 0;
      for (let i = 1; i < this.csm.lights.length; i++) this.csm.lights[i].shadow.needsUpdate = redraw;
    }
  }

  private farEvery = 1;
  private frame = 0;

  /** redraw the far shadow cascades only every `n` frames (1 = every frame); the nearest cascade is always redrawn */
  setFarShadowEvery(n: number) {
    this.farEvery = n;
    for (let i = 1; i < this.csm.lights.length; i++) {
      const sh = this.csm.lights[i].shadow;
      sh.autoUpdate = n <= 1;
      sh.needsUpdate = true;
    }
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

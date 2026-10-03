import {
  Camera,
  DepthTexture,
  FramebufferTexture,
  RedFormat,
  UnsignedIntType,
  HalfFloatType,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { QualitySettings } from './quality';

const DofShader = {
  uniforms: {
    tDiffuse: { value: null as unknown },
    tDepth: { value: null as unknown },
    near: { value: 0.1 },
    far: { value: 500 },
    focus: { value: 30 },
    aperture: { value: 0 },
    maxBlur: { value: 0.012 },
    aspect: { value: 1.7 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    #include <common>
    #include <packing>
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform float near, far, focus, aperture, maxBlur, aspect;
    varying vec2 vUv;
    float viewZ(vec2 uv){ return texture2D(tDepth, uv).x; } // metres from the camera (DepthCopyPass)
    // foreground (nearer than the focus) is softened less than the background: an over-the-shoulder subject stays only slightly soft
    float coc(float z){ float c = aperture * abs(1.0 / focus - 1.0 / max(z, 0.05)); if (z < focus) c *= 0.45; return clamp(c, 0.0, maxBlur); }
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      float dz = viewZ(vUv);
      float c = (dz > far * 0.98) ? maxBlur : coc(dz);
      if (aperture <= 0.0 || c < 0.0004) { gl_FragColor = base; return; }
      vec3 acc = base.rgb; float wsum = 1.0;
      const int TAPS = 28;
      for (int i = 1; i <= TAPS; i++) {
        float fi = float(i);
        float r = sqrt(fi / float(TAPS));
        float a = fi * 2.399963;
        vec2 o = vec2(cos(a), sin(a) * aspect) * r;
        vec2 uv = vUv + o * c * vec2(1.0 / aspect, 1.0) * 1.0;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float sz = viewZ(uv);
        float sc = (sz > far * 0.98) ? maxBlur : coc(sz);
        float w = sc >= c * r * 0.75 ? 1.0 : sc / max(c * r * 0.75, 1e-5);
        float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
        w *= 1.0 + 2.5 * smoothstep(1.2, 5.0, lum); // bokeh highlights
        acc += s * w; wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, base.a);
    }`,
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as unknown },
    time: { value: 0 },
    grain: { value: 0.035 },
    vignette: { value: 0.32 },
    saturation: { value: 0.94 },
    contrast: { value: 1.06 },
    aberration: { value: 0.0012 },
    tint: { value: new Vector2(0.0, 0.0) },
    fade: { value: 0 },
    aspect: { value: 1.7 },
    motion: { value: new Vector2(0, 0) },
    tPrev: { value: null as unknown },
    dissolve: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform vec2 motion;
    uniform sampler2D tDiffuse, tPrev; uniform float time, grain, vignette, saturation, contrast, aberration, fade, aspect, dissolve; uniform vec2 tint;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
    void main(){
      vec2 d = vUv - 0.5;
      float r2 = dot(d * vec2(aspect, 1.0), d * vec2(aspect, 1.0));
      vec2 ca = d * aberration * (0.4 + r2 * 3.0);
      vec3 c = vec3(texture2D(tDiffuse, vUv + ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - ca).b);
      // camera-pan motion blur (screen-space direction from camera rotation, 180 degree shutter)
      if (dot(motion, motion) > 1e-8) {
        vec3 acc = c; float ws = 1.0;
        for (int i = 1; i <= 6; i++) {
          float f = float(i) / 6.0 - 0.5;
          acc += texture2D(tDiffuse, vUv + motion * f).rgb; ws += 1.0;
        }
        c = acc / ws;
      }
      // gentle filmic grade: cool shadows, warm highlights
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = (c - 0.5) * contrast + 0.5;
      c += vec3(-0.010, 0.002, 0.014) * (1.0 - smoothstep(0.0, 0.5, l));
      c += vec3(0.014, 0.006, -0.012) * smoothstep(0.55, 1.0, l);
      l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, saturation);
      c += vec3(tint.x, 0.0, tint.y) * 0.02;
      c *= 1.0 - vignette * smoothstep(0.18, 0.95, r2 * 1.7);
      float n = hash(vUv * vec2(1920.0, 1080.0) + fract(time * 7.13) * 91.7) - 0.5;
      c += n * grain * (0.45 + 0.9 * (1.0 - l));
      if (dissolve > 0.0) c = mix(c, texture2D(tPrev, vUv).rgb, dissolve); // the previous picture melting away (display-referred, like c here)
      c = mix(c, vec3(0.0), fade);
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

/**
 * Right after the main render: the scene's own depth (full resolution, every visible part incl. hair, caps, crowd) as metres from the camera,
 * for the depth of field. (The DoF used to read the GTAO prepass depth: half resolution at High and without hair / details, which left sharp
 * halos of background around heads and blurred hair.) One full-screen draw into a half-float red target.
 */
class DepthCopyPass extends Pass {
  readonly target: WebGLRenderTarget;
  private quad: FullScreenQuad;
  private mat: ShaderMaterial;
  constructor(private camera: PerspectiveCamera) {
    super();
    this.needsSwap = false;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RedFormat, depthBuffer: false });
    this.mat = new ShaderMaterial({
      uniforms: { tDepth: { value: null }, near: { value: 0.1 }, far: { value: 500 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `#include <packing>
        uniform sampler2D tDepth; uniform float near, far; varying vec2 vUv;
        void main(){ float d = texture2D(tDepth, vUv).x; gl_FragColor = vec4(d >= 1.0 ? far : -perspectiveDepthToViewZ(d, near, far), 0.0, 0.0, 1.0); }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }
  setSize(w: number, h: number) {
    this.target.setSize(w, h);
  }
  render(renderer: WebGLRenderer, _w: WebGLRenderTarget, readBuffer: WebGLRenderTarget) {
    this.mat.uniforms.tDepth.value = readBuffer.depthTexture;
    this.mat.uniforms.near.value = this.camera.near;
    this.mat.uniforms.far.value = this.camera.far;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }
}

export class PostFX {
  composer: EffectComposer;
  private renderPass: RenderPass;
  ao: GTAOPass;
  private dof: ShaderPass;
  private depthCopy: DepthCopyPass;
  private bloom: UnrealBloomPass;
  private output: OutputPass;
  private grade: ShaderPass;
  private size = new Vector2(1280, 720);
  /** the last picture shown, kept while a dissolve might be needed */
  private prev: FramebufferTexture | null = null;
  private prevSize = new Vector2();
  /** copy every drawn frame into `prev` (the director turns this on during lulls, when a dissolve can be asked for) */
  capture = false;
  private dissolveT = 0;
  private dissolveDur = 0;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    private camera: PerspectiveCamera,
    private q: QualitySettings,
  ) {
    const rt = new WebGLRenderTarget(this.size.x, this.size.y, { type: HalfFloatType, samples: q.msaa });
    // the main pass keeps its depth in a texture (resolved from the multisampled buffer): the depth of field reads it (DepthCopyPass)
    rt.depthTexture = new DepthTexture(this.size.x, this.size.y, UnsignedIntType);
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera as Camera);
    this.ao = new GTAOPass(scene, camera as Camera, this.size.x, this.size.y);
    this.ao.output = GTAOPass.OUTPUT.Default;
    this.ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 12 });
    this.ao.blendIntensity = 0.85;
    this.dof = new ShaderPass(new ShaderMaterial(DofShader));
    this.depthCopy = new DepthCopyPass(camera);
    this.bloom = new UnrealBloomPass(this.size.clone(), 0.14, 0.4, 4.5);
    this.output = new OutputPass();
    this.grade = new ShaderPass(new ShaderMaterial(GradeShader));
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.depthCopy);
    this.composer.addPass(this.ao);
    this.composer.addPass(this.dof);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.composer.addPass(this.grade);
    this.setQuality(q);
    const qs = location.search;
    if (qs.includes('noao')) this.ao.enabled = false;
  }

  /** the composer's passes with names, for the profiler */
  passList() {
    return [
      { name: 'main', pass: this.renderPass },
      { name: 'depth', pass: this.depthCopy },
      { name: 'gtao', pass: this.ao },
      { name: 'dof', pass: this.dof },
      { name: 'bloom', pass: this.bloom },
      { name: 'output', pass: this.output },
      { name: 'grade', pass: this.grade },
    ] as unknown as { name: string; pass: { render: (...a: never[]) => void } }[];
  }

  /** the adaptive controller drops the ambient-occlusion prepass (and with it the depth of field) when the main thread cannot keep up */
  setNoAo(off: boolean) {
    this.noAo = off;
    this.ao.enabled = this.q.ao && !off && !location.search.includes('noao');
    this.dof.enabled = this.q.dof && !off && !location.search.includes('nodof');
    this.depthCopy.enabled = this.dof.enabled;
  }
  private noAo = false;

  setQuality(q: QualitySettings) {
    this.q = q;
    this.ao.enabled = q.ao && !this.noAo && !location.search.includes('noao');
    this.bloom.enabled = q.bloom && !location.search.includes('nobloom');
    this.dof.enabled = q.dof && !this.noAo && !location.search.includes('nodof');
    this.depthCopy.enabled = this.dof.enabled;
    (this.grade.uniforms as Record<string, { value: number }>).grain.value = q.grain ? 0.035 : 0;
    // MSAA changes need a new target
    const rt = this.composer.renderTarget1 as WebGLRenderTarget;
    if (rt.samples !== q.msaa) {
      rt.samples = q.msaa;
      (this.composer.renderTarget2 as WebGLRenderTarget).samples = q.msaa;
      rt.dispose();
      (this.composer.renderTarget2 as WebGLRenderTarget).dispose();
    }
  }

  setSize(w: number, h: number, pixelRatio: number) {
    this.size.set(w, h);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    const aoScale = this.q.aoHalfRes ? 0.5 : 1;
    this.ao.setSize(Math.floor(w * pixelRatio * aoScale), Math.floor(h * pixelRatio * aoScale));
    (this.grade.uniforms as Record<string, { value: number }>).aspect.value = w / h;
    (this.dof.uniforms as Record<string, { value: number }>).aspect.value = w / h;
  }

  /** `focus` in metres from the camera, `aperture` scales blur strength. */
  setFocus(focus: number, aperture: number) {
    const u = this.dof.uniforms as Record<string, { value: unknown }>;
    u.focus.value = focus;
    u.aperture.value = this.q.dof ? aperture * focus * 0.012 : 0;
    u.near.value = this.camera.near;
    u.far.value = this.camera.far;
    u.tDepth.value = this.depthCopy.target.texture;
  }

  /** Screen-space camera motion this frame in uv units (drives the pan motion blur). */
  setMotion(x: number, y: number) {
    (this.grade.uniforms as Record<string, { value: Vector2 }>).motion.value.set(x, y);
  }

  setFade(f: number) {
    (this.grade.uniforms as Record<string, { value: number }>).fade.value = f;
  }

  /** melt from the last drawn picture into the new camera over `seconds` (call on the frame of the cut) */
  startDissolve(seconds: number) {
    if (!this.prev || seconds <= 0) return;
    this.dissolveT = 0;
    this.dissolveDur = seconds;
  }

  get dissolving() {
    return this.dissolveDur > 0;
  }

  render(time: number, dt: number) {
    const u = this.grade.uniforms as Record<string, { value: unknown }>;
    u.time.value = time;
    if (this.dissolveDur > 0 && this.prev) {
      this.dissolveT += dt;
      const k = 1 - this.dissolveT / this.dissolveDur;
      u.tPrev.value = this.prev;
      u.dissolve.value = k > 0 ? k * k * (3 - 2 * k) : 0;
      if (k <= 0) this.dissolveDur = 0;
    } else u.dissolve.value = 0;
    this.composer.render(dt);
    if (this.capture || this.dissolveDur > 0) this.grabFrame();
  }

  private grabFrame() {
    const r = this.composer.renderer;
    const w = r.domElement.width, h = r.domElement.height;
    if (!this.prev || this.prevSize.x !== w || this.prevSize.y !== h) {
      this.prev?.dispose();
      this.prev = new FramebufferTexture(w, h);
      this.prevSize.set(w, h);
    }
    // while the dissolve itself is on screen the copy would hold the blend: keep the picture it started from
    if (this.dissolveDur > 0 && this.dissolveT > 0) return;
    r.copyFramebufferToTexture(this.prev);
  }
}

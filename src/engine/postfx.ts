import {
  Camera,
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
    float viewZ(vec2 uv){ float d = texture2D(tDepth, uv).x; return -perspectiveDepthToViewZ(d, near, far); }
    float coc(float z){ return clamp(aperture * abs(1.0 / focus - 1.0 / max(z, 0.05)), 0.0, maxBlur); }
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
    saturation: { value: 1.08 },
    contrast: { value: 1.06 },
    aberration: { value: 0.0012 },
    tint: { value: new Vector2(0.0, 0.0) },
    fade: { value: 0 },
    aspect: { value: 1.7 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float time, grain, vignette, saturation, contrast, aberration, fade, aspect; uniform vec2 tint;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
    void main(){
      vec2 d = vUv - 0.5;
      float r2 = dot(d * vec2(aspect, 1.0), d * vec2(aspect, 1.0));
      vec2 ca = d * aberration * (0.4 + r2 * 3.0);
      vec3 c = vec3(texture2D(tDiffuse, vUv + ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - ca).b);
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
      c = mix(c, vec3(0.0), fade);
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

export class PostFX {
  composer: EffectComposer;
  private renderPass: RenderPass;
  ao: GTAOPass;
  private dof: ShaderPass;
  private bloom: UnrealBloomPass;
  private output: OutputPass;
  private grade: ShaderPass;
  private size = new Vector2(1280, 720);
  private aoActive = false;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    private camera: PerspectiveCamera,
    private q: QualitySettings,
  ) {
    const rt = new WebGLRenderTarget(this.size.x, this.size.y, { type: HalfFloatType, samples: q.msaa });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera as Camera);
    this.ao = new GTAOPass(scene, camera as Camera, this.size.x, this.size.y);
    this.ao.output = GTAOPass.OUTPUT.Default;
    this.ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 12 });
    this.ao.blendIntensity = 0.85;
    this.dof = new ShaderPass(new ShaderMaterial(DofShader));
    this.bloom = new UnrealBloomPass(this.size.clone(), 0.16, 0.45, 3.2);
    this.output = new OutputPass();
    this.grade = new ShaderPass(new ShaderMaterial(GradeShader));
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.ao);
    this.composer.addPass(this.dof);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.composer.addPass(this.grade);
    this.setQuality(q);
  }

  setQuality(q: QualitySettings) {
    this.q = q;
    this.ao.enabled = q.ao;
    this.bloom.enabled = q.bloom;
    this.dof.enabled = q.dof && q.ao;
    this.aoActive = q.ao;
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
    u.aperture.value = this.q.dof ? aperture : 0;
    u.near.value = this.camera.near;
    u.far.value = this.camera.far;
    u.tDepth.value = this.aoActive ? this.ao.depthTexture : null;
  }

  setFade(f: number) {
    (this.grade.uniforms as Record<string, { value: number }>).fade.value = f;
  }

  render(time: number, dt: number) {
    (this.grade.uniforms as Record<string, { value: number }>).time.value = time;
    this.composer.render(dt);
  }
}

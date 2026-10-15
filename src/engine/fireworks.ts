/**
 * Fireworks over centre field after a home-team home run (the volley in `fireworksPlan.ts`, which the sound plays too: before this
 * the crowd heard the bursts and nothing was in the sky). One `Points` draw call with a small shader: every spark's path is computed
 * on the GPU from its birth time, launch point and velocity (drag + gravity), so the CPU only writes a volley's attributes once.
 * Sparks are HDR-bright and additive (the bloom pass makes them glow); the object is hidden whenever nothing is in the air, so the
 * game costs nothing extra the rest of the time. Out of the AO / DoF prepass (the engine adds `points` to `gbufferHidden`).
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, type PerspectiveCamera } from 'three';
import { ASCENT, FIREWORK_VOLLEY, type Shell } from './fireworksPlan';

const TRAIL = 140; // dense enough to read as one rising streak, not a dotted line
const SPARKS = 320;
const GLITTER = 90;
const PER_SHELL = TRAIL + SPARKS + GLITTER;
const CAP = PER_SHELL * FIREWORK_VOLLEY.length * 2; // two volleys in flight at once at most
const LONGEST = 3.4;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export class Fireworks {
  readonly points: Points;
  private geo = new BufferGeometry();
  private mat: ShaderMaterial;
  private time = 0;
  private next = 0;
  private until = -1;
  private a: Record<'origin' | 'vel' | 'color', Float32Array> & { t: Float32Array };

  constructor() {
    this.a = { origin: new Float32Array(CAP * 3), vel: new Float32Array(CAP * 3), color: new Float32Array(CAP * 3), t: new Float32Array(CAP * 4) };
    this.geo.setAttribute('position', new BufferAttribute(this.a.origin, 3));
    this.geo.setAttribute('aVel', new BufferAttribute(this.a.vel, 3));
    this.geo.setAttribute('aColor', new BufferAttribute(this.a.color, 3));
    // birth time, life, size (m), kind (0 trail, 1 spark, 2 glitter)
    this.geo.setAttribute('aT', new BufferAttribute(this.a.t, 4));
    for (let i = 0; i < CAP; i++) this.a.t[i * 4] = -1e9;
    this.mat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 500 } },
      vertexShader: /* glsl */ `
        attribute vec3 aVel; attribute vec3 aColor; attribute vec4 aT;
        uniform float uTime; uniform float uScale;
        varying vec3 vColor; varying float vA;
        void main() {
          float t = uTime - aT.x;
          if (t < 0.0 || t > aT.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
          const float k = 1.25;
          vec3 p = position + aVel * (1.0 - exp(-k * t)) / k;
          p.y -= 3.2 * t * t;
          float u = t / aT.y;
          float fade = aT.w > 1.5 ? (0.5 + 0.5 * sin(t * 90.0 + position.x * 7.0)) * (1.0 - u) : pow(1.0 - u, 1.4);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aT.z * uScale / -mv.z, 2.0, 64.0);
          vColor = aColor * (aT.w > 1.5 ? 6.0 : aT.w > 0.5 ? 3.2 : 2.5);
          vA = fade;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor; varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          gl_FragColor = vec4(vColor * vA * (1.0 - r) * (1.0 - r), 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(this.geo, this.mat);
    this.points.name = 'Fireworks';
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 5;
  }

  /** the volley for a home-team home run: shells burst `shell.delay` seconds from now */
  launch(seed = 1) {
    const r = rng(seed * 2654435761);
    for (const sh of FIREWORK_VOLLEY) this.shell(sh, this.time + sh.delay, r);
    this.until = Math.max(this.until, this.time + Math.max(...FIREWORK_VOLLEY.map((s) => s.delay)) + LONGEST);
    this.points.visible = true;
  }

  private put(o: [number, number, number], v: [number, number, number], c: [number, number, number], t0: number, life: number, size: number, kind: number) {
    const i = this.next;
    this.next = (this.next + 1) % CAP;
    this.a.origin.set(o, i * 3);
    this.a.vel.set(v, i * 3);
    this.a.color.set(c, i * 3);
    this.a.t.set([t0, life, size, kind], i * 4);
  }

  private shell(sh: Shell, burstT: number, r: () => number) {
    const L = sh.launch, B = sh.burst;
    // the rising shell: a short fading trail along its path
    for (let j = 0; j < TRAIL; j++) {
      const f = j / TRAIL;
      const t0 = burstT - ASCENT + f * ASCENT;
      this.put([L.x + (B.x - L.x) * f, L.y + (B.y - L.y) * f, L.z + (B.z - L.z) * f], [0, 0, 0], [1, 0.75, 0.45], t0, 0.45, 1.1, 0);
    }
    // the burst: a peony, sparks spread over a sphere with a little speed scatter
    for (let j = 0; j < SPARKS; j++) {
      const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      const sp = sh.speed * (0.82 + r() * 0.3);
      const c = sh.colors[j % sh.colors.length];
      this.put([B.x, B.y, B.z], [s * Math.cos(a) * sp, z * sp, s * Math.sin(a) * sp], c, burstT, 2.0 + r() * 0.9, 1.3, 1);
    }
    // the crackle: white glitter flashing inside the shell while it falls (the sound's crackle is the same 0.35-2 s after the bang)
    for (let j = 0; j < GLITTER; j++) {
      const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      const t = 0.35 + r() * 1.5;
      const rad = (sh.speed / 1.25) * (1 - Math.exp(-1.25 * t)) * (0.6 + r() * 0.4);
      this.put([B.x + s * Math.cos(a) * rad, B.y + z * rad - 3.2 * t * t, B.z + s * Math.sin(a) * rad], [0, -1, 0], [1, 0.95, 0.85], burstT + t, 0.14, 0.9, 2);
    }
    for (const k of ['position', 'aVel', 'aColor', 'aT']) (this.geo.getAttribute(k) as BufferAttribute).needsUpdate = true;
  }

  /** advance (live time, not replays); `viewportH` = the drawing buffer's height in pixels */
  update(dt: number, camera: PerspectiveCamera, viewportH: number) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    this.mat.uniforms.uScale.value = viewportH * 0.5 * camera.projectionMatrix.elements[5];
    if (this.points.visible && this.time > this.until) this.points.visible = false;
  }
}

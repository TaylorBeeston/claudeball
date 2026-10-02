/**
 * The stadium's light towers as real lights. At dusk and night every tower carries a SpotLight aimed at the field (warm white, a cone with a
 * soft penumbra and physical falloff); the few most useful ones cast shadows, so each player throws several shadows and the field reads as lit by
 * the towers, a few weak wide spots spill light on the stands, and additive cones (haze beams with a little noise) show the light in the air.
 * Quality sets how many spots exist and how many cast shadows; the adaptive scaler can ask for fewer shadows when frames get slow.
 */
import {
  AdditiveBlending,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  Object3D,
  Scene,
  ShaderMaterial,
  SpotLight,
  Vector3,
} from 'three';
import type { TimeOfDay } from './environment';
import type { QualityName } from './quality';

export interface LightBudget {
  /** tower spots lit */
  spots: number;
  /** of those, how many cast shadows */
  shadows: number;
  /** shadow map resolution */
  mapSize: number;
  /** weak wide spots spilling light on the stands */
  spill: number;
  /** haze cones */
  cones: boolean;
}

export const LIGHT_BUDGETS: Record<QualityName, LightBudget> = {
  low: { spots: 3, shadows: 0, mapSize: 512, spill: 0, cones: false },
  medium: { spots: 6, shadows: 2, mapSize: 1024, spill: 0, cones: true },
  high: { spots: 6, shadows: 3, mapSize: 1024, spill: 3, cones: true },
  ultra: { spots: 8, shadows: 4, mapSize: 2048, spill: 4, cones: true },
};

/** per time of day: tower intensity (candela per spot at the reference tower distance) and haze strength */
export const TOD_LIGHT: Record<TimeOfDay, { intensity: number; haze: number }> = {
  day: { intensity: 0, haze: 0 },
  dusk: { intensity: 9000, haze: 0.45 },
  night: { intensity: 34000, haze: 1 },
};

/** most shadow-casting spots a GPU with `units` texture units per fragment shader can take next to the sun's cascades and the materials' maps */
export function unitsToShadowLimit(units: number): number {
  return units >= 32 ? 4 : units >= 24 ? 3 : units >= 16 ? 2 : 0;
}

/** Where tower `i` aims: towers behind the plate light the deep field, the outfield ones the infield, so the pools overlap in the middle. */
export function aimPoint(tower: Vector3, i: number, out = new Vector3()): Vector3 {
  // three bands of the park so the pools overlap: infield, shallow outfield, deep outfield (the side the tower stands on aims across the field)
  const bands = [24, 58, 92];
  const z = tower.z < 25 ? bands[1 + (i % 2)] : bands[i % 3];
  const across = -Math.sign(tower.x || 1) * (z > 70 ? 28 : 14);
  return out.set(across, 0, z);
}

/** Order towers by usefulness for shadows: those standing most to the side of the diamond cast the most readable crossing shadows. */
export function shadowOrder(towers: Vector3[]): number[] {
  return towers
    .map((t, i) => ({ i, score: Math.abs(Math.atan2(t.x, t.z - 25)) + (t.z < 25 ? 0.2 : 0) }))
    .sort((a, b) => b.score - a.score)
    .map((o) => o.i);
}

/** per-spot intensity factors: the casters carry `CAST_SHARE` of the total light of `n` spots (all equal when none casts) */
export const CAST_SHARE = 0.92;
export function spotWeights(n: number, nCast: number): { cast: number; plain: number } {
  if (n <= 0 || nCast <= 0) return { cast: 1, plain: 1 };
  if (nCast >= n) return { cast: 1, plain: 1 };
  return { cast: (CAST_SHARE * n) / nCast, plain: ((1 - CAST_SHARE) * n) / (n - nCast) };
}

const coneMaterial = () =>
  new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: false,
    uniforms: { uTime: { value: 0 }, uStrength: { value: 0 }, uColor: { value: new Vector3(1, 0.93, 0.8) } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW; varying float vT;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        vT = 1.0 - uv.y; // cone uv.y is 1 at the apex (the lamps) and 0 at the base (the field end)
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uStrength; uniform vec3 uColor;
      varying vec3 vN; varying vec3 vW; varying float vT;
      float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
      void main(){
        vec3 v = normalize(cameraPosition - vW);
        float edge = pow(abs(dot(normalize(vN), v)), 1.6);          // soft edges: the cone fades out toward its silhouette
        float along = smoothstep(0.0, 0.12, vT) * (1.0 - smoothstep(0.55, 1.0, vT)); // bright near the lamps, gone before the ground
        float n = 0.65 + 0.35 * noise(vW * 0.045 + vec3(0.0, uTime * 0.05, 0.0));
        float a = edge * along * n * uStrength;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });

export class StadiumLights {
  readonly group = new Group();
  private towers: Vector3[] = [];
  private spots: SpotLight[] = [];
  private spill: SpotLight[] = [];
  private cones: Mesh[] = [];
  private coneMat = coneMaterial();
  private tod: TimeOfDay = 'day';
  private budget: LightBudget = LIGHT_BUDGETS.high;
  /** extra reduction requested by the adaptive scaler (shadows first) */
  private shadowCap = 99;
  private unitCap = 99;
  readonly hidden: Object3D[] = [];

  constructor(private scene: Scene) {
    this.group.name = 'stadium-lights';
    scene.add(this.group);
  }

  setTowers(towers: Vector3[]) {
    this.towers = towers.map((t) => t.clone());
    this.rebuild();
  }

  setQuality(q: QualityName) {
    this.budget = LIGHT_BUDGETS[q];
    this.rebuild();
  }

  setTimeOfDay(t: TimeOfDay) {
    this.tod = t;
    this.apply();
  }

  /**
   * Every shadow-casting spot is one more sampler in every lit material's shader (plus the sun's cascades and the material's own maps), and a
   * GPU with only 16 texture units cannot link them all: fewer shadow spots there.
   */
  setTextureUnits(units: number) {
    const cap = unitsToShadowLimit(units);
    if (cap === this.unitCap) return;
    this.unitCap = cap;
    this.apply();
  }

  /** the adaptive scaler asks for fewer shadow-casting spots when frames are slow (0 = none) */
  setShadowCap(n: number) {
    if (n === this.shadowCap) return;
    this.shadowCap = n;
    this.apply();
  }

  update(time: number) {
    this.coneMat.uniforms.uTime.value = time;
  }

  private rebuild() {
    for (const l of [...this.spots, ...this.spill]) {
      l.shadow.map?.dispose();
      l.removeFromParent();
      l.target.removeFromParent();
    }
    for (const c of this.cones) {
      c.geometry.dispose();
      c.removeFromParent();
    }
    this.spots = [];
    this.spill = [];
    this.cones = [];
    this.hidden.length = 0;
    const towers = this.towers;
    if (!towers.length) return;
    // which towers get a spot: spread around the park when the budget is smaller than the number of towers
    const order = [...towers.keys()];
    const use = pick(order, Math.min(this.budget.spots, towers.length));
    const shadowOrderIdx = shadowOrder(towers).filter((i) => use.includes(i));
    use.forEach((ti, k) => {
      const l = new SpotLight(0xfff0dc, 0, 0, 0.62, 0.65, 2);
      l.position.copy(towers[ti]);
      aimPoint(towers[ti], ti, l.target.position);
      l.userData.tower = ti;
      l.userData.rank = shadowOrderIdx.indexOf(ti);
      l.shadow.mapSize.set(this.budget.mapSize, this.budget.mapSize);
      l.shadow.camera.near = 30;
      l.shadow.camera.far = 260;
      l.shadow.bias = -0.0004;
      l.shadow.normalBias = 0.05;
      l.shadow.radius = 3;
      this.group.add(l, l.target);
      this.spots.push(l);
      void k;
    });
    // weak wide spots spilling light on the stands across the field
    pick(order, Math.min(this.budget.spill, towers.length)).forEach((ti) => {
      const l = new SpotLight(0xffe6c8, 0, 0, 1.05, 0.9, 2);
      l.position.copy(towers[ti]);
      l.target.position.set(-towers[ti].x * 0.6, 8, Math.max(20, 60 - towers[ti].z * 0.5));
      this.group.add(l, l.target);
      this.spill.push(l);
    });
    if (this.budget.cones) {
      use.forEach((ti) => {
        const from = towers[ti];
        const to = aimPoint(from, ti);
        const dir = to.clone().sub(from);
        const len = dir.length() * 0.92;
        const radius = Math.tan(0.62) * len * 0.75;
        const g = new ConeGeometry(radius, len, 28, 1, true).translate(0, -len / 2, 0).rotateX(0); // apex at the origin, opening along -Y
        const m = new Mesh(g, this.coneMat);
        m.position.copy(from);
        m.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), dir.clone().normalize());
        m.frustumCulled = false;
        m.renderOrder = 5;
        this.group.add(m);
        this.cones.push(m);
        this.hidden.push(m);
      });
    }
    this.apply();
  }

  private apply() {
    const t = TOD_LIGHT[this.tod];
    // distance from a tower to its aim point scales the candela so the pools keep about the same illuminance whatever the park size
    const cap = Math.min(this.budget.shadows, this.shadowCap, this.unitCap);
    const nCast = t.intensity > 0 ? this.spots.filter((l) => l.userData.rank >= 0 && l.userData.rank < cap).length : 0;
    const w = spotWeights(this.spots.length, nCast);
    for (const l of this.spots) {
      const d = l.position.distanceTo(l.target.position);
      const wantShadow = nCast > 0 && l.userData.rank >= 0 && l.userData.rank < cap;
      // the shadow-casting towers carry most of the light so the shadows they throw read clearly; the total stays the same when the adaptive scaler drops them
      l.intensity = t.intensity * ((d * d) / (110 * 110)) * (wantShadow ? w.cast : w.plain);
      l.distance = 0;
      l.visible = t.intensity > 0;
      if (l.castShadow !== wantShadow) {
        l.castShadow = wantShadow;
        if (!wantShadow) {
          l.shadow.map?.dispose();
          l.shadow.map = null as never;
        }
        this.invalidateMaterials();
      }
    }
    for (const l of this.spill) {
      const d = l.position.distanceTo(l.target.position);
      l.intensity = t.intensity * 0.1 * ((d * d) / (110 * 110));
      l.visible = t.intensity > 0;
    }
    this.coneMat.uniforms.uStrength.value = 0.1 * t.haze;
    for (const c of this.cones) c.visible = t.haze > 0;
  }

  private invalidateMaterials() {
    this.scene.traverse((o) => {
      const m = (o as Mesh).material;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
  }

  dispose() {
    this.rebuild();
    this.group.removeFromParent();
  }
}

/** `n` indices spread evenly over `order` */
function pick(order: number[], n: number): number[] {
  if (n >= order.length) return [...order];
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(order[Math.floor(((k + 0.5) * order.length) / n) % order.length]);
  return out;
}


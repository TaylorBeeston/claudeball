/**
 * What lies beyond the stands, so the park does not float in a void (aerial and stadium B-roll, deep fly balls, the menu fly-around):
 *   - the ground: a concrete plaza round the bowl, parking lots (stall lines, parked cars), a ring road, then lawns and tree canopy, all drawn
 *     procedurally in one shader in world space (no texture to tile or download); at night the lots get sodium light pools;
 *   - a city skyline: a few hundred instanced boxes 500-900 m out, concrete / glass facades with window grids, windows lit at night.
 * Two draw calls, no shadows. Both clamp their depth to just inside the far plane, so the directors' changing far distance (200-900 m) never
 * clips them: anything beyond the far plane is drawn behind everything else, which is where it is anyway.
 */
import { BoxGeometry, Group, RingGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';

/** the middle of the park (the bowl is roughly centred here) */
const CX = 0, CZ = 30;

const FAR_CLAMP = /* glsl */ `
#include <project_vertex>
gl_Position.z = min(gl_Position.z, gl_Position.w * 0.99995);`;

const NOISE = /* glsl */ `
float sHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), f.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), f.x), f.y); }
`;

export interface Surroundings {
  group: Group;
  /** 0 = day, ~0.5 = dusk, 1 = night: lit windows and lot lights */
  setNight(n: number): void;
}

export function buildSurroundings(register: (m: MeshStandardMaterial, patch: (s: unknown) => void) => MeshStandardMaterial): Surroundings {
  const group = new Group();
  group.name = 'surroundings';
  const uNight = { value: 0 };

  // ---- the ground -----------------------------------------------------------------------------------------------------------
  const groundPatch = (s: unknown) => {
    const sh = s as { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string };
    sh.uniforms.uNight = uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      .replace('#include <project_vertex>', FAR_CLAMP);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSWorld;\nuniform float uNight;\n${NOISE}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 w = vSWorld.xz;
        vec2 c = w - vec2(${CX.toFixed(1)}, ${CZ.toFixed(1)});
        float r = length(c);
        float px = max(fwidth(w.x), fwidth(w.y)); // metres per pixel: fades detail that would alias
        vec3 col;
        float glow = 0.0;
        vec3 asphalt = vec3(0.105, 0.105, 0.11) * (0.9 + 0.2 * sNoise(w * 0.3));
        if (r < 128.0) {
          // concrete plaza with expansion joints
          col = vec3(0.27, 0.265, 0.25) * (0.9 + 0.14 * sNoise(w * 0.5));
          vec2 j = abs(fract(w / 4.0) - 0.5);
          col *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.03 + px * 0.5, min(j.x, j.y))) * (1.0 - smoothstep(0.1, 0.4, px));
        } else if (r < 410.0) {
          // parking lots: rows of 2.6 x 5.5 m stalls along x, a 7 m aisle every two rows, blocks split by lanes
          col = asphalt;
          vec2 q = w + vec2(1000.0);
          float rowW = 2.0 * 5.5 + 7.0;
          float inRow = mod(q.y, rowW);
          float stallX = mod(q.x, 2.6);
          float lane = step(mod(q.x, 78.0), 8.0);
          float isStall = (1.0 - lane) * (inRow < 11.0 ? 1.0 : 0.0);
          float detail = 1.0 - smoothstep(0.15, 0.6, px);
          float edge = 1.0 - smoothstep(0.0, 0.08 + px, min(stallX, 2.6 - stallX));
          col = mix(col, vec3(0.5), edge * isStall * detail * 0.6);
          // a parked car in most stalls
          vec2 cell = vec2(floor(q.x / 2.6), floor(q.y / rowW) * 2.0 + step(5.5, inRow));
          float h = sHash(cell);
          vec2 inCar = vec2(stallX - 1.3, mod(inRow, 5.5) - 2.75);
          float car = isStall * step(0.4, h) * (1.0 - smoothstep(0.85, 0.85 + px, abs(inCar.x))) * (1.0 - smoothstep(2.15, 2.15 + px, abs(inCar.y)));
          float hue = sHash(cell + 7.0);
          vec3 paint = hue < 0.16 ? vec3(0.6) : hue < 0.36 ? vec3(0.04) : hue < 0.58 ? vec3(0.2) : hue < 0.68 ? vec3(0.3, 0.05, 0.04) : hue < 0.8 ? vec3(0.06, 0.1, 0.22) : vec3(0.36, 0.36, 0.38);
          // the windscreen / roof reads darker than the bonnet
          paint *= 1.0 - 0.45 * step(-0.6, inCar.y) * step(inCar.y, 0.3);
          col = mix(col, paint, car);
          // light poles every 36 x 54 m: sodium pools at night
          vec2 pole = mod(q, vec2(36.0, 54.0)) - vec2(18.0, 27.0);
          glow = exp(-dot(pole, pole) / 90.0);
          // landscaped edges near the plaza and the road
          float verge = smoothstep(128.0, 131.0, r) * (1.0 - smoothstep(134.0, 137.0, r)) + smoothstep(400.0, 404.0, r);
          col = mix(col, vec3(0.13, 0.2, 0.08), verge);
        } else if (r < 430.0) {
          // ring road with a dashed yellow centre line
          col = asphalt * 0.9;
          float a = atan(c.y, c.x) * 420.0;
          float dash = step(0.5, fract(a / 9.0));
          col = mix(col, vec3(0.6, 0.48, 0.1), (1.0 - smoothstep(0.12, 0.12 + px, abs(r - 420.0))) * dash * (1.0 - smoothstep(0.3, 0.8, px)));
          glow = 0.35 * (1.0 - smoothstep(0.0, 6.0, abs(r - 420.0)));
        } else {
          // lawns, tree canopy and city blocks
          float t = sNoise(w * 0.035) * 0.6 + sNoise(w * 0.11) * 0.4;
          vec3 lawn = vec3(0.14, 0.22, 0.08) * (0.85 + 0.3 * sNoise(w * 0.4));
          vec3 trees = vec3(0.06, 0.11, 0.04) * (0.8 + 0.4 * sNoise(w * 0.9));
          col = mix(lawn, trees, smoothstep(0.48, 0.6, t));
          vec2 blk = mod(w + vec2(1000.0), vec2(120.0, 95.0));
          float street = step(min(blk.x, blk.y), 14.0);
          float town = smoothstep(560.0, 640.0, r);
          col = mix(col, mix(vec3(0.3, 0.29, 0.28) * (0.8 + 0.4 * sHash(floor((w + 1000.0) / vec2(120.0, 95.0)))), asphalt, street), town);
          glow = town * street * 0.5;
        }
        diffuseColor.rgb = col;
        vSGlow = glow;`,
      )
      .replace('#include <common>', '#include <common>\nfloat vSGlow = 0.0;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.55, 0.22) * vSGlow * uNight * 0.12;`,
      );
  };
  const groundMat = register(new MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), groundPatch);
  groundMat.customProgramCacheKey = () => 'cb-surround-ground';
  // many small rings, not a fan of long triangles: the far-plane depth clamp is per vertex, so a triangle reaching past the far plane gets a
  // wrong (too near) depth across its whole area and would cover the field; with 23 m rings only the outermost band is affected
  const ground = new Mesh(new RingGeometry(0.01, 1500, 96, 64).rotateX(-Math.PI / 2), groundMat);
  ground.position.set(CX, -0.08, CZ);
  ground.receiveShadow = true;
  ground.name = 'SurroundGround';
  group.add(ground);

  // ---- the skyline ----------------------------------------------------------------------------------------------------------
  const box = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const cityPatch = (s: unknown) => {
    const sh = s as { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string };
    sh.uniforms.uNight = uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBLocal;\nvarying vec3 vBNormal;\nvarying float vBSeed;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 bScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vBLocal = position * bScale;
        vBNormal = normal;
        vBSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);`,
      )
      .replace('#include <project_vertex>', FAR_CLAMP);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vBLocal;\nvarying vec3 vBNormal;\nvarying float vBSeed;\nuniform float uNight;\n${NOISE}\nfloat bWin = 0.0;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float side = 1.0 - step(0.5, abs(vBNormal.y));
          float u = abs(vBNormal.x) > 0.5 ? vBLocal.z : vBLocal.x;
          vec2 cell = vec2(u / 3.4, vBLocal.y / 3.7);
          vec2 f = fract(cell);
          float px = max(fwidth(cell.x), fwidth(cell.y));
          float win = side * (1.0 - smoothstep(0.32, 0.32 + px, abs(f.x - 0.5))) * (1.0 - smoothstep(0.3, 0.3 + px, abs(f.y - 0.55))) * step(3.0, vBLocal.y);
          float glass = step(0.62, vBSeed);
          vec3 wall = glass > 0.5 ? vec3(0.2, 0.26, 0.32) : mix(vec3(0.46, 0.44, 0.41), vec3(0.62, 0.6, 0.56), fract(vBSeed * 7.3));
          vec3 pane = vec3(0.07, 0.09, 0.12) + vec3(0.05, 0.07, 0.1) * sHash(floor(cell)) + vec3(0.06, 0.08, 0.1) * smoothstep(0.3, 1.0, vBLocal.y / 120.0);
          diffuseColor.rgb = mix(wall, pane, win * (1.0 - smoothstep(0.4, 1.2, px)) + win * 0.5 * smoothstep(0.4, 1.2, px));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16), 1.0 - side);
          bWin = win * step(0.76, sHash(floor(cell) + vBSeed * 31.0));
          bWin = mix(bWin, 0.16 * side * step(3.0, vBLocal.y), smoothstep(0.5, 1.5, px)); // far away: the lit share as a glow
        }`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.78, 0.5) * bWin * uNight * 0.7;');
  };
  const cityMat = register(new MeshStandardMaterial({ roughness: 0.7, metalness: 0.05 }), cityPatch);
  cityMat.customProgramCacheKey = () => 'cb-surround-city';
  let seed = 31;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mats: Matrix4[] = [];
  const q = new Quaternion(), up = new Vector3(0, 1, 0), p = new Vector3(), sc = new Vector3();
  for (let i = 0; i < 420; i++) {
    const a = rnd() * Math.PI * 2;
    // denser downtown beyond centre field, sparser elsewhere
    const downtown = Math.cos(a - Math.PI / 2) > 0.55;
    if (!downtown && rnd() < 0.45) continue;
    const r = 680 + rnd() * 380;
    const h = downtown ? 18 + Math.pow(rnd(), 2.4) * 95 : 8 + Math.pow(rnd(), 3) * 40;
    p.set(CX + Math.cos(a) * r, 0, CZ + Math.sin(a) * r);
    q.setFromAxisAngle(up, Math.round(rnd() * 3) * (Math.PI / 2));
    sc.set(18 + rnd() * 34, h, 18 + rnd() * 34);
    mats.push(new Matrix4().compose(p.clone(), q.clone(), sc.clone()));
  }
  const city = new InstancedMesh(box, cityMat, mats.length);
  mats.forEach((m, i) => city.setMatrixAt(i, m));
  city.instanceMatrix.needsUpdate = true;
  city.computeBoundingSphere();
  city.castShadow = false;
  city.receiveShadow = false;
  city.name = 'Skyline';
  group.add(city);

  return {
    group,
    setNight: (n) => {
      uNight.value = n;
    },
  };
}

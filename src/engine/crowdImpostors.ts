/**
 * The stands' spectators as instanced billboards: one alpha-tested quad per fan, textured from the crowd atlas (`crowdAtlas.ts`: people rendered
 * from the player model), one draw call per azimuth sector. Each quad turns about the vertical toward the camera, is anchored at the fan's feet and
 * picks its cell (person x pose) in the vertex shader:
 *   - seated most of the time, now and then the second seated frame (clapping, leaning);
 *   - `uExcite` (0..1, the crowd's excitement from the game) stands a growing share up, cheering (alternating the two standing frames, a small hop);
 *   - `uWave` (azimuth, width, strength): fans near the moving azimuth stand with their arms up - the wave going round the park.
 * Lighting is the standard material's (sun, cascaded shadows, tower spots, sky light) on a normal that faces the camera and tilts up a little,
 * so a crowd in shade or under the night lights reads like the rest of the stands.
 */
import {
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { WINDOW, type CrowdAtlas } from './crowdAtlas';

export interface CrowdUniforms {
  uTime: { value: number };
  uExcite: { value: number };
  uAnimate: { value: number };
}

export interface ImpostorCrowd {
  group: Group;
  /** (re)place the fans: one transform per seat (position = the floor under the fan's feet, rotation = the way the seat faces, uniform scale) */
  setSeats(mats: Matrix4[], sectors: number): void;
  setAtlas(a: CrowdAtlas): void;
  setDensity(d: number): void;
  setVisible(v: boolean): void;
  /** the wave: x = azimuth (rad, about the point (0, 30) like the sectors), y = angular half-width, z = strength 0..1 */
  wave: Vector3;
  /** alpha-to-coverage (soft cut-out edges) when the frame buffer is multisampled */
  setMsaa(on: boolean): void;
  readonly meshes: InstancedMesh[];
}

/** azimuth of a world position about the middle of the park (the same reference the stands' sectors use) */
export const crowdAzimuth = (x: number, z: number) => Math.atan2(x, z - 30);

export function buildImpostorCrowd(register: (m: MeshStandardMaterial, patch: (s: unknown) => void) => MeshStandardMaterial, uniforms: CrowdUniforms): ImpostorCrowd {
  const group = new Group();
  group.name = 'crowd-impostors';
  const extra = {
    uAtlasGrid: { value: new Vector3(16, 8, 4) }, // cols, rows, poses
    uCell: { value: new Vector3(1 / 16, 1 / 8, 4) }, // cellU, cellV, people per row
    uPeople: { value: 32 },
    uWave: { value: new Vector3(0, 0.12, 0) },
  };
  const patch = (s: unknown) => {
    const shader = s as { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string };
    Object.assign(shader.uniforms, uniforms, extra);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime, uExcite, uAnimate, uPeople;
        uniform vec3 uAtlasGrid, uCell, uWave;
        attribute vec4 aFan; // person, mirror (+-1), random a, random b
        varying float vFanShade;`,
      )
      // the cell: which person in which pose
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vec3 bbPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float bbScale = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
        float ra = aFan.z, rb = aFan.w;
        float t = uTime * uAnimate;
        // seated: now and then the second seated frame (clapping / leaning), for a few seconds
        float pose = step(0.82, fract(t * (0.05 + ra * 0.07) + rb * 7.0));
        // excitement stands a share up (the keenest first); they cheer, alternating the two standing frames
        float stand = step(1.0 - pow(uExcite, 1.5) * 0.92, ra * 0.98 + 0.01);
        // the wave: fans near the moving azimuth stand with their arms up
        float az = atan(bbPos.x, bbPos.z - 30.0);
        float dw = abs(mod(az - uWave.x + 3.14159265, 6.2831853) - 3.14159265);
        float inWave = uWave.z * (1.0 - smoothstep(uWave.y * 0.6, uWave.y, dw));
        float cheer = max(stand * uAnimate, step(0.5, inWave));
        float flip = step(0.5, fract(t * (1.6 + rb * 1.4) + ra * 5.0));
        pose = mix(pose, 2.0 + (inWave > 0.5 ? 1.0 : flip), cheer);
        float person = aFan.x;
        float col = mod(person, uCell.z) * uAtlasGrid.z + pose;
        float row = floor(person / uCell.z);
        vec2 cuv = vec2(aFan.y < 0.0 ? 1.0 - uv.x : uv.x, uv.y);
        #ifdef USE_MAP
          vMapUv = vec2((col + cuv.x) * uCell.x, 1.0 - (row + 1.0 - cuv.y) * uCell.y);
        #endif
        float hop = cheer * uAnimate * (inWave > 0.5 ? 0.0 : 0.06 * abs(sin(t * (6.0 + rb * 3.0) + ra * 20.0)));
        vFanShade = 0.86 + 0.28 * rb;`,
      )
      // a cylindrical billboard: x across the camera's view, y up, anchored at the fan's feet
      .replace(
        '#include <begin_vertex>',
        `vec3 bbTo = cameraPosition - (modelMatrix * vec4(bbPos, 1.0)).xyz;
        bbTo.y = 0.0;
        bbTo = normalize(bbTo + vec3(1e-5, 0.0, 0.0));
        vec3 bbRight = vec3(bbTo.z, 0.0, -bbTo.x);
        vec3 bbWorld = (modelMatrix * vec4(bbPos, 1.0)).xyz + (bbRight * position.x + vec3(0.0, position.y + hop, 0.0)) * bbScale + bbTo * 0.12;
        vec3 transformed = vec3(0.0);`,
      )
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 0.0, 1.0);')
      .replace(
        '#include <defaultnormal_vertex>',
        `vec3 transformedNormal = normalize((viewMatrix * vec4(normalize(cameraPosition - (modelMatrix * vec4(bbPos, 1.0)).xyz) * vec3(1.0, 0.0, 1.0) + vec3(0.0, 0.45, 0.0), 0.0)).xyz);`,
      )
      .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(bbWorld, 1.0);\ngl_Position = projectionMatrix * mvPosition;')
      .replace('#include <worldpos_vertex>', 'vec4 worldPosition = vec4(bbWorld, 1.0);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFanShade;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vFanShade;');
  };
  const mat = register(
    new MeshStandardMaterial({ color: new Color(1, 1, 1), roughness: 0.92, metalness: 0, alphaTest: 0.5, side: DoubleSide }),
    patch,
  );
  mat.customProgramCacheKey = () => 'cb-crowd-impostor';
  // the quad covers the atlas cell's window of the person's own space (feet at y = 0)
  const quad = new PlaneGeometry(WINDOW.x1 - WINDOW.x0, WINDOW.y1 - WINDOW.y0);
  quad.translate((WINDOW.x0 + WINDOW.x1) / 2, (WINDOW.y0 + WINDOW.y1) / 2, 0);
  const meshes: InstancedMesh[] = [];
  let totals: number[] = [];
  let density = 1;
  let people = 32;
  let seats: Matrix4[] = [];
  let sectors = 12;
  let visible = true;

  const build = () => {
    for (const m of meshes) {
      m.removeFromParent();
      m.geometry.dispose();
      m.dispose();
    }
    meshes.length = 0;
    totals = [];
    const buckets: Matrix4[][] = Array.from({ length: sectors }, () => []);
    const p = new Vector3();
    for (const m of seats) {
      p.setFromMatrixPosition(m);
      buckets[Math.min(sectors - 1, Math.floor(((crowdAzimuth(p.x, p.z) + Math.PI) / (Math.PI * 2)) * sectors))].push(m);
    }
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (const list of buckets) {
      if (!list.length) continue;
      // shuffled, so lowering the density thins the stands evenly instead of emptying the last rows
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      const g = quad.clone();
      const fan = new Float32Array(list.length * 4);
      for (let i = 0; i < list.length; i++) {
        fan[i * 4] = Math.floor(rnd() * people) % people;
        fan[i * 4 + 1] = rnd() < 0.5 ? -1 : 1;
        fan[i * 4 + 2] = rnd();
        fan[i * 4 + 3] = rnd();
      }
      g.setAttribute('aFan', new InstancedBufferAttribute(fan, 4));
      const im = new InstancedMesh(g, mat, list.length);
      list.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.boundingSphere!.radius += 2.6;
      im.castShadow = false;
      im.receiveShadow = true;
      im.visible = visible;
      im.name = 'CrowdImpostors';
      group.add(im);
      meshes.push(im);
      totals.push(list.length);
    }
    applyDensity();
  };
  const applyDensity = () => meshes.forEach((m, i) => (m.count = Math.max(0, Math.floor(totals[i] * density))));

  return {
    group,
    meshes,
    wave: extra.uWave.value,
    setMsaa(on) {
      if (mat.alphaToCoverage === on) return;
      mat.alphaToCoverage = on;
      mat.needsUpdate = true;
    },
    setSeats(mats, n) {
      seats = mats;
      sectors = n;
      build();
    },
    setAtlas(a) {
      mat.map = a.texture;
      mat.needsUpdate = true;
      extra.uAtlasGrid.value.set(a.cols, a.rows, a.poses);
      extra.uCell.value.set(a.cellU, a.cellV, Math.floor(a.cols / a.poses));
      extra.uPeople.value = a.people;
      if (a.people !== people) {
        people = a.people;
        if (seats.length) build();
      }
    },
    setDensity(d) {
      density = d;
      applyDensity();
    },
    setVisible(v) {
      visible = v;
      for (const m of meshes) m.visible = v;
    },
  };
}

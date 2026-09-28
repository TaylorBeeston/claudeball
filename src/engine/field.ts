import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Shape,
  Vector2,
} from 'three';
import { BASES, DIM, wallDistance } from './dims';
import type { Environment } from './environment';

/** GLSL for the procedural ground: mowing stripes, infield skin, chalk, warning track. */
const GROUND_FRAG_HEAD = /* glsl */ `
varying vec3 vWPos;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vn(p); p = p * 2.03 + 17.0; a *= 0.5; } return s; }
float wallDist(float phi){
  float a = min(1.0, abs(phi) / 0.785398);
  float b = ${DIM.polesDist.toFixed(3)} + (${DIM.centerDist.toFixed(3)} - ${DIM.polesDist.toFixed(3)}) * (1.0 - a * a);
  float n = exp(-pow((phi + 0.32) / 0.14, 2.0)) * 5.5;
  return b + n + (phi > 0.0 ? 2.5 * a : 0.0);
}
float sm(float d, float w){ return 1.0 - smoothstep(-w, w, d); }
float sdBox(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
vec3 gSurf; float gRough; float gDirt; vec2 gBump;
void groundSurface(vec3 wp, float viewDist){
  vec2 p = wp.xz;
  float ax = abs(p.x);
  float z = p.y;
  float aa = 0.05 + viewDist * 0.0012;
  float fine = 1.0 - smoothstep(18.0, 70.0, viewDist);
  float mid = 1.0 - smoothstep(60.0, 260.0, viewDist);

  // --- masks ---------------------------------------------------------------
  float dSkin = max(length(p - vec2(0.0, ${DIM.moundDist.toFixed(3)})) - ${DIM.skinRadius.toFixed(3)}, (ax - z) - 1.3);
  float dHome = length(p - vec2(0.0, -0.4)) - 6.6;
  float baseCut = min(min(length(vec2(ax, z) - vec2(19.4, 19.4)) - 4.4, length(p - vec2(0.0, 38.8)) - 4.4), length(p - vec2(0.0, 18.44)) - 3.6);
  float dGrassIn = ax + abs(z - 19.4) - 17.0;
  float dGI = max(dGrassIn, -baseCut);
  float dDirt = max(min(min(dSkin, dHome), baseCut), -dGI);

  float phi = atan(-p.x, z);
  float rAll = length(p);
  float wallR = wallDist(phi);
  float dEdgeWall = wallR - rAll;
  float dEdgeFoul = 14.5 - (ax - z) * 0.70711;
  float dEdgeBack = (1.0 - length(vec2(ax / 19.8, z / 22.0))) * 19.0;
  float dEdge = abs(phi) < 0.785398 ? dEdgeWall : (z > 0.0 ? dEdgeFoul : dEdgeBack);
  float dTrack = ${DIM.warningTrack.toFixed(2)} - dEdge;  // < 0 inside the warning track band -> dirt

  float trackM = smoothstep(-0.12, 0.12, dTrack);
  float dirtM = max(sm(dDirt, aa * 2.0), trackM);
  float outside = smoothstep(-0.05, 0.05, dEdge);

  // --- grass -------------------------------------------------------------------
  float patchN = fbm(p * 0.12);
  vec3 g0 = vec3(0.036, 0.135, 0.026);
  vec3 g1 = vec3(0.068, 0.2, 0.03);
  vec3 grass = mix(g0, g1, patchN);
  // outfield: straight bands toward center; infield: diamond checker
  float band = step(0.5, fract(p.x / 4.4));
  float cx = mod(floor((p.x + z) / 3.3) + floor((z - p.x) / 3.3), 2.0);
  float inFieldPat = sm(dGrassIn + 2.0, 0.3);
  float mow = mix(band, cx, inFieldPat);
  grass *= mix(mix(0.78, 1.2, mow), mix(0.88, 1.12, mow), inFieldPat);
  // blades and clumps (fade with distance to stay stable)
  float b1 = vn(p * 46.0), b2 = vn(p * 140.0 + 3.7), b3 = vn(vec2(p.x * 260.0, p.y * 30.0));
  float blade = 0.55 * b1 + 0.3 * b2 + 0.15 * b3;
  grass *= mix(1.0, 0.72 + 0.62 * blade, fine * 0.85 + mid * 0.15);
  grass = mix(grass, grass * vec3(1.15, 1.0, 0.75), smoothstep(0.55, 0.9, fbm(p * 0.35 + 9.0)) * 0.7); // dry patches
  gBump = vec2(b1 - vn(p * 46.0 + vec2(0.05, 0.0)), b1 - vn(p * 46.0 + vec2(0.0, 0.05))) * fine * 6.0;

  // --- dirt ----------------------------------------------------------------------
  float dn = fbm(p * 0.9) * 0.6 + vn(p * 26.0) * 0.25 + vn(p * 90.0) * 0.15 * fine;
  vec3 dirt = mix(vec3(0.20, 0.098, 0.05), vec3(0.32, 0.17, 0.09), dn);
  // packed/wet darker patches by the mound, plate and bases
  float wet = max(sm(length(p - vec2(0.0, 18.0)) - 2.4, 1.0), max(sm(length(p) - 2.2, 1.0), sm(baseCut + 3.5, 1.0)));
  dirt *= 1.0 - 0.22 * wet;
  // raked rings on the track
  float rake = vn(vec2(rAll * 1.6, phi * 40.0));
  dirt *= mix(1.0, 0.86 + 0.28 * rake, trackM * fine);
  // grass edge darkening where turf meets dirt
  vec3 dirtCol = dirt;
  grass *= mix(0.6, 1.0, smoothstep(0.0, 0.45, max(dDirt, 0.0)));

  vec3 col = mix(grass, dirtCol, dirtM);

  // --- chalk ----------------------------------------------------------------------
  float dl = abs(ax - z) * 0.70711 - 0.0762;
  float foulLine = sm(dl, aa) * step(0.0, z) * step(z, 105.0);
  vec2 bq = vec2(ax - 0.99, z);
  float box = 1.0 - smoothstep(0.0, aa * 1.5, abs(sdBox(bq, vec2(0.61, 0.915))) - 0.026);
  // running lane (last 45 ft, 3 ft outside the baseline)
  float lane = sm(abs((ax - z) * 0.70711 - 0.9 - 0.0381) - 0.0381, aa) * step(z, 14.0) * step(1.0, z) * 0.0;
  float chalk = max(max(foulLine, box), lane) * outside;
  chalk *= 0.82 + 0.18 * vn(p * 60.0);
  col = mix(col, vec3(0.78, 0.78, 0.74), chalk * 0.95);

  // ambient occlusion-ish darkening near the wall, and beyond the wall
  col *= mix(0.62, 1.0, smoothstep(0.0, 2.2, dEdge));
  col = mix(col, vec3(0.012), 1.0 - outside);

  gSurf = col;
  gRough = mix(0.88, 0.97, dirtM) - 0.06 * mow * (1.0 - dirtM);
  gDirt = dirtM;
}
`;

export function createGroundMaterial(env: Environment): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  return env.register(mat, (s) => {
    const shader = s as { vertexShader: string; fragmentShader: string };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GROUND_FRAG_HEAD}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ngroundSurface(vWPos, length(vViewPosition));\ndiffuseColor.rgb = gSurf;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nnormal = normalize(normal + (viewMatrix * vec4(gBump.x, 0.0, gBump.y, 0.0)).xyz * 0.035 * (1.0 - gDirt * 0.6));',
      );
  });
}

export function buildField(env: Environment): Group {
  const g = new Group();
  g.name = 'field';
  const ground = createGroundMaterial(env);

  const plane = new Mesh(new CircleGeometry(520, 96).rotateX(-Math.PI / 2), ground);
  plane.receiveShadow = true;
  plane.name = 'ground';
  g.add(plane);

  // pitcher's mound: 10 in crown, smooth shoulders
  const prof: Vector2[] = [];
  const R = DIM.moundRadius, H = DIM.moundHeight;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const r = t * R;
    const h = t < 0.42 ? H : H * (0.5 + 0.5 * Math.cos(((t - 0.42) / 0.58) * Math.PI));
    prof.push(new Vector2(r, h - 0.0005));
  }
  prof.reverse();
  const mound = new Mesh(new LatheGeometry(prof, 48), ground);
  mound.position.set(0, 0.0015, DIM.moundDist - 0.4);
  mound.receiveShadow = true;
  mound.castShadow = false;
  g.add(mound);

  const white = env.register(new MeshStandardMaterial({ color: 0xf2f0e8, roughness: 0.55 }));
  const rubber = new Mesh(new BoxGeometry(DIM.rubberLen, 0.03, DIM.rubberWid), white);
  rubber.position.set(0, DIM.moundHeight + 0.006, DIM.moundDist);
  rubber.castShadow = rubber.receiveShadow = true;
  g.add(rubber);

  // home plate: pentagon, front edge toward the mound
  const w = DIM.plateWidth / 2;
  const s = new Shape();
  s.moveTo(-w, 0.216);
  s.lineTo(w, 0.216);
  s.lineTo(w, 0);
  s.lineTo(0, -0.216);
  s.lineTo(-w, 0);
  s.closePath();
  const plateGeo = new ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: false });
  plateGeo.rotateX(Math.PI / 2); // shape (x, y) -> (x, z); extrude downward
  const plate = new Mesh(plateGeo, white);
  plate.position.set(0, 0.03, 0);
  plate.scale.z = -1; // sim: front edge is +z (toward the mound)
  plate.material = white;
  plate.receiveShadow = true;
  g.add(plate);

  const bagGeo = new BoxGeometry(DIM.baseSize, 0.08, DIM.baseSize);
  for (const b of BASES) {
    const bag = new Mesh(bagGeo, white);
    bag.position.set(b.x, 0.04, b.z);
    bag.rotation.y = Math.PI / 4;
    bag.castShadow = bag.receiveShadow = true;
    g.add(bag);
  }

  // foul poles
  const yellow = env.register(new MeshStandardMaterial({ color: 0xf6c400, roughness: 0.5, emissive: 0x2a2000 }));
  for (const sgn of [-1, 1]) {
    const r = wallDistance(Math.PI / 4);
    const pole = new Mesh(new CylinderGeometry(0.09, 0.09, 24, 10), yellow);
    pole.position.set(sgn * r * Math.SQRT1_2, 12, r * Math.SQRT1_2);
    pole.castShadow = true;
    g.add(pole);
  }
  return g;
}

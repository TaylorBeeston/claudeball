/**
 * Scene census: what is in the scene and what each puppet draws (visible meshes, materials, triangles, morph targets, shadow casters).
 *   npx tsx tools/perf/census.ts [--preset high] [--url http://...] [--no-build]
 * Prints a table to stdout (and JSON to tools/perf/results/census.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, build, launchChrome, sleep, startPreview, applyDesktopViewport } from './lib';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

async function main() {
  let base = opt('url', '');
  let stop = () => {};
  if (!base) {
    build(argv.includes('--no-build'));
    const s = await startPreview();
    base = s.url;
    stop = s.stop;
  }
  const chrome = await launchChrome({});
  try {
    const page = await chrome.ctx.newPage();
    const cdp = await chrome.ctx.newCDPSession(page);
    await applyDesktopViewport(cdp, 1920, 1080);
    await page.addInitScript('window.__name = (f) => f;'); // tsx/esbuild keepNames helper used inside evaluate() callbacks
    await page.goto(`${base}?autostart=1&noaudio=1&seed=15&quality=${opt('preset', 'high')}&bench=1&scenes=wide&frames=100000`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __bench?: unknown }).__bench !== undefined, null, { timeout: 180000 });
    await sleep(4000);
    const data = await page.evaluate(() => {
      type Obj = import('three').Object3D;
      const e = (window as unknown as { engine: { scene: Obj; players: { puppets: Map<string, { root: Obj; meshes?: unknown[] }> } } }).engine;
      const visibleChain = (o: Obj | null): boolean => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
      const rows: Record<string, number | string>[] = [];
      const summary: Record<string, { meshes: number; tris: number; casters: number; morph: number; skinned: number }> = {};
      const sections: Record<string, { meshes: number; tris: number; casters: number; instanced: number; materials: Set<string> }> = {};
      const triOf = (m: import('three').Mesh) => { const g = m.geometry; return (g.index ? g.index.count : g.attributes.position.count) / 3; };
      // per puppet
      let pi = 0;
      for (const [id, p] of e.players.puppets) {
        p.root.traverse((o) => {
          const m = o as import('three').Mesh;
          if (!m.isMesh || !visibleChain(m)) return;
          const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as import('three').MeshStandardMaterial;
          const tris = triOf(m);
          const key = m.name.replace(/_\d+$/, '');
          const s = (summary[key] ??= { meshes: 0, tris: 0, casters: 0, morph: 0, skinned: 0 });
          s.meshes++; s.tris += tris; if (m.castShadow) s.casters++; if (m.morphTargetInfluences?.length) s.morph++; if ((m as import('three').SkinnedMesh).isSkinnedMesh) s.skinned++;
          if (pi === 0) rows.push({ name: m.name, material: mat?.name ?? '', tris, caster: m.castShadow ? 'yes' : '', morphs: m.morphTargetInfluences?.length ?? 0, skinned: (m as import('three').SkinnedMesh).isSkinnedMesh ? 'yes' : '', transparent: mat?.transparent ? 'yes' : '', maps: ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'].filter((k) => (mat as unknown as Record<string, unknown>)?.[k]).join(',') });
        });
        pi++;
        void id;
      }
      // the rest of the scene by top-level group
      const roots = e.scene.children;
      for (const r of roots) {
        const s = (sections[r.name || r.type] ??= { meshes: 0, tris: 0, casters: 0, instanced: 0, materials: new Set() });
        r.traverse((o) => {
          const m = o as import('three').Mesh;
          if (!m.isMesh || !visibleChain(m)) return;
          s.meshes++;
          s.tris += triOf(m) * ((m as import('three').InstancedMesh).isInstancedMesh ? (m as import('three').InstancedMesh).count : 1);
          if (m.castShadow) s.casters++;
          if ((m as import('three').InstancedMesh).isInstancedMesh) s.instanced++;
          for (const mt of Array.isArray(m.material) ? m.material : [m.material]) s.materials.add(mt.name || mt.uuid);
        });
      }
      // shadow casters that fall inside each shadow-casting light's frustum, by scene group (what each shadow pass would submit)
      const THREE_Frustum = (e.scene as unknown as { constructor: unknown }).constructor && (window as unknown as { __three?: unknown }).__three;
      void THREE_Frustum;
      const perLight: Record<string, Record<string, number>> = {};
      const cam = (window as unknown as { engine: { camera: import('three').Camera } }).engine.camera;
      let li = 0;
      e.scene.traverse((o) => {
        const l = o as import('three').DirectionalLight;
        if (!(l as unknown as { isLight?: boolean }).isLight || !l.castShadow || !l.visible) return;
        const sc = l.shadow.camera;
        sc.updateMatrixWorld(true);
        const fr = new (cam.projectionMatrix.constructor as new () => import('three').Matrix4)();
        fr.multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse);
        const planes = (() => { const m = fr.elements; const P: number[][] = []; for (const [a, sgn] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]] as const) { const r = [m[3] + sgn * m[a], m[7] + sgn * m[a + 4], m[11] + sgn * m[a + 8], m[15] + sgn * m[a + 12]]; const n = Math.hypot(r[0], r[1], r[2]); P.push(r.map((x) => x / n)); } return P; })();
        const counts: Record<string, number> = {};
        const groupOf = (m: Obj) => { let g = m; while (g.parent && g.parent !== e.scene) g = g.parent; return g.name || g.type; };
        e.scene.traverse((q) => {
          const m = q as import('three').Mesh;
          if (!m.isMesh || !m.castShadow || !visibleChain(m)) return;
          if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
          const sk = m as import('three').SkinnedMesh;
          const bs = (sk.isSkinnedMesh && sk.boundingSphere ? sk.boundingSphere : m.geometry.boundingSphere)!;
          const c = bs.center.clone().applyMatrix4(m.matrixWorld);
          const r = bs.radius * m.matrixWorld.getMaxScaleOnAxis();
          for (const pl of planes) if (pl[0] * c.x + pl[1] * c.y + pl[2] * c.z + pl[3] < -r) return;
          if (!m.layers.test(cam.layers)) return;
          const g = groupOf(m);
          counts[g] = (counts[g] ?? 0) + 1;
        });
        perLight[`${li++}:${l.type}`] = counts;
      });
      return {
        shadowCastersPerLight: perLight,
        puppets: e.players.puppets.size,
        firstPuppetMeshes: rows,
        perKind: summary,
        sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, { ...v, materials: v.materials.size }])),
        lights: (() => { let n = 0, c = 0; e.scene.traverse((o) => { const l = o as import('three').Light; if (l.isLight && l.visible) { n++; if (l.castShadow) c++; } }); return { visible: n, casting: c }; })(),
      };
    });
    fs.mkdirSync(path.join(ROOT, 'tools/perf/results'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'tools/perf/results/census.json'), JSON.stringify(data, null, 1));
    console.log(`puppets: ${data.puppets}; lights ${JSON.stringify(data.lights)}`);
    console.log('\nfirst puppet: visible meshes');
    console.table(data.firstPuppetMeshes);
    console.log('\nall puppets, by mesh kind (count / tris / casters / morph / skinned)');
    console.table(Object.fromEntries(Object.entries(data.perKind).sort((a, b) => b[1].meshes - a[1].meshes)));
    console.log('\nshadow casters inside each light frustum (by group)');
    console.table(data.shadowCastersPerLight);
    console.log('\nscene groups');
    console.table(data.sections);
  } finally {
    await chrome.close();
    stop();
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

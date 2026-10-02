/**
 * Soft contact shadows under every person on the field: one instanced quad per player with a radial falloff. The sun's cascades and the tower
 * spots give the long shadows; this is the small dark pool right under the cleats that anchors a player to the grass, which stays visible
 * at night and in the shade of the stands where the cascades fade out. One draw call, no per-player cost beyond a matrix.
 */
import { CanvasTexture, DynamicDrawUsage, InstancedMesh, LinearFilter, Matrix4, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector3 } from 'three';

export class ContactShadows {
  readonly mesh: InstancedMesh;
  private m = new Matrix4();
  private q = new Quaternion();
  private p = new Vector3();
  private s = new Vector3();
  private zero = new Matrix4().makeScale(0, 0, 0);

  constructor(capacity = 96) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
      gr.addColorStop(0, 'rgba(0,0,0,0.85)');
      gr.addColorStop(0.45, 'rgba(0,0,0,0.42)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
    }
    const tex = new CanvasTexture(c);
    tex.minFilter = LinearFilter;
    const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.name = 'contact_shadow';
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, capacity);
    this.mesh.name = 'ContactShadows';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
  }

  /** place one shadow per standing person (`feet`: scene positions with the ground height in y; `radius` per person scales with his height) */
  update(feet: Iterable<{ x: number; y: number; z: number; r?: number }>) {
    let n = 0;
    const cap = this.mesh.instanceMatrix.count;
    for (const f of feet) {
      if (n >= cap) break;
      const r = f.r ?? 0.5;
      this.p.set(f.x, f.y + 0.015, f.z);
      this.s.set(r * 2.3, 1, r * 1.9);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get visible() {
    return this.mesh.visible;
  }

  set visible(v: boolean) {
    this.mesh.visible = v;
  }
}

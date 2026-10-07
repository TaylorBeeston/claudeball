/**
 * The ball kids' folding chairs down the lines. The stadium files have none, so a seated kid used to sit on thin air: a chair is put where each kid
 * is first seen sitting (`ballkid_sit`, standing still), facing the way he faces, and stays there while he runs after a ball.
 * The seat top is at `KID_SEAT_TOP` (the `ballkid_sit` clip puts the seat of the shorts ~0.325 m above the root, which is the ground below the seat centre).
 * One merged geometry, one draw call per chair.
 */
import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameState } from './types';

export const KID_SEAT_TOP = 0.33;
const SEAT_W = 0.42;
const SEAT_D = 0.38;

let shared: { geo: BufferGeometry; mat: MeshStandardMaterial } | null = null;

/** chair geometry in the kid's frame: +Z = the way he faces, seat centred over the origin */
export function chairGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const t = 0.03;
  // seat slab, back rest (behind the seat, leaning back a little), four tube legs, two back uprights
  parts.push(new BoxGeometry(SEAT_W, t, SEAT_D).translate(0, KID_SEAT_TOP - t / 2, 0));
  parts.push(new BoxGeometry(SEAT_W, 0.2, 0.02).rotateX(-0.12).translate(0, KID_SEAT_TOP + 0.3, -SEAT_D / 2 - 0.03));
  const leg = (x: number, z: number, h: number, y0 = 0) => parts.push(new CylinderGeometry(0.011, 0.011, h, 6).translate(x, y0 + h / 2, z));
  for (const x of [-SEAT_W / 2 + 0.02, SEAT_W / 2 - 0.02]) {
    leg(x, SEAT_D / 2 - 0.03, KID_SEAT_TOP - t);
    leg(x, -SEAT_D / 2 + 0.01, KID_SEAT_TOP + 0.42);
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  for (const p of parts) p.dispose();
  return g;
}

export class KidChairs {
  readonly group = new Group();
  private placed = new Map<string, Mesh>();

  constructor() {
    this.group.name = 'KidChairs';
  }

  update(state: GameState): void {
    for (const p of state.players) {
      if (p.role !== 'ballkid' || p.anim !== 'ballkid_sit' || this.placed.has(p.id)) continue;
      if (Math.hypot(p.vel.x, p.vel.z) > 0.05) continue;
      shared ??= { geo: chairGeometry(), mat: new MeshStandardMaterial({ color: 0x1d3b2a, roughness: 0.55, metalness: 0.35 }) };
      const m = new Mesh(shared.geo, shared.mat);
      m.name = `KidChair_${p.id}`;
      m.position.set(p.pos.x, p.pos.y, p.pos.z);
      m.rotation.y = p.facing;
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      this.placed.set(p.id, m);
    }
  }

  /** a new game: the chairs are placed again from where its kids sit */
  reset(): void {
    for (const m of this.placed.values()) this.group.remove(m);
    this.placed.clear();
  }
}

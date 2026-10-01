/** The on-deck batter's practice bat (origin = knob, +Y = barrel, like the model's `Bat_Grip`) with a weighted donut slid up the barrel. */
import { CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, TorusGeometry } from 'three';

let shared: { bat: CylinderGeometry; knob: SphereGeometry; ring: TorusGeometry; wood: MeshStandardMaterial; rubber: MeshStandardMaterial } | null = null;

export function makeOnDeckBat(withoutDonut: boolean): Group {
  shared ??= {
    bat: new CylinderGeometry(0.034, 0.012, 0.86, 12).translate(0, 0.43, 0),
    knob: new SphereGeometry(0.02, 8, 6),
    ring: new TorusGeometry(0.056, 0.02, 8, 18).rotateX(Math.PI / 2),
    wood: new MeshStandardMaterial({ color: 0xc9a06a, roughness: 0.55 }),
    rubber: new MeshStandardMaterial({ color: 0x151515, roughness: 0.8 }),
  };
  const g = new Group();
  g.name = 'OnDeck_Bat';
  const bat = new Mesh(shared.bat, shared.wood);
  const knob = new Mesh(shared.knob, shared.wood);
  for (const m of [bat, knob]) {
    m.castShadow = true;
    g.add(m);
  }
  if (!withoutDonut) {
    const ring = new Mesh(shared.ring, shared.rubber);
    ring.position.y = 0.52;
    ring.castShadow = true;
    g.add(ring);
  }
  return g;
}

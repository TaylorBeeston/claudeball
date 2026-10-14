/**
 * The home-team home-run fireworks, shared by the sound (`audio/cues.ts`: one burst sound per shell) and the picture (`fireworks.ts`):
 * a short volley of three shells over centre field, launched from behind the stands, bursting `delay` seconds after the ball clears
 * the fence (the PA's fanfare starts at 1.2 s). Positions in sim / scene axes (metres; +Z centre field, +X third base).
 */
export interface Shell {
  /** seconds after the `homeRun` event that the shell bursts */
  delay: number;
  burst: { x: number; y: number; z: number };
  /** where it was fired from (behind the centre-field stands) */
  launch: { x: number; y: number; z: number };
  /** spark colours, linear RGB 0..1 */
  colors: [number, number, number][];
  /** spark speed m/s (the burst's radius is about speed / drag) */
  speed: number;
}

export const FIREWORK_VOLLEY: readonly Shell[] = [
  { delay: 1.6, burst: { x: 0, y: 92, z: 150 }, launch: { x: 0, y: 20, z: 168 }, colors: [[1, 0.62, 0.12], [1, 0.42, 0.05]], speed: 46 },
  { delay: 2.3, burst: { x: -42, y: 80, z: 140 }, launch: { x: -30, y: 20, z: 162 }, colors: [[1, 0.1, 0.12], [1, 0.85, 0.75]], speed: 38 },
  { delay: 3.0, burst: { x: 42, y: 84, z: 140 }, launch: { x: 30, y: 20, z: 162 }, colors: [[0.15, 0.35, 1], [0.75, 0.85, 1]], speed: 40 },
];

/** seconds a shell takes from launch to burst */
export const ASCENT = 0.9;

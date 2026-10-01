/**
 * Touch and fullscreen support: a tap on the game shows the on-screen controls, page zoom / pull-to-refresh gestures are blocked,
 * fullscreen toggles where the browser has it. One-finger orbit and pinch zoom of the free camera come from three's OrbitControls
 * (the canvas has `touch-action: none`).
 */
import type { Engine } from '../engine/engine';

export class TouchControls {
  private playing = false;
  private down: { x: number; y: number; t: number } | null = null;

  constructor(private root: HTMLElement, private engine: Engine, private act: { onMenu(): void }) {
    const canvas = engine.renderer.domElement;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || !this.playing) return;
      // a tap (short, barely moved): show the controls; drags belong to the free camera
      if (performance.now() - d.t < 350 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 10) this.engine.hud?.pokeControls();
    });
    // iOS Safari: stop the page-level pinch zoom
    for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false } as AddEventListenerOptions);
    void this.act;
  }

  setPlaying(on: boolean) {
    this.playing = on;
  }

  get fullscreenSupported() {
    return !!document.fullscreenEnabled || !!(document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled;
  }

  /** Enter / leave fullscreen; returns whether it is fullscreen afterwards (best effort). */
  async toggleFullscreen(): Promise<boolean> {
    try {
      const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => Promise<void> };
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      if (document.fullscreenElement || d.webkitFullscreenElement) {
        await (document.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
        return false;
      }
      await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
      return true;
    } catch {
      return false;
    }
  }
}

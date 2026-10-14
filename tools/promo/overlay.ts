/**
 * The promo's typography layer: drawn per frame on a transparent canvas in Chrome (Anton, the display face the jerseys use, for the
 * big type; Roboto Condensed for the small print; the HUD's gold and navy, the loading screen's baseball), saved as PNGs and laid over
 * the footage by ffmpeg, so a text change never re-renders a shot.
 *
 * `drawOverlay` runs in the page: it must stay self-contained (no imports, no module-level helpers).
 */
export type Overlay =
  | { k: 'fill'; t0: number; t1: number; color: string; a0: number; a1: number }
  | { k: 'flash'; t: number; dur?: number; color?: string }
  | { k: 'title'; t0: number; t1: number }
  | { k: 'tagline'; t0: number; t1: number; lines: string[]; step?: number }
  | { k: 'caption'; t0: number; t1: number; text: string; sub?: string; side?: 'left' | 'right' }
  | { k: 'stat'; t0: number; t1: number; value: string; label: string; side?: 'left' | 'right' }
  | { k: 'quote'; t0: number; t1: number; who: string; role: string; text: string }
  | { k: 'phone'; t0: number; t1: number; rect: [number, number, number, number] }
  | { k: 'endcard'; t0: number; t1: number };

export const GOLD = '#ffcf4a';
export const NAVY = '#0a0c12';

/** draw every element active at time t (seconds) into a cleared W x H canvas */
export function drawOverlay(ctx: CanvasRenderingContext2D, els: Overlay[], t: number, W: number, H: number): boolean {
  const U = Math.min(W, H) / 1080; // 1 unit = 1 px at 1080p
  const portrait = H > W;
  const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const easeOut = (u: number) => 1 - Math.pow(1 - clamp(u), 3);
  const easeIn = (u: number) => Math.pow(clamp(u), 3);
  const back = (u: number) => {
    u = clamp(u);
    const c = 1.9;
    return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2);
  };
  const GOLD = '#ffcf4a';
  const NAVY = '#0a0c12';
  const DISPLAY = '"Anton", Impact, sans-serif';
  const SMALL = '"Roboto Condensed", "Liberation Sans Narrow", Arial, sans-serif';
  let drew = false;

  const tracked = (text: string, x: number, y: number, spacing: number, align: 'left' | 'center' | 'right' = 'left') => {
    // letter-spaced text (canvas letterSpacing where it exists)
    const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    c.letterSpacing = `${spacing}px`;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    c.letterSpacing = '0px';
  };

  const ball = (cx: number, cy: number, r: number, rot: number) => {
    // the loading screen's baseball: white with red stitches
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 18 * U;
    ctx.fillStyle = '#f4f4f0';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#d63a30';
    ctx.lineWidth = r * 0.085;
    ctx.lineCap = 'round';
    const s = r / 32;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * 18 * s, -20 * s);
      ctx.bezierCurveTo(sx * 8 * s, -10 * s, sx * 8 * s, 10 * s, sx * 18 * s, 20 * s);
      ctx.stroke();
      ctx.lineWidth = r * 0.06;
      for (let k = -2; k <= 2; k++) {
        const yy = k * 7 * s;
        const xx = sx * (11.5 + Math.abs(k) * 1.4) * s;
        ctx.beginPath();
        ctx.moveTo(xx - sx * 3.2 * s, yy - 1.2 * s * Math.sign(k || 1) * 0);
        ctx.lineTo(xx + sx * 3.2 * s, yy);
        ctx.stroke();
      }
      ctx.lineWidth = r * 0.085;
    }
    ctx.restore();
  };

  /** the wordmark: ball + CLAUDE (white) BALL (gold), centred at (cx, cy), cap height `size` */
  const wordmark = (cx: number, cy: number, size: number, alpha: number, glow: number, ballRot: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${size}px ${DISPLAY}`;
    ctx.textBaseline = 'middle';
    const a = 'CLAUDE', b = 'BALL';
    const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    c.letterSpacing = `${size * 0.02}px`;
    const wa = ctx.measureText(a).width, wb = ctx.measureText(b).width;
    const r = size * 0.36;
    const gap = size * 0.16;
    const total = r * 2 + gap + wa + wb;
    let x = cx - total / 2;
    ball(x + r, cy, r, ballRot);
    x += r * 2 + gap;
    ctx.textAlign = 'left';
    if (glow > 0) {
      ctx.shadowColor = `rgba(255, 207, 74, ${0.55 * glow})`;
      ctx.shadowBlur = size * 0.35 * glow;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(a, x, cy);
    ctx.fillStyle = GOLD;
    ctx.fillText(b, x + wa, cy);
    c.letterSpacing = '0px';
    ctx.restore();
    return { left: cx - total / 2, right: cx + total / 2, w: total };
  };

  for (const e of els) {
    if (e.k === 'flash') {
      const d = e.dur ?? 0.25;
      if (t < e.t || t > e.t + d) continue;
      ctx.fillStyle = e.color ?? '#ffffff';
      ctx.globalAlpha = Math.pow(1 - (t - e.t) / d, 2) * 0.9;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      drew = true;
      continue;
    }
    if (t < e.t0 || t > e.t1) continue;
    const u = t - e.t0, left = e.t1 - t, dur = e.t1 - e.t0;
    drew = true;
    switch (e.k) {
      case 'fill': {
        ctx.fillStyle = e.color;
        ctx.globalAlpha = e.a0 + (e.a1 - e.a0) * clamp(u / Math.max(1e-6, dur));
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
        break;
      }
      case 'title': {
        // slam in (scale 1.5 -> 1 with an overshoot), a gold glow that settles, a bar that draws out, the ball spins to rest
        const s = 1 + 0.5 * (1 - back(u / 0.32));
        const fade = clamp(left / 0.35);
        const size = (portrait ? 150 : 210) * U;
        ctx.save();
        ctx.translate(W / 2, H * 0.47);
        ctx.scale(s, s);
        const glow = 1.4 * Math.exp(-u * 2.2) + 0.35;
        const wm = wordmark(0, 0, size, clamp(u / 0.06) * fade, glow, -2.6 * Math.exp(-u * 4));
        ctx.restore();
        const bw = wm.w * easeOut((u - 0.25) / 0.5);
        ctx.fillStyle = GOLD;
        ctx.globalAlpha = fade;
        ctx.fillRect(W / 2 - bw / 2, H * 0.47 + size * 0.62, bw, Math.max(2, 6 * U));
        ctx.globalAlpha = 1;
        break;
      }
      case 'tagline': {
        const step = e.step ?? 0.5;
        const size = (portrait ? 54 : 62) * U;
        const fade = clamp(left / 0.3);
        ctx.font = `bold ${size}px ${SMALL}`;
        ctx.textBaseline = 'middle';
        e.lines.forEach((line, i) => {
          const lu = u - i * step;
          if (lu < 0) return;
          const y = H * (portrait ? 0.62 : 0.66) + i * size * 1.25;
          ctx.globalAlpha = easeOut(lu / 0.18) * fade;
          ctx.fillStyle = i === e.lines.length - 1 ? GOLD : '#ffffff';
          ctx.shadowColor = 'rgba(0,0,0,0.6)';
          ctx.shadowBlur = 12 * U;
          tracked(line.toUpperCase(), W / 2, y + (1 - easeOut(lu / 0.25)) * 18 * U, size * 0.12, 'center');
          ctx.shadowBlur = 0;
        });
        ctx.globalAlpha = 1;
        break;
      }
      case 'caption':
      case 'stat': {
        // the HUD's language: a gold bar wipes in, the big word rises out of a mask, the small print follows; out: everything slides off
        const right = e.side === 'right';
        const big = e.k === 'stat' ? e.value : e.text;
        const small = e.k === 'stat' ? e.label : (e.sub ?? '');
        const size = (portrait ? 96 : e.k === 'stat' ? 150 : 118) * U;
        const m = (portrait ? 56 : 96) * U;
        const yBase = portrait ? H * 0.72 : H - m - (small ? 70 * U : 20 * U);
        const outU = easeIn(1 - left / 0.25);
        ctx.font = `${size}px ${DISPLAY}`;
        const tw = ctx.measureText(big.toUpperCase()).width + size * 0.05 * big.length;
        const x0 = right ? W - m - tw : m;
        const slide = outU * (right ? 1 : -1) * (tw + m * 2);
        // bar
        const barW = (tw + 30 * U) * easeOut(u / 0.22);
        ctx.fillStyle = GOLD;
        const barY = yBase + 12 * U;
        ctx.fillRect(right ? W - m - barW + slide : x0 - 4 * U + slide, barY, barW, Math.max(3, 9 * U));
        // big text, revealed upward through a clip
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, yBase - size * 1.05, W, size * 1.05 + 4 * U);
        ctx.clip();
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 16 * U;
        ctx.textBaseline = 'alphabetic';
        const rise = (1 - easeOut((u - 0.08) / 0.3)) * size;
        tracked(big.toUpperCase(), x0 + slide, yBase + rise, size * 0.05, 'left');
        ctx.restore();
        if (small) {
          ctx.font = `bold ${46 * U}px ${SMALL}`;
          ctx.textBaseline = 'top';
          ctx.fillStyle = e.k === 'stat' ? GOLD : '#e8e8e8';
          ctx.globalAlpha = easeOut((u - 0.3) / 0.3);
          ctx.shadowColor = 'rgba(0,0,0,0.7)';
          ctx.shadowBlur = 10 * U;
          tracked(small.toUpperCase(), x0 + slide, barY + 26 * U, 46 * U * 0.14, 'left');
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
        }
        break;
      }
      case 'quote': {
        // the booth's line as a caption: a navy plate, the speaker in gold small caps, the words
        const fade = clamp(u / 0.15) * clamp(left / 0.2);
        const size = (portrait ? 44 : 48) * U;
        ctx.font = `bold ${size}px ${SMALL}`;
        const tw = ctx.measureText(e.text).width;
        const pad = 30 * U;
        const w = Math.min(W - 80 * U, tw + pad * 2);
        const h = size * 2.5;
        // top centre, clear of the captions (bottom left / right) and the broadcast's scorebug
        const x = (W - w) / 2, y = portrait ? H * 0.12 : 44 * U;
        ctx.globalAlpha = fade * 0.86;
        ctx.fillStyle = NAVY;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 10 * U);
        ctx.fill();
        ctx.globalAlpha = fade;
        ctx.fillStyle = GOLD;
        ctx.fillRect(x, y, 8 * U, h);
        ctx.font = `bold ${size * 0.55}px ${SMALL}`;
        ctx.textBaseline = 'top';
        tracked(`${e.who.toUpperCase()}  ·  ${e.role.toUpperCase()}`, x + pad, y + size * 0.3, size * 0.08, 'left');
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${size}px ${SMALL}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillText(e.text, x + pad, y + size * 1.1, w - pad * 2);
        ctx.globalAlpha = 1;
        break;
      }
      case 'phone': {
        // a phone around the screen rect (the footage under it is the portrait capture, placed by the editor)
        const [x, y, w, h] = e.rect;
        const fade = clamp(u / 0.2) * clamp(left / 0.2);
        const b = 16 * U;
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#05070b';
        ctx.beginPath();
        ctx.roundRect(x - b, y - b, w + b * 2, h + b * 2, 46 * U);
        ctx.roundRect(x, y, w, h, 32 * U);
        ctx.fill('evenodd');
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 2 * U;
        ctx.beginPath();
        ctx.roundRect(x - b, y - b, w + b * 2, h + b * 2, 46 * U);
        ctx.stroke();
        ctx.fillStyle = '#05070b';
        ctx.beginPath();
        ctx.roundRect(x + w / 2 - 60 * U, y + 10 * U, 120 * U, 26 * U, 13 * U);
        ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }
      case 'endcard': {
        const a = clamp(u / 0.4);
        // the night behind it: navy, a pool of light from above
        const g = ctx.createRadialGradient(W / 2, H * 0.1, 10, W / 2, H * 0.35, Math.max(W, H) * 0.8);
        g.addColorStop(0, '#1b2333');
        g.addColorStop(0.55, '#0d111a');
        g.addColorStop(1, '#05070b');
        ctx.globalAlpha = a;
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        const size = (portrait ? 120 : 150) * U;
        const cy = H * (portrait ? 0.36 : 0.33);
        wordmark(W / 2, cy, size * (1 + 0.15 * (1 - easeOut(u / 0.5))), clamp(u / 0.3), 0.6, -1.5 * Math.exp(-u * 3));
        const line = (text: string, y: number, sz: number, color: string, delay: number, font = SMALL, bold = true, spacing = 0.1) => {
          const lu = u - delay;
          if (lu < 0) return;
          ctx.globalAlpha = a * easeOut(lu / 0.3);
          ctx.font = `${bold ? 'bold ' : ''}${sz}px ${font}`;
          ctx.fillStyle = color;
          ctx.textBaseline = 'middle';
          tracked(text, W / 2, y + (1 - easeOut(lu / 0.35)) * 16 * U, sz * spacing, 'center');
        };
        line('PLAY IT FREE IN YOUR BROWSER', cy + size * 0.95, 40 * U, '#e8e8e8', 0.45);
        line('taylorbeeston.github.io/claudeball', cy + size * 1.55, (portrait ? 58 : 72) * U, GOLD, 0.6, DISPLAY, false, 0.03);
        line('OPEN SOURCE  ·  MIT  ·  github.com/TaylorBeeston/claudeball', cy + size * 2.2, 34 * U, '#c9ced8', 0.8);
        line('BUILT WITH CLAUDE', cy + size * 2.85, 44 * U, '#ffffff', 1.0, SMALL, true, 0.18);
        line('Footage, game sound and booth: rendered by the game itself  ·  music written in code for this trailer', H - 92 * U, 24 * U, '#9aa1ad', 1.3, SMALL, false, 0.06);
        line('three.js  ·  Poly Haven, ambientCG (CC0)  ·  Anton (OFL)  ·  Kokoro-82M voices (Apache-2.0)', H - 56 * U, 24 * U, '#7d8594', 1.4, SMALL, false, 0.06);
        ctx.globalAlpha = 1;
        break;
      }
    }
  }
  return drew;
}

/**
 * Names and numbers for the jerseys. The player files carry decal meshes (`Jersey_BackNameDecal`, `Jersey_BackNumberDecal`,
 * `Jersey_FrontNumberDecal`, `Jersey_SleeveNumberDecal`, material `jersey_decal`, UV 0..1 over the whole decal); this module draws what goes on
 * them: the last name in a block face and the number, in a colour that reads on the jersey, with an outline. Textures are cached by content
 * (one per unique name or number and colours, shared by every puppet that wears it, kept across games), so a substitution only looks one up.
 *
 * Layout maths takes a `measure` callback so it runs without a canvas (unit-tested); the canvas part is thin.
 */
import { CanvasTexture, ClampToEdgeWrapping, LinearMipmapLinearFilter, SRGBColorSpace, type Texture } from 'three';
import type { QualityName } from './quality';

export type DecalKind = 'backName' | 'backNumber' | 'frontNumber' | 'sleeveNumber';

export const DECAL_NODES: Record<DecalKind, string> = {
  backName: 'Jersey_BackNameDecal',
  backNumber: 'Jersey_BackNumberDecal',
  frontNumber: 'Jersey_FrontNumberDecal',
  sleeveNumber: 'Jersey_SleeveNumberDecal',
};

const SUFFIXES = new Set(['JR', 'JR.', 'SR', 'SR.', 'II', 'III', 'IV', 'V']);

/** The name on the back: the last token of the player's name, upper case, without a generational suffix ("Ken Griffey Jr." -> GRIFFEY). */
export function lastNameOf(full: string | undefined): string {
  const parts = (full ?? '').replace(/[,]/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1].toUpperCase())) parts.pop();
  return (parts[parts.length - 1] ?? '').toUpperCase();
}

const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const n = m ? parseInt(m[1], 16) : 0x808080;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** WCAG relative luminance of a colour string (#rrggbb) */
export function luminance(c: string): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hex(c);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export const contrastRatio = (a: string, b: string) => {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Fill and outline for text on a jersey of this colour: the fill is whichever of white / near-black reads best, the outline is the team trim when it reads against the fill, else the opposite extreme. */
export function jerseyTextColors(jersey: string, trim: string): { fill: string; outline: string } {
  const white = '#ffffff', ink = '#14171c';
  const fill = contrastRatio(jersey, white) >= contrastRatio(jersey, ink) ? white : ink;
  const opposite = fill === white ? ink : white;
  // the outline sits between the letters and the cloth: it must read against the fill, but not be the fill's own colour
  const outline = contrastRatio(trim, fill) >= 2.2 && contrastRatio(trim, jersey) >= 1.15 ? trim : opposite;
  return { fill, outline };
}

export interface Fit {
  /** font size in canvas pixels */
  size: number;
  /** horizontal squeeze (1 = natural width) applied before the size shrinks */
  squeeze: number;
  width: number;
}

/**
 * Fit `text` into a box: natural size from the height, then squeezed horizontally down to `minSqueeze` (a condensed block face), then the size
 * shrinks. `measure(size)` is the text's natural width at that font size, plus the letter spacing the caller uses.
 */
export function fitText(measure: (size: number) => number, maxW: number, maxH: number, minSqueeze = 0.62): Fit {
  let size = maxH;
  const natural = measure(size);
  if (natural <= maxW) return { size, squeeze: 1, width: natural };
  const squeeze = maxW / natural;
  if (squeeze >= minSqueeze) return { size, squeeze, width: maxW };
  // squeezed as far as it goes: shrink the size so the squeezed width fits
  size = size * (squeeze / minSqueeze);
  return { size, squeeze: minSqueeze, width: Math.min(maxW, measure(size) * minSqueeze) };
}

export interface DecalSpec {
  /** canvas size in pixels */
  w: number;
  h: number;
}

/** canvas sizes per quality tier; name decals are wide strips (about 5.3:1), numbers tall (4:5) */
export const DECAL_SIZE: Record<QualityName, Record<'name' | 'number', DecalSpec>> = {
  low: { name: { w: 256, h: 48 }, number: { w: 128, h: 160 } },
  medium: { name: { w: 384, h: 72 }, number: { w: 192, h: 240 } },
  high: { name: { w: 512, h: 96 }, number: { w: 256, h: 320 } },
  ultra: { name: { w: 768, h: 144 }, number: { w: 384, h: 480 } },
};

// Anton (OFL, shipped in public/fonts: phones have none of the block faces below), then the system block faces
const FONT = "400 {S}px 'CB Jersey', Impact, 'Haettenschweiler', 'Arial Narrow Bold', 'Arial Black', 'Helvetica Neue', Arial, sans-serif";

let fontLoad: Promise<void> | null = null;
/** Load the jersey face (once; resolves on failure or after `timeoutMs` too, the fallbacks then draw). Call before the first decal is drawn. */
export function loadJerseyFont(timeoutMs = 4000): Promise<void> {
  if (fontLoad) return fontLoad;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return (fontLoad = Promise.resolve());
  const face = new FontFace('CB Jersey', `url(${import.meta.env.BASE_URL}fonts/anton-latin-400.woff2) format('woff2')`);
  const load = face.load().then((f) => {
    document.fonts.add(f);
  });
  return (fontLoad = Promise.race([load, new Promise<void>((r) => setTimeout(r, timeoutMs))]).catch(() => undefined));
}
const font = (s: number) => FONT.replace('{S}', String(Math.round(s)));

export interface TextureKey {
  kind: 'name' | 'number';
  text: string;
  fill: string;
  outline: string;
  w: number;
  h: number;
  /** drawn flipped, for left-handers (their model is mirrored across X, which would mirror the print) */
  mirror?: boolean;
}

export const keyString = (k: TextureKey) => `${k.kind}|${k.text}|${k.fill}|${k.outline}|${k.w}x${k.h}|${k.mirror ? 'm' : ''}`;

/** The shared cache. Textures live across games; the least recently used are disposed beyond `limit`. */
let quality: QualityName = 'high';
export const setJerseyQuality = (q: QualityName) => (quality = q);
export const jerseyQuality = () => quality;

/** how far from the camera (m) each decal is drawn: the name and big back number carry far, the small ones only up close; low quality skips the small ones */
export function decalRange(kind: DecalKind, q: QualityName): number {
  if (q === 'low' && (kind === 'frontNumber' || kind === 'sleeveNumber')) return 0;
  switch (kind) {
    case 'backName': return q === 'low' ? 24 : 42;
    case 'backNumber': return q === 'low' ? 32 : 55;
    default: return 24;
  }
}

/** the print on one jersey: what to draw for each decal kind (numbers share one texture) */
export function jerseyPrint(name: string | undefined, number: number | undefined, jersey: string, trim: string, q: QualityName, mirror: boolean): Partial<Record<DecalKind, TextureKey>> {
  const { fill, outline } = jerseyTextColors(jersey, trim);
  const out: Partial<Record<DecalKind, TextureKey>> = {};
  const last = lastNameOf(name);
  const sz = DECAL_SIZE[q];
  if (last) out.backName = { kind: 'name', text: last, fill, outline, w: sz.name.w, h: sz.name.h, mirror };
  if (number !== undefined && number >= 0) {
    const key: TextureKey = { kind: 'number', text: String(Math.floor(number)), fill, outline, w: sz.number.w, h: sz.number.h, mirror };
    out.backNumber = out.frontNumber = out.sleeveNumber = key;
  }
  return out;
}

export class JerseyTextures {
  private map = new Map<string, CanvasTexture>();
  constructor(private limit = 160, private anisotropy = 4) {}

  get size() {
    return this.map.size;
  }

  get(k: TextureKey): Texture {
    const id = keyString(k);
    const hit = this.map.get(id);
    if (hit) {
      this.map.delete(id);
      this.map.set(id, hit); // most recently used last
      return hit;
    }
    const tex = this.draw(k);
    this.map.set(id, tex);
    while (this.map.size > this.limit) {
      const [old, t] = this.map.entries().next().value as [string, CanvasTexture];
      this.map.delete(old);
      t.dispose();
    }
    return tex;
  }

  private draw(k: TextureKey): CanvasTexture {
    const c = document.createElement('canvas');
    c.width = k.w;
    c.height = k.h;
    const g = c.getContext('2d');
    if (g) drawJerseyText(g, k);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.wrapS = t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.anisotropy = this.anisotropy;
    return t;
  }

  dispose() {
    for (const t of this.map.values()) t.dispose();
    this.map.clear();
  }
}

/** Draw the text centred, condensed to fit, with a thick outline then the fill; transparent background. */
export function drawJerseyText(g: CanvasRenderingContext2D, k: TextureKey) {
  const { w, h } = k;
  g.clearRect(0, 0, w, h);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  g.miterLimit = 2;
  const pad = Math.round(Math.min(w, h) * 0.07);
  const spacing = k.kind === 'name' ? 0.04 : 0;
  const maxW = w - pad * 2, maxH = h - pad * 2;
  // cap height of the face is about 0.72 of the font size: ask for a box height that makes the capitals fill maxH
  const measure = (size: number) => {
    g.font = font(size);
    return g.measureText(k.text).width + spacing * size * Math.max(0, k.text.length - 1);
  };
  // numbers are all the same height whatever their digits: the size comes from the widest two-digit number, so a 1 is as tall as an 88
  const sizing = k.kind === 'number' ? (size: number) => { g.font = font(size); return g.measureText('88').width; } : measure;
  const fit = fitText(sizing, maxW, maxH / 0.74, k.kind === 'name' ? 0.55 : 0.8);
  const size = Math.min(fit.size, maxH / 0.74);
  g.font = font(size);
  const outlinePx = Math.max(2, size * 0.075);
  const baseline = h / 2 + size * 0.36;
  g.save();
  g.translate(w / 2, baseline);
  g.scale(fit.squeeze * (k.mirror ? -1 : 1), 1);
  const draw = (stroke: boolean) => {
    // letter-spaced text drawn glyph by glyph (canvas letterSpacing is not everywhere)
    const total = measure(size) / 1;
    let x = -total / 2;
    for (const ch of k.text) {
      const cw = g.measureText(ch).width;
      if (stroke) g.strokeText(ch, x + cw / 2, 0);
      else g.fillText(ch, x + cw / 2, 0);
      x += cw + spacing * size;
    }
  };
  g.strokeStyle = k.outline;
  g.lineWidth = outlinePx * 2;
  draw(true);
  g.fillStyle = k.fill;
  draw(false);
  g.restore();
}

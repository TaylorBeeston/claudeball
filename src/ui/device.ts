/**
 * Device-based defaults: which quality preset a device starts on, and whether it is a phone / tablet.
 * `deviceQuality` is pure (tested); `readDevice` is the only part that touches the browser.
 */
import type { QualityName } from '../engine/quality';

export interface DeviceInfo {
  /** primary pointer is a finger */
  coarse: boolean;
  /** shorter side of the screen in CSS pixels */
  shortSide: number;
  /** `navigator.deviceMemory` (GB, capped at 8 by browsers; undefined in Safari / Firefox) */
  memoryGb?: number;
  cores?: number;
  /** unmasked WebGL renderer string, when the browser exposes it */
  gpu?: string;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const INTEGRATED = /intel|uhd|iris|hd graphics|mali-g[0-5]|adreno \(?[1-5]\d\d|powervr|videocore|apple gpu/i;

/**
 * Starting preset for "Auto": phones and software renderers start on Low, tablets and integrated GPUs on Medium, everything else on High.
 * (The adaptive resolution scale then trims or restores internal resolution per frame time.) Ultra is never chosen automatically.
 */
export function deviceQuality(d: DeviceInfo): QualityName {
  if (d.gpu && SOFTWARE.test(d.gpu)) return 'low';
  if (d.coarse) {
    const phone = d.shortSide < 600;
    if (phone) return (d.memoryGb ?? 4) <= 4 || (d.cores ?? 8) <= 6 ? 'low' : 'medium';
    return 'medium';
  }
  if ((d.memoryGb ?? 8) <= 2 || (d.cores ?? 8) <= 2) return 'low';
  if (d.gpu && INTEGRATED.test(d.gpu) && !/apple m\d/i.test(d.gpu)) return 'medium';
  return 'high';
}

export const QUALITY_BLURB: Record<QualityName, string> = {
  low: 'Smooth on phones and old laptops: simple shadows, no effects, a thin crowd.',
  medium: 'Good looks on modest GPUs: soft shadows, ambient occlusion, bloom.',
  high: 'Anti-aliasing, depth of field and a full crowd. Needs a decent GPU.',
  ultra: 'Sharpest shadows, full-resolution effects and the biggest crowd. Needs a strong GPU.',
};

function gpuName(): string | undefined {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : undefined;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return undefined;
  }
}

export function readDevice(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    coarse: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    shortSide: Math.min(screen.width || innerWidth, screen.height || innerHeight, Math.max(innerWidth, innerHeight)),
    memoryGb: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    gpu: gpuName(),
  };
}

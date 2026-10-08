import { describe, expect, it } from 'vitest';
import { Color, MeshPhysicalMaterial, MeshStandardMaterial, ShaderChunk } from 'three';
import { installCharacterShading, setShadingQuality, shadeHair, shadeSkin, shadingTier, TIER_OF, upgradeMaterial } from '../characterShading';

describe('character shading', () => {
  it('patches the physical light chunk once and keeps the stock lines', () => {
    installCharacterShading();
    installCharacterShading();
    const c = ShaderChunk.lights_physical_pars_fragment;
    expect(c.split('#ifdef CB_SKIN').length - 1).toBe(1);
    expect(c).toContain('#ifdef CB_HAIR');
    expect(c).toContain('BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );');
  });
  it('maps quality to tiers: no shading on low, wrap only on medium, curvature on high and ultra', () => {
    expect(TIER_OF.low).toBe('off');
    expect(TIER_OF.medium).toBe('basic');
    expect(TIER_OF.high).toBe('full');
    expect(TIER_OF.ultra).toBe('full');
  });
  it('switches the defines of skin and hair materials with the tier', () => {
    const skin = shadeSkin(new MeshPhysicalMaterial());
    const hair = shadeHair(new MeshStandardMaterial({ transparent: true }));
    setShadingQuality('high', true);
    expect(shadingTier()).toBe('full');
    expect((skin as MeshPhysicalMaterial).defines).toMatchObject({ CB_SKIN: '', CB_SSS_CURV: '' });
    expect((hair as MeshStandardMaterial).defines).toMatchObject({ CB_HAIR: '' });
    expect((hair as MeshStandardMaterial).alphaToCoverage).toBe(true);
    expect((hair as MeshStandardMaterial).transparent).toBe(false);
    setShadingQuality('medium', false);
    expect((skin as MeshPhysicalMaterial).defines?.CB_SSS_CURV).toBeUndefined();
    expect((skin as MeshPhysicalMaterial).defines?.CB_SKIN).toBe('');
    expect((hair as MeshStandardMaterial).alphaToCoverage).toBe(false);
    expect((hair as MeshStandardMaterial).alphaTest).toBeGreaterThan(0);
    setShadingQuality('low', false);
    expect((skin as MeshPhysicalMaterial).defines?.CB_SKIN).toBeUndefined();
    expect((hair as MeshStandardMaterial).transparent).toBe(true);
    setShadingQuality('high', true);
  });
  it('turns eyes and leather into clear-coated physical materials, once per source material', () => {
    const eye = new MeshStandardMaterial({ color: new Color('white') });
    eye.name = 'eye';
    const a = upgradeMaterial(eye) as MeshPhysicalMaterial;
    expect(a.isMeshPhysicalMaterial).toBe(true);
    // a little wet gloss, not a mirror (a full clear coat + strong env reflections whited the eyes out under a day sky)
    expect(a.clearcoat).toBeGreaterThan(0.2);
    expect(a.clearcoat).toBeLessThan(0.5);
    expect(a.envMapIntensity).toBeLessThan(1);
    expect(upgradeMaterial(eye)).toBe(a);
    const cloth = new MeshStandardMaterial();
    cloth.name = 'uniform_pants';
    expect(upgradeMaterial(cloth)).toBe(cloth);
    const glove = new MeshStandardMaterial();
    glove.name = 'glove';
    expect((upgradeMaterial(glove) as MeshPhysicalMaterial).clearcoat).toBeGreaterThan(0);
  });
});

# Procedural PBR maps (numpy) + node setups that the glTF exporter understands (baseColorFactor via Mix-multiply, ORM via Separate Color + glTF Material Output group).
import numpy as np
def tiled(n, k, seed=0): return noise_tex(n, [k], seed)
def weave_height(n=1024, k=96, seed=1):
    x = np.arange(n)[None, :]/n*k*2*np.pi; y = np.arange(n)[:, None]/n*k*2*np.pi
    h = (np.sin(x)*np.sin(y) + 1)/2*.55 + (np.sin(x+y*.5)+1)/4*.15
    return h*.7 + .3*noise_tex(n, [64, 256, 512], seed)
def knit_height(n=1024, k=64, seed=2):
    x = np.arange(n)[None, :]/n*k*2*np.pi; y = np.arange(n)[:, None]/n*k*2*np.pi
    return (np.sin(x + np.sin(y)*1.5) + 1)/2*.6 + .4*noise_tex(n, [64, 256], seed)
def skin_height(n=1024, seed=3): return noise_tex(n, [128, 256, 512], seed)*.7 + noise_tex(n, [16, 32], seed+1)*.3
def leather_height(n=1024, seed=4):
    c = noise_tex(n, [24], seed); return np.abs(c - .5)*2*.6 + noise_tex(n, [256, 512], seed+2)*.4
def orm(ao, rough, metal=0.0):
    return np.stack([np.clip(ao, 0, 1), np.clip(rough, 0, 1), np.full_like(ao, metal)], -1)

def glTF_group():
    g = bpy.data.node_groups.get("glTF Material Output")
    if g is None:
        g = bpy.data.node_groups.new("glTF Material Output", 'ShaderNodeTree')
        g.interface.new_socket("Occlusion", in_out='INPUT', socket_type='NodeSocketFloat')
    return g

def pbr(name, color, base=None, nrm=None, ormimg=None, rough=.8, metal=0.0, nstrength=.6, alpha=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if base is not None:
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = base
        mx = nt.nodes.new("ShaderNodeMix"); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs[0].default_value = 1.0
        mx.inputs[7].default_value = color; nt.links.new(t.outputs["Color"], mx.inputs[6]); nt.links.new(mx.outputs[2], b.inputs["Base Color"])
    else: b.inputs["Base Color"].default_value = color
    if nrm is not None:
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = nrm; nm = nt.nodes.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = nstrength
        nt.links.new(t.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    if ormimg is not None:
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = ormimg; sp = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(t.outputs["Color"], sp.inputs["Color"]); nt.links.new(sp.outputs["Green"], b.inputs["Roughness"]); nt.links.new(sp.outputs["Blue"], b.inputs["Metallic"])
        gn = nt.nodes.new("ShaderNodeGroup"); gn.node_tree = glTF_group(); nt.links.new(sp.outputs["Red"], gn.inputs["Occlusion"])
    return m

def img(name, arr, cs='sRGB'): return make_image(name, arr, cs, ROOT+f"/tex/{name}.png")
NS = 1.0
wh = weave_height(); kh = knit_height(); sh = skin_height(); lh = leather_height()
fabric_a = np.clip(.93 + .10*wh, 0, 1)
stripes = np.ones((1024, 1024)); stripes[:, ::32] = .86; stripes[:, 1::32] = .9
I = {}
I["jersey_a"] = img("jersey_albedo", np.repeat((fabric_a*stripes)[..., None], 3, 2)); I["jersey_n"] = img("jersey_normal", height_to_normal(wh, 4.0), 'Non-Color')
I["jersey_o"] = img("jersey_orm", orm(.75 + .25*wh, .82 - .1*wh), 'Non-Color')
I["pants_a"] = img("pants_albedo", np.repeat((np.clip(.92 + .1*kh, 0, 1))[..., None], 3, 2)); I["pants_n"] = img("pants_normal", height_to_normal(kh, 4.0), 'Non-Color')
I["pants_o"] = img("pants_orm", orm(.7 + .3*kh, .9 - .1*kh), 'Non-Color')
def _dilate(arr, cov, it=24):
    """bleed texel values into uncovered neighbours (so mip-maps / filtering never pull in the background)"""
    out = arr.copy(); m = cov.copy()
    for _ in range(it):
        grow = np.zeros_like(m); acc = np.zeros_like(out); cnt = np.zeros(m.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ms = np.roll(m, (dy, dx), (0, 1)); os_ = np.roll(out, (dy, dx), (0, 1)); acc += os_*ms[..., None]; cnt += ms
        fill = (~m) & (cnt > 0); out[fill] = acc[fill]/cnt[fill][:, None]; m = m | fill
    return out
_RC = {}
def build_skin_maps(size=2048, src="skin_middleage_caucasian_male.jpg", age=0.0, seed=11):
    """Skin texture set in the MPFB atlas: neutral albedo detail (photographic variation, divided by its mean so `baseColorFactor` = skin tone), normal map (pores, micro relief, wrinkles, lip /
    eyelid / nasolabial detail evaluated per texel from the 3D position), ORM (cavity AO, roughness with an oily T-zone and glossy lips), plus a thickness / curvature map for SSS."""
    b = base(); P = b["P"].astype(np.float32); N = full_normals().astype(np.float32); curv, thick = vertex_curvature_thickness()
    key = ('rast', size)
    if key not in _RC: _RC[key] = rasterize_uv(np.concatenate([P, N, curv[:, None], thick[:, None]], 1).astype(np.float32), size)
    img_, cov = _RC[key]
    pos = img_[..., :3]; nrm = img_[..., 3:6]; cu = img_[..., 6]; th = img_[..., 7]
    im = Image.open(os.path.join(MP, "tex", src)).convert("RGB").resize((size, size), Image.LANCZOS); a0 = np.asarray(im, np.float32)/255.0
    lum = a0.mean(2); skinm = cov & (lum > .2); ref = np.median(a0[skinm], axis=0)
    alb = np.clip(a0/ref[None, None, :]*.90, 0, 1)
    er = cov.copy()                                                           # erode the islands by 5 texels and re-grow them: removes the baked seam lines / bright borders of the source texture
    for _ in range(5): er = er & np.roll(er, 1, 0) & np.roll(er, -1, 0) & np.roll(er, 1, 1) & np.roll(er, -1, 1)
    alb = _dilate(alb, er, 14)
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]; ax = np.abs(x); head = (z > 1.60)
    def g(v, c, s): return np.exp(-((v - c)/s)**2)
    # --- male skin variation: beard shadow (jaw / chin / upper lip), under-eye shading, temple + ear redness
    mouthreg = np.exp(-((ax/.05)**2 + ((z - 1.645)/.025)**2))
    shadow = np.clip(g(z, 1.62, .03)*(ax < .07)*(y < -.1) + g(z, 1.668, .012)*(ax < .035)*(y < -.15)*.7 + .6*(g(z, 1.60, .025)*(ax < .075)), 0, 1)*head
    alb *= (1 - .07*shadow[..., None])*np.array([1, 1, 1.02], np.float32)
    eyebag = head*np.exp(-((ax - .032)/.022)**2)*g(z, 1.715, .008)*(y < -.1); alb *= (1 - .05*eyebag[..., None])*np.array([1, .99, 1.0], np.float32)
    # --- height field (mm-ish units): pores, micro relief, wrinkles
    n_pore = noise_tex(size, [512, 1024], seed); n_micro = noise_tex(size, [96, 192, 384], seed + 1); n_big = noise_tex(size, [24, 48], seed + 2)
    poredens = np.where(head, .9, .5)*(1 + .5*g(ax, .0, .03)*g(z, 1.69, .03)) ; pore = (np.clip(n_pore - .52, 0, 1))**1.3*2.4*poredens
    h = -pore + (n_micro - .5)*.55 + (n_big - .5)*.25*(1 + age)
    front = (y < -.10) & head
    for zc, w, a_ in ((1.783, .007, .5), (1.797, .006, .45), (1.811, .006, .35)):                                      # forehead creases
        h -= (a_ + .7*age)*g(z, zc + .004*np.sin(x*45 + zc*30), .0016)*(ax < .052)*front*(.6 + .4*g(ax, 0, .03))
    for sx in (1, -1):
        for k in range(3): h -= (.4 + .8*age)*g((z - (1.732 + .006*(k - 1))) - .22*(sx*x - .052), 0, .0012)*(sx*x > .05)*(sx*x < .085)*(y < -.05)    # crow's feet
        # nasolabial folds: line from the nose wing (x .026, z 1.682) to the mouth corner (x .034, z 1.640)
        t = np.clip((1.682 - z)/.042, 0, 1); xl = .026 + .010*t; dist = np.abs(sx*x - xl); h -= (.7 + 1.0*age)*g(dist, 0, .0022)*(z < 1.684)*(z > 1.636)*(y < -.12)
        h -= (.5 + .8*age)*g((z - 1.714) + .5*(sx*x - .04), 0, .0013)*(sx*x > .015)*(sx*x < .052)*(y < -.1)                                        # eye-bag lines
    h -= .9*g(z, 1.6445, .0011)*(ax < .026)*(y < -.1)                                                                                              # mouth line
    h -= .4*g(z, 1.658, .0016)*(ax < .02)*(y < -.1) + .5*g(z, 1.628, .002)*(ax < .016)*(y < -.1)                                                  # lip lines / chin crease
    h -= (.4 + 1.2*age)*g(x, 0, .0022)*g(z, 1.762, .016)*(y < -.1)                                                                                  # glabella
    nmap = height_to_normal(h[::-1].astype(np.float32).copy(), .62*(size/2048.0)); nmap = _dilate(nmap, cov[::-1])          # (Blender images are bottom-up: v = 0 is row 0)
    # --- ORM: cavity AO, oily T-zone, glossy lips (red-ish albedo), rougher cheeks / neck
    cav = np.clip(-cu*60, 0, 1); ao = np.clip(1 - .55*cav - .20*g(z, 1.717, .014)*(ax < .06)*head*(y < -.1), 0, 1)
    tz = head*(g(ax, 0, .028)*g(z, 1.73, .06) + .6*g(ax, 0, .03)*g(z, 1.675, .02)); lipm = np.clip((a0[..., 0] - a0[..., 1]*1.35 - .02)*9, 0, 1)*mouthreg
    rough = np.clip(.56 - .2*tz - .17*lipm + .06*g(ax, .07, .03)*head + .02*(n_micro - .5)*4 + .04*age, .2, .9)
    orm_ = np.stack([ao, rough, np.zeros_like(ao)], -1).astype(np.float32); orm_ = _dilate(orm_, cov)
    sss = np.stack([np.clip(th/.04, 0, 1), np.clip(.5 + cu*40, 0, 1), np.zeros_like(th)], -1).astype(np.float32); sss = _dilate(sss, cov)
    return dict(albedo=alb[::-1].copy(), normal=nmap, orm=orm_[::-1].copy(), sss=sss[::-1].copy(), cov=cov)
SKIN = build_skin_maps()
I["skin_a"] = make_image("skin_albedo", SKIN["albedo"], 'sRGB', None); I["skin_n"] = make_image("skin_normal", SKIN["normal"], 'Non-Color', None); I["skin_o"] = make_image("skin_orm", SKIN["orm"], 'Non-Color', None)
I["skin_sss"] = make_image("skin_sss", SKIN["sss"], 'Non-Color', None)
SKIN_OLD = build_skin_maps(src="skin_old_caucasian_male.jpg", age=1.0, seed=21)                     # older skin set (age lines, spots) for player_manager
I_OLD = dict(a=make_image("skin_albedo_old", SKIN_OLD["albedo"], 'sRGB', None), n=make_image("skin_normal_old", SKIN_OLD["normal"], 'Non-Color', None), o=make_image("skin_orm_old", SKIN_OLD["orm"], 'Non-Color', None))
def swap_skin(old):
    new = dict(skin_albedo=I_OLD['a'], skin_normal=I_OLD['n'], skin_orm=I_OLD['o']) if old else dict(skin_albedo=I['skin_a'], skin_normal=I['skin_n'], skin_orm=I['skin_o'])
    for mn in ('skin', 'face'):
        for nd in MATS[mn].node_tree.nodes:
            if nd.type == 'TEX_IMAGE' and nd.image is not None:
                base_ = nd.image.name.replace('_old', '')
                if base_ in new: nd.image = new[base_]
Image.fromarray((np.clip(SKIN["sss"][::-1], 0, 1)*255).astype(np.uint8)).save(ROOT + "/players/textures/skin_sss.webp", quality=90)      # R = thickness (0..4 cm), G = curvature, atlas layout = the skin atlas
I["leather_a"] = img("leather_albedo", np.repeat((np.clip(.8 + .3*lh, 0, 1))[..., None], 3, 2)); I["leather_n"] = img("leather_normal", height_to_normal(lh, 5.0), 'Non-Color')
I["leather_o"] = img("leather_orm", orm(.6 + .4*lh, .5 + .2*lh), 'Non-Color')

# ---- photographic CC0 PBR sets (ambientCG, 1K copies in src/pbr; see CREDITS.md): luminance-normalised albedo (so baseColorFactor tints), GL normal, ORM = (AO, roughness, 0)
def pbr_set(name, gain=.92, rough_mul=1.0, tag=None, contrast=1.0):
    d = os.path.join(CB_SRC, "pbr"); ld = lambda k, mode: np.asarray(Image.open(os.path.join(d, f"{name}_{k}.webp")).convert(mode), np.float32)/255.0
    col = ld("color", "RGB"); lum = (col*np.array([.3, .55, .15], np.float32)).sum(2); alb = np.repeat((1 - (1 - np.clip(lum/np.percentile(lum, 85)*gain, 0, 1))*contrast)[..., None], 3, 2)      # contrast < 1 flattens high-contrast scuffed sets
    nrm = ld("normal", "RGB"); rg = np.clip(ld("rough", "L")*rough_mul, .05, 1)
    ao = ld("ao", "L") if os.path.exists(os.path.join(d, f"{name}_ao.webp")) else np.ones_like(rg)
    t = tag or name; flip = lambda a: a[::-1].copy()
    return dict(a=make_image(t + "_albedo", flip(alb), 'sRGB', None), n=make_image(t + "_normal", flip(nrm), 'Non-Color', None), o=make_image(t + "_orm", flip(np.stack([ao, rg, np.zeros_like(rg)], -1)), 'Non-Color', None))
KNIT = pbr_set("Fabric019", tag="knit"); WOVEN = pbr_set("Fabric036", tag="woven"); L_GLOVE = pbr_set("Leather033A", tag="leather_glove"); L_BELT = pbr_set("Leather037", tag="leather_belt")
L_BLACK = pbr_set("Leather026", tag="leather_black"); RUBBER = pbr_set("Rubber004", tag="rubber"); PLASTIC = pbr_set("Plastic006", tag="plastic", contrast=.3)
I["jersey_a"], I["jersey_n"], I["jersey_o"] = KNIT["a"], KNIT["n"], KNIT["o"]
I["pants_a"], I["pants_n"], I["pants_o"] = KNIT["a"], KNIT["n"], KNIT["o"]
I["face_a"], I["face_n"], I["face_o"] = I["skin_a"], I["skin_n"], I["skin_o"]; I["eye_a"] = make_image("eye_albedo", eye_equirect("brown")[::-1].copy(), 'sRGB', None)
os.makedirs(ROOT + "/players/textures", exist_ok=True)
for _ec in EYE_COLORS: Image.fromarray((eye_equirect(_ec)*255).astype(np.uint8)).save(ROOT + f"/players/textures/eyes_{_ec}.webp", quality=92)       # equirect iris textures (v = 1 at the gaze pole is the TOP row of the file) for the engine to swap
MATS = {
 "skin": pbr("skin", (.80, .50, .32, 1), I["skin_a"], I["skin_n"], I["skin_o"], nstrength=.5),
 "face": pbr("face", (.80, .50, .32, 1), I["face_a"], I["face_n"], I["face_o"], nstrength=.45),
 "eye": pbr("eye", (1, 1, 1, 1), I["eye_a"], None, None, rough=.08),
 "hair": pbr("hair", (.09, .06, .035, 1), None, I["leather_n"], None, rough=.6, nstrength=.25),
 "uniform_jersey": pbr("uniform_jersey", (.8, .8, .8, 1), I["jersey_a"], I["jersey_n"], I["jersey_o"]),
 "uniform_undershirt": pbr("uniform_undershirt", (.05, .08, .3, 1), I["jersey_a"], I["jersey_n"], I["jersey_o"]),
 "uniform_pants": pbr("uniform_pants", (.75, .75, .75, 1), WOVEN["a"], WOVEN["n"], WOVEN["o"], nstrength=.8),
 "uniform_socks": pbr("uniform_socks", (.05, .08, .3, 1), I["pants_a"], I["pants_n"], I["pants_o"]),
 "cleats": pbr("cleats", (.03, .03, .03, 1), L_BLACK["a"], L_BLACK["n"], L_BLACK["o"], nstrength=.6),
 "cap": pbr("cap", (.05, .08, .3, 1), WOVEN["a"], WOVEN["n"], WOVEN["o"], nstrength=.8),
 "helmet": pbr("helmet", (.05, .08, .3, 1), PLASTIC["a"], PLASTIC["n"], PLASTIC["o"], rough=.3, nstrength=.5),
 "glove": pbr("glove", (.28, .14, .07, 1), L_GLOVE["a"], L_GLOVE["n"], L_GLOVE["o"], nstrength=.8),
 "catcher_gear": pbr("catcher_gear", (.03, .03, .04, 1), PLASTIC["a"], PLASTIC["n"], PLASTIC["o"], rough=.45, nstrength=.5),
 "belt": pbr("belt", (.02, .02, .02, 1), L_BELT["a"], L_BELT["n"], L_BELT["o"], nstrength=.6),
}

# ---- third-pass materials (recolour via baseColorFactor like the others)
def flat_mat(name, color, rough=.7, metal=0.0, alpha=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color; b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if alpha is not None: b.inputs["Alpha"].default_value = alpha; m.surface_render_method = 'BLENDED'
    return m
MATS["piping"] = pbr("piping", (.05, .08, .3, 1), I["jersey_a"], I["jersey_n"], I["jersey_o"])                       # contrast trim (sleeve bands, placket, pants stripe, sock stripes)
MATS["button"] = flat_mat("button", (.85, .85, .82, 1), .35)
MATS["batting_glove"] = pbr("batting_glove", (.03, .03, .035, 1), L_BLACK["a"], L_BLACK["n"], L_BLACK["o"], rough=.55, nstrength=.6)
MATS["wristband"] = pbr("wristband", (.9, .9, .9, 1), KNIT["a"], KNIT["n"], KNIT["o"])
MATS["arm_sleeve"] = pbr("arm_sleeve", (.03, .03, .04, 1), WOVEN["a"], WOVEN["n"], WOVEN["o"], rough=.6)
MATS["eyeblack"] = flat_mat("eyeblack", (.015, .015, .015, 1), .85)
MATS["stubble"] = flat_mat("stubble", (.06, .045, .035, 1), .9, alpha=.42)
MATS["laces"] = flat_mat("laces", (.92, .92, .9, 1), .7)
MATS["sole"] = pbr("sole", (.04, .04, .045, 1), RUBBER["a"], RUBBER["n"], RUBBER["o"], rough=.7, nstrength=.6)
MATS["buckle"] = flat_mat("buckle", (.78, .78, .8, 1), .28, metal=1.0)
MATS["glove_laces"] = pbr("glove_laces", (.55, .38, .2, 1), L_BELT["a"], L_BELT["n"], L_BELT["o"], rough=.7, nstrength=.4)

MATS["jacket"] = pbr("jacket", (.05, .08, .3, 1), I["jersey_a"], I["jersey_n"], I["jersey_o"], rough=.7)

def _alpha_mat(name, color, tex, rough=.6, blend=False, lum_norm=False, nrm=None, clip=False):
    """Alpha-textured card material (hair, brows, lashes): texture RGB (optionally luminance-normalised so baseColorFactor tints it) x colour, texture alpha -> alpha."""
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; b = nt.nodes["Principled BSDF"]; b.inputs["Roughness"].default_value = rough
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = tex; mx = nt.nodes.new("ShaderNodeMix"); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs[0].default_value = 1.0
    mx.inputs[7].default_value = color; nt.links.new(t.outputs["Color"], mx.inputs[6]); nt.links.new(mx.outputs[2], b.inputs["Base Color"])
    if clip:                                                              # alpha clip (glTF alphaMode MASK, cutoff .5): a Math node `greater than` between the texture alpha and the BSDF alpha
        mt = nt.nodes.new("ShaderNodeMath"); mt.operation = 'GREATER_THAN'; mt.inputs[1].default_value = .5; nt.links.new(t.outputs["Alpha"], mt.inputs[0]); nt.links.new(mt.outputs[0], b.inputs["Alpha"])
    else: nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    m.surface_render_method = 'BLENDED' if blend else 'DITHERED'; m.use_backface_culling = False
    return m
def card_image(name, fname, lum=True, size=1024):
    im = Image.open(os.path.join(MP, "tex", fname)).convert("RGBA"); a = np.asarray(im, np.float32)/255.0
    if lum:
        l = (a[..., :3]*np.array([.3, .55, .15], np.float32)).sum(2); m = a[..., 3] > .5; ref = np.percentile(l[m], 85) if m.any() else 1.0
        a[..., :3] = np.clip((l/ref)[..., None]*.92, 0, 1)
    return _rgba_image(name, a)
def _rgba_image(name, a):
    h, w = a.shape[:2]; img_ = bpy.data.images.new(name, w, h, alpha=True); img_.colorspace_settings.name = 'sRGB'; img_.alpha_mode = 'STRAIGHT'
    img_.pixels.foreach_set(np.clip(a[::-1], 0, 1).astype(np.float32).ravel()); img_.pack(); return img_       # (Blender images are bottom-up)
bpy.data.materials.remove(MATS["hair"]); MATS["hair"] = _alpha_mat("hair", (.09, .06, .035, 1), card_image("hair_short02_a", "hair_short02.webp"), .5, clip=True)
for _h in ("short01", "short03", "short04", "bob01", "afro01", "long01", "ponytail01"):
    MATS["hair_" + _h] = _alpha_mat("hair_" + _h, (.09, .06, .035, 1), card_image("hair_" + _h + "_a", f"hair_{_h}.webp"), .5, clip=True)
MATS["eyebrow"] = _alpha_mat("eyebrow", (.07, .045, .03, 1), card_image("eyebrow_a", "eyebrow004.webp"), .6, blend=True)
MATS["eyelash"] = _alpha_mat("eyelash", (.03, .02, .015, 1), card_image("eyelash_a", "eyelashes02.webp"), .6, clip=True)
MATS["teeth"] = _alpha_mat("teeth", (1, 1, 1, 1), card_image("teeth_a", "teeth.webp", lum=False), .3, clip=True)
MATS["tongue"] = _alpha_mat("tongue", (1, 1, 1, 1), card_image("tongue_a", "tongue01_diffuse.webp", lum=False), .35)
_cm = bpy.data.materials.new("cornea"); _cm.use_nodes = True; _cb = _cm.node_tree.nodes["Principled BSDF"]; _cb.inputs["Alpha"].default_value = .10; _cb.inputs["Roughness"].default_value = .03; _cm.surface_render_method = 'BLENDED'
try: _cb.inputs["IOR"].default_value = 1.38
except Exception: pass
MATS["cornea"] = _cm

def _blur(a, k=3):
    for _ in range(k): a = (a + np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1))/5
    return a
def emboss_normal(name, alpha, strength=8.0, blur=3):
    """Normal map of a raised (embroidered / printed) patch: height = blurred alpha. `alpha` is top-down (PIL order); the image is uploaded bottom-up."""
    h = _blur(alpha.astype(np.float32), blur)[::-1].copy(); return make_image(name, height_to_normal(h, strength), 'Non-Color', None)
def add_normal(mat, nimg, strength=1.0):
    nt = mat.node_tree; b = nt.nodes["Principled BSDF"]; t = nt.nodes.new("ShaderNodeTexImage"); t.image = nimg; nm = nt.nodes.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = strength
    nt.links.new(t.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
_lg = np.asarray(Image.open(os.path.join(CB_SRC, "pbr", "cap_logo.png")).convert("RGBA"), np.float32)/255.0
MATS["cap_logo"] = _alpha_mat("cap_logo", (.96, .96, .96, 1), _rgba_image("cap_logo_a", _lg), .7, clip=True); add_normal(MATS["cap_logo"], emboss_normal("cap_logo_n", _lg[..., 3], 10.0, 2), 1.0)
MATS["spikes"] = flat_mat("spikes", (.62, .62, .65, 1), .3, metal=1.0)

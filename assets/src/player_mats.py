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
I["skin_a"] = img("skin_albedo", np.repeat((np.clip(.90 + .12*sh, 0, 1))[..., None], 3, 2)); I["skin_n"] = img("skin_normal", height_to_normal(sh, 1.2), 'Non-Color')
I["skin_o"] = img("skin_orm", orm(.9 + .1*sh, .55 + .12*(1-sh)), 'Non-Color')
I["leather_a"] = img("leather_albedo", np.repeat((np.clip(.8 + .3*lh, 0, 1))[..., None], 3, 2)); I["leather_n"] = img("leather_normal", height_to_normal(lh, 5.0), 'Non-Color')
I["leather_o"] = img("leather_orm", orm(.6 + .4*lh, .5 + .2*lh), 'Non-Color')
def face_orm(n=1024):
    """glTF ORM for the face (head UV space): AO darkens eye sockets / nostrils / mouth line, roughness varies (oily T-zone, rougher cheeks / chin, glossier lips)."""
    uu, vv = np.meshgrid((np.arange(n)+.5)/n, (np.arange(n)+.5)/n); w = vv*2-1; r = np.sqrt(np.clip(1-w*w, 0, 1)); th = (uu-.5)*2*np.pi; x = r*np.sin(th); front = ((r*np.cos(th)) > -.05)*1.0
    ao = np.ones((n, n)); rough = .58 + .1*noise_tex(n, [8, 32], 7) - .05
    def blob(cx, cw, sx, sw, v):
        return v*(g2(x, w, cx, cw, sx, sw) + (g2(x, w, -cx, cw, sx, sw) if cx else 0))*front
    ao = ao - blob(.42, .09, .16, .10, .35) - blob(.10, -.285, .05, .04, .3) - blob(0, -.48, .22, .02, .25) - blob(.30, -.60, .30, .1, .0)
    rough = rough - blob(0, .20, .30, .25, .12) - blob(0, .0, .08, .35, .10) - blob(0, -.46, .20, .05, .22) + blob(.55, -.15, .22, .22, .08) + blob(0, -.80, .25, .12, .08)
    return np.stack([np.clip(ao, 0, 1), np.clip(rough, .2, .95), np.zeros((n, n))], -1)
I["face_o"] = img("face_orm", face_orm(), 'Non-Color')
I["face_a"] = img("face_albedo", face_texture()); I["eye_a"] = img("eye_albedo", eye_texture()); I["face_n"] = img("face_normal", height_to_normal(face_height(), 1.6), 'Non-Color')
MATS = {
 "skin": pbr("skin", (.55, .36, .27, 1), I["skin_a"], I["skin_n"], I["skin_o"], nstrength=.5),
 "face": pbr("face", (.55, .36, .27, 1), I["face_a"], I["face_n"], I["face_o"], nstrength=.45),
 "eye": pbr("eye", (1, 1, 1, 1), I["eye_a"], None, None, rough=.08),
 "hair": pbr("hair", (.09, .06, .035, 1), None, I["leather_n"], None, rough=.6, nstrength=.25),
 "uniform_jersey": pbr("uniform_jersey", (.8, .8, .8, 1), I["jersey_a"], I["jersey_n"], I["jersey_o"]),
 "uniform_undershirt": pbr("uniform_undershirt", (.05, .08, .3, 1), I["jersey_a"], I["jersey_n"], I["jersey_o"]),
 "uniform_pants": pbr("uniform_pants", (.75, .75, .75, 1), I["pants_a"], I["pants_n"], I["pants_o"]),
 "uniform_socks": pbr("uniform_socks", (.05, .08, .3, 1), I["pants_a"], I["pants_n"], I["pants_o"]),
 "cleats": pbr("cleats", (.03, .03, .03, 1), I["leather_a"], I["leather_n"], I["leather_o"], nstrength=.2),
 "cap": pbr("cap", (.05, .08, .3, 1), I["jersey_a"], I["jersey_n"], I["jersey_o"]),
 "helmet": pbr("helmet", (.05, .08, .3, 1), None, None, None, rough=.3),
 "glove": pbr("glove", (.28, .14, .07, 1), I["leather_a"], I["leather_n"], I["leather_o"], nstrength=.2),
 "catcher_gear": pbr("catcher_gear", (.03, .03, .04, 1), I["leather_a"], I["leather_n"], I["leather_o"], rough=.45, nstrength=.2),
 "belt": pbr("belt", (.02, .02, .02, 1), I["leather_a"], I["leather_n"], I["leather_o"], nstrength=.2),
}

# ---- third-pass materials (recolour via baseColorFactor like the others)
def flat_mat(name, color, rough=.7, metal=0.0, alpha=None):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color; b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if alpha is not None: b.inputs["Alpha"].default_value = alpha; m.surface_render_method = 'BLENDED'
    return m
MATS["piping"] = pbr("piping", (.05, .08, .3, 1), I["jersey_a"], I["jersey_n"], I["jersey_o"])                       # contrast trim (sleeve bands, placket, pants stripe, sock stripes)
MATS["button"] = flat_mat("button", (.85, .85, .82, 1), .35)
MATS["batting_glove"] = pbr("batting_glove", (.03, .03, .035, 1), I["leather_a"], I["leather_n"], I["leather_o"], rough=.55, nstrength=.2)
MATS["wristband"] = pbr("wristband", (.9, .9, .9, 1), I["pants_a"], I["pants_n"], I["pants_o"])
MATS["arm_sleeve"] = pbr("arm_sleeve", (.03, .03, .04, 1), I["pants_a"], I["pants_n"], I["pants_o"], rough=.6)
MATS["eyeblack"] = flat_mat("eyeblack", (.015, .015, .015, 1), .85)
MATS["stubble"] = flat_mat("stubble", (.06, .045, .035, 1), .9, alpha=.42)
MATS["laces"] = flat_mat("laces", (.92, .92, .9, 1), .7)
MATS["sole"] = pbr("sole", (.04, .04, .045, 1), I["leather_a"], I["leather_n"], I["leather_o"], rough=.7, nstrength=.2)
MATS["buckle"] = flat_mat("buckle", (.78, .78, .8, 1), .28, metal=1.0)
MATS["glove_laces"] = pbr("glove_laces", (.55, .38, .2, 1), I["leather_a"], I["leather_n"], I["leather_o"], rough=.7, nstrength=.15)

MATS["jacket"] = pbr("jacket", (.05, .08, .3, 1), I["jersey_a"], I["jersey_n"], I["jersey_o"], rough=.7)

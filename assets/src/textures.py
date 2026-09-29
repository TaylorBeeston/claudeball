# Procedural (numpy) tileable PBR textures. Requires common.py exec'd.
import numpy as np

def _tile(n, scales, seed): return noise_tex(n, scales, seed)

def grass_tex(n=2048, seed=1):
    rng = np.random.default_rng(seed)
    low = _tile(n, [4, 8, 16, 32], seed); dry = _tile(n, [3, 6], seed+9)
    img = np.zeros((n, n, 3), np.float32)
    dark = np.array([0.040, 0.15, 0.028]); mid = np.array([0.105, 0.29, 0.045]); light = np.array([0.20, 0.40, 0.085]); yel = np.array([0.24, 0.32, 0.07])
    t = low[..., None]; img[:] = dark*(1-t) + mid*t
    img = img*(1-0.25*dry[..., None]) + yel*(0.25*dry[..., None])*0.6
    hgt = np.zeros((n, n), np.float32)
    m = 700000
    xs = rng.integers(0, n, m); ys = rng.integers(0, n, m)
    ang = rng.normal(0.9, 0.55, m); ln = rng.integers(4, 12, m)                 # blades lean in a common direction with scatter
    shade = rng.random(m).astype(np.float32)
    for k in range(12):
        mk = ln > k
        px = (xs[mk] + (np.cos(ang[mk])*k*.9).astype(int)) % n; py = (ys[mk] + (np.sin(ang[mk])*k*1.1).astype(int)) % n
        c = (mid[None]*(1-shade[mk, None]) + light[None]*shade[mk, None]) * (0.62 + 0.38*k/11)
        img[py, px] = c; hgt[py, px] = np.maximum(hgt[py, px], 0.25 + 0.75*k/11)
    img *= (0.86 + 0.28*_tile(n, [256, 512], seed+7))[..., None]
    return np.clip(img, 0, 1), hgt
def dirt_tex(n=2048, seed=2, base=(0.36, 0.22, 0.12), var=0.35):
    rng = np.random.default_rng(seed)
    low = _tile(n, [3, 6, 12, 24, 48], seed)
    mid = _tile(n, [64, 128, 256], seed+1)
    grain = _tile(n, [512, 1024], seed+2)
    b = np.array(base)
    t = (0.55*low + 0.3*mid + 0.15*grain)[..., None]
    img = b[None, None, :] * (1 - var + 2*var*t)
    hgt = 0.5*mid + 0.5*grain
    m = 30000                                   # pebbles
    xs = rng.integers(2, n-2, m); ys = rng.integers(2, n-2, m); c = rng.uniform(0.6, 1.3, m)
    for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
        img[ys+dy, xs+dx] = (b[None]*c[:, None]*0.9).clip(0, 1); hgt[ys+dy, xs+dx] += 0.5
    return np.clip(img, 0, 1), hgt

def vc_material(name, base_img, nrm_img, rough=0.9, nstrength=1.0, ormimg=None, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = base_img
    va = nt.nodes.new("ShaderNodeVertexColor"); va.layer_name = "Color"
    mx = nt.nodes.new("ShaderNodeMix"); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs[0].default_value = 1.0
    nt.links.new(t.outputs["Color"], mx.inputs[6]); nt.links.new(va.outputs["Color"], mx.inputs[7])
    nt.links.new(mx.outputs[2], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough; b.inputs["Specular IOR Level"].default_value = 0.2
    if nrm_img:
        n = nt.nodes.new("ShaderNodeTexImage"); n.image = nrm_img
        nm = nt.nodes.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = nstrength
        nt.links.new(n.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    b.inputs["Metallic"].default_value = metal
    if ormimg is not None: add_orm(nt, b, ormimg)
    return m

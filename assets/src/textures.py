# Procedural (numpy) tileable PBR textures. Requires common.py exec'd.
import numpy as np

def _tile(n, scales, seed): return noise_tex(n, scales, seed)

def grass_tex(n=2048, seed=1):
    rng = np.random.default_rng(seed)
    low = _tile(n, [4, 8, 16, 32], seed)
    img = np.zeros((n, n, 3), np.float32)
    dark = np.array([0.045, 0.16, 0.03]); mid = np.array([0.11, 0.30, 0.05]); light = np.array([0.22, 0.42, 0.09])
    t = low[..., None]
    img[:] = dark*(1-t) + mid*t
    hgt = np.zeros((n, n), np.float32)
    m = 260000
    xs = rng.integers(0, n, m); ys = rng.integers(0, n, m)
    ang = rng.uniform(0, 2*np.pi, m); ln = rng.integers(3, 9, m)
    shade = rng.random(m).astype(np.float32)
    for k in range(9):                      # splat short blade strokes
        mk = ln > k
        px = (xs[mk] + (np.cos(ang[mk])*k).astype(int)) % n; py = (ys[mk] + (np.sin(ang[mk])*k).astype(int)) % n
        c = (mid[None]*(1-shade[mk, None]) + light[None]*shade[mk, None]) * (0.75 + 0.25*k/8)
        img[py, px] = c; hgt[py, px] = 0.4 + 0.6*k/8
    fine = _tile(n, [256, 512], seed+7)[..., None]
    img *= 0.85 + 0.3*fine
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

def vc_material(name, base_img, nrm_img, rough=0.9, nstrength=1.0):
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
    return m

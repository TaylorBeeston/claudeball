import bpy, numpy as np, os
ROOT = os.environ.get("CB_ASSETS", "/home/taylor/.herdr/worktrees/claudeball/hp-claudeball-t-0003-assets-blender-stadium-and-players/assets")

def reset_scene():
    bpy.ops.object.select_all(action='SELECT') if bpy.context.object else None
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
    for d in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves, bpy.data.armatures, bpy.data.actions):
        for b in list(d): d.remove(b)

def noise_tex(n, scales, seed=0):
    rng = np.random.default_rng(seed)
    out = np.zeros((n, n), np.float32); amp = 1.0; tot = 0
    for s in scales:
        g = rng.random((s, s)).astype(np.float32)
        # tileable bilinear upsample
        idx = np.linspace(0, s, n, endpoint=False)
        i0 = idx.astype(int); f = (idx - i0).astype(np.float32); i1 = (i0 + 1) % s
        f = f*f*(3-2*f)
        a = g[i0][:, i0]*(1-f)[None]+g[i0][:, i1]*f[None]
        b = g[i1][:, i0]*(1-f)[None]+g[i1][:, i1]*f[None]
        out += amp*(a*(1-f)[:, None]+b*f[:, None]); tot += amp; amp *= 0.5
    return out/tot

def make_image(name, arr, colorspace='sRGB', path=None):
    h, w = arr.shape[:2]
    if arr.ndim == 2: arr = np.repeat(arr[..., None], 3, 2)
    if arr.shape[2] == 3: arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], 2)
    img = bpy.data.images.new(name, w, h, alpha=False)
    img.colorspace_settings.name = colorspace  # must precede pixel upload (changing it clears pixels)
    img.pixels.foreach_set(np.clip(arr, 0, 1).astype(np.float32).ravel())
    if path:
        img.filepath_raw = path; img.file_format = 'PNG'; img.save()
    img.pack()
    return img

def height_to_normal(h, strength=2.0):
    dx = (np.roll(h, -1, 1)-np.roll(h, 1, 0*1+1))*strength
    dy = (np.roll(h, -1, 0)-np.roll(h, 1, 0))*strength
    n = np.stack([-dx, -dy, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n*0.5+0.5

def pbr_material(name, base, nrm=None, rough=0.6, metal=0.0, orm=None, nstrength=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    if base is not None:
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = base
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if nrm is not None:
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = nrm
        nm = nt.nodes.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = nstrength
        nt.links.new(t.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    return m

def export(objs, path, **kw):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, use_selection=True, export_format='GLB', export_yup=True,
        export_image_format='JPEG' if kw.pop('jpg', False) else 'AUTO', export_apply=True, **kw)

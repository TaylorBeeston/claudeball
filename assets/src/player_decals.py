# Jersey decal meshes: thin curved patches that conform to the jersey surface (1 mm above it), skinned like the jersey, with their own 0-1 UV map. The engine fills their
# textures per player (last name, number); the arch of the name is baked into the mesh so the engine writes STRAIGHT text.
# Requires common.py, player_rig.py (JOINTS), player_extra.py (_obj, copy_weights) exec'd.
import bpy, bmesh, math, numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

# name: kind, centre, size (width, height in metres) and the recommended texture size (same aspect as the patch)
DECALS = {
 "Jersey_BackNameDecal":     dict(kind="back",   c=(0.0, 1.405),  size=(.40, .10),   arch=.50, tex=(1024, 256), mat="jersey_decal_name"),
 "Jersey_BackNumberDecal":   dict(kind="back",   c=(0.0, 1.185),  size=(.25, .25),   arch=0.0, tex=(512, 512),  mat="jersey_decal_backnum"),
 "Jersey_FrontNumberDecal":  dict(kind="front",  c=(-.085, 1.365), size=(.14, .14),  arch=0.0, tex=(256, 256),  mat="jersey_decal_frontnum"),
 "Jersey_SleeveNumberDecal": dict(kind="sleeve", s=.52,           size=(.085, .085), arch=0.0, tex=(128, 128),  mat="jersey_decal_sleevenum"),
}
def _bvh(obj):
    bm = bmesh.new(); bm.from_mesh(obj.data); t = BVHTree.FromBMesh(bm); bm.free(); return t
def build_decal(name, jersey, spec, off=.001, nu=None, nv=6):
    """Patch of (nu x nv) quads on the jersey: u runs along the text (left to right as the viewer sees it), v up. Returns the object (unweighted, no material)."""
    bvh = _bvh(jersey); W, H = spec["size"]; R = spec.get("arch", 0.0); kind = spec["kind"]; nu = nu or (24 if R else 8)
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap"); grid = []; nrm_sum = Vector((0, 0, 0)); miss = 0
    if kind == "sleeve":
        sh, el = JOINTS["LeftArm"][1], JOINTS["LeftForeArm"][1]; a = (el - sh).normalized(); P0 = sh + (el - sh)*spec["s"]
        o = Vector((1, 0, .35)); o = (o - a*o.dot(a)).normalized(); b = a.cross(o)
        if b.y < 0: b = -b                                                                   # u runs toward the back (+y) as seen from outside
        rc = .055
    for j in range(nv + 1):
        v = j/nv; row = []
        for i in range(nu + 1):
            u = i/nu
            if kind == "sleeve":
                phi = (u - .5)*W/rc; dirv = o*math.cos(phi) + b*math.sin(phi); org = P0 - a*((v - .5)*H) + dirv*.18; d = -dirv
            else:
                if R:
                    th = (.5 - u)*W/R if kind == "back" else (u - .5)*W/R; rad = R + (v - .5)*H; px = rad*math.sin(th); pz = spec["c"][1] - R + rad*math.cos(th)
                else:
                    px = spec["c"][0] + ((.5 - u)*W if kind == "back" else (u - .5)*W); pz = spec["c"][1] + (v - .5)*H
                if R: px += spec["c"][0]
                org = Vector((px, .6 if kind == "back" else -.6, pz)); d = Vector((0, -1, 0)) if kind == "back" else Vector((0, 1, 0))
            loc, n, idx, dist = bvh.ray_cast(org, d)
            if loc is None: miss += 1; loc, n = org + d*.45, -d
            nrm_sum += n; row.append((bm.verts.new(loc + n.normalized()*off), u, v))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            q = (grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i])
            f = bm.faces.new([x[0] for x in q])
            for lp, x in zip(f.loops, q): lp[uvl].uv = (x[1], x[2])
    bm.normal_update(); fn = sum((f.normal for f in bm.faces), Vector((0, 0, 0)))
    if fn.dot(nrm_sum) < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.normal_update()
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    o_ = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o_); o_["cb_decal_misses"] = miss; return o_

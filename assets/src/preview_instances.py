# preview only: expand instanced seats + crowd into real meshes in the current Blender scene (call after stadium.py; mirror already applied to templates)
import bpy, numpy as np
def expand(name, pos, yaw):
    tpl = bpy.data.objects[name]; me = tpl.data
    tv = np.empty(len(me.vertices)*3, np.float32); me.vertices.foreach_get("co", tv); tv = tv.reshape(-1, 3)      # blender coords (mirrored)
    tris = []; mi = []
    for p in me.polygons:
        vs = list(p.vertices)
        for k in range(1, len(vs)-1): tris.append((vs[0], vs[k], vs[k+1])); mi.append(p.material_index)
    tris = np.array(tris); mi = np.array(mi); n = len(pos); nv = len(tv)
    # pos/yaw here are in *exported* game coords (already mirrored): convert to blender (x,-z,y); yaw about game Y = about blender Z (sign kept)
    c, s = np.cos(yaw)[:, None], np.sin(yaw)[:, None]
    gx, gy, gz = tv[:, 0], tv[:, 2], -tv[:, 1]                       # template vertex in (mirrored) game coords
    X = gx[None]*c + gz[None]*s + pos[:, None, 0]; Z = -gx[None]*s + gz[None]*c + pos[:, None, 2]; Y = gy[None] + pos[:, None, 1]
    G = np.stack([X, -Z, Y], 2).reshape(-1, 3)
    F = (tris[None] + (np.arange(n)*nv)[:, None, None]).reshape(-1, 3)
    m2 = bpy.data.meshes.new("prev_"+name); m2.from_pydata(G.tolist(), [], F.tolist())
    for m in me.materials: m2.materials.append(m)
    m2.polygons.foreach_set("material_index", np.tile(mi, n))
    o = bpy.data.objects.new("Prev_"+name, m2); bpy.context.collection.objects.link(o); tpl.hide_render = True
d = np.load(ROOT+"/src/seats.npz"); c = np.load(ROOT+"/src/crowd.npz")
for t in range(3): expand(f"Seats_T{t+1}", d[f"pos{t}"]*np.array([-1, 1, 1], np.float32), -d[f"yaw{t}"])
for i in range(8): expand(f"Crowd_{i+1}", c[f"pos{i}"]*np.array([-1, 1, 1], np.float32), -c[f"yaw{i}"])

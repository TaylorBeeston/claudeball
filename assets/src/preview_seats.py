# Preview only: expand instanced seats into one mesh in the current Blender scene (never exported).
import bpy, numpy as np
d = np.load(ROOT+"/src/seats.npz")
for t in range(3):
    tpl = bpy.data.objects[f"Seats_T{t+1}"]; me = tpl.data
    tv = np.empty(len(me.vertices)*3, np.float32); me.vertices.foreach_get("co", tv); tv = tv.reshape(-1, 3)
    tv = np.stack([tv[:, 0], tv[:, 2], -tv[:, 1]], 1)   # to game
    faces = [tuple(p.vertices) for p in me.polygons]
    pos, yaw = d[f"pos{t}"], d[f"yaw{t}"]
    n = len(pos); c, s = np.cos(yaw)[:, None], np.sin(yaw)[:, None]
    X = tv[None, :, 0]*c + tv[None, :, 2]*s + pos[:, None, 0]; Z = -tv[None, :, 0]*s + tv[None, :, 2]*c + pos[:, None, 2]; Y = tv[None, :, 1]+pos[:, None, 1]
    G = np.stack([X, Y, Z], 2).reshape(-1, 3); nv = len(tv)
    fv = np.array([f for f in faces if len(f) == 3] + [], np.int64)
    fa = np.concatenate([np.array(f, np.int64)[None] for f in faces]) if all(len(f) == 3 for f in faces) else None
    tris = np.array(faces, np.int64)
    F = (tris[None]+ (np.arange(n)*nv)[:, None, None]).reshape(-1, 3)
    m2 = bpy.data.meshes.new(f"prev{t}"); m2.from_pydata(np.stack([G[:, 0], -G[:, 2], G[:, 1]], 1).tolist(), [], F.tolist()); m2.materials.append(tpl.data.materials[0])
    o = bpy.data.objects.new(f"PrevSeats{t}", m2); bpy.context.collection.objects.link(o); tpl.hide_render = True

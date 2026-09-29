# usage inside Blender: exec after building a scene; sets up camera+sun and renders to RENDER_OUT
import bpy
from mathutils import Vector
def snap(out, loc, target, lens=35, res=(1200, 800), sun=4.0, ortho=None):
    sc = bpy.context.scene
    for n in ("tcam", "tl"):
        if n in bpy.data.objects: bpy.data.objects.remove(bpy.data.objects[n])
    cam = bpy.data.objects.new("tcam", bpy.data.cameras.new("tcam")); sc.collection.objects.link(cam)
    cam.location = loc; cam.rotation_euler = (Vector(target)-Vector(loc)).to_track_quat('-Z', 'Y').to_euler(); cam.data.lens = lens
    cam.data.clip_end = 2000
    if ortho: cam.data.type = 'ORTHO'; cam.data.ortho_scale = ortho
    sc.camera = cam
    l = bpy.data.objects.new("tl", bpy.data.lights.new("tl", 'SUN')); l.data.energy = sun; l.rotation_euler = (0.9, 0.2, 0.6); sc.collection.objects.link(l)
    w = bpy.data.worlds.get("tw") or bpy.data.worlds.new("tw"); w.use_nodes = True; w.node_tree.nodes["Background"].inputs[1].default_value = 1.2; sc.world = w
    sc.render.resolution_x, sc.render.resolution_y = res; sc.render.filepath = out
    bpy.ops.render.render(write_still=True)

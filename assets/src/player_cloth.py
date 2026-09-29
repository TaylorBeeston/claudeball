# Clothing shells derived from the skinned body (same topology subset => identical vertex weights) + gear meshes.
import bpy, bmesh, math, numpy as np
from mathutils import Vector, Matrix
from collections import Counter

def dominant_bone(me, obj):
    names = {g.index: g.name.replace(PFX, "") for g in obj.vertex_groups}
    dom = []
    for v in me.vertices:
        best = max(v.groups, key=lambda g: g.weight) if len(v.groups) else None
        dom.append(names[best.group] if best else "Hips")
    return dom

def region_of(face_center, dom_bones):
    c = face_center; b = Counter(dom_bones).most_common(1)[0][0]; z, ax = c.z, abs(c.x)
    if b in ("Head", "Neck") : return "skin"
    if b.endswith("Hand"): return "skin"
    if b.endswith("ForeArm"): return "undershirt"
    if b.endswith("Arm") or b.endswith("Shoulder"): return "jersey" if z < 1.58 else "skin"
    if b in ("Hips", "Spine", "Spine1", "Spine2"):
        if z > 1.535 and ax < .11: return "skin"
        return "jersey" if z >= .985 else "pants"
    if b.endswith("UpLeg"): return "pants" if z < .985 else "jersey"
    if b.endswith("Leg"): return "pants" if z > .50 else ("socks" if z > .115 else "cleats")
    if b.endswith("Foot") or b.endswith("ToeBase"): return "cleats"
    return "skin"

def fold_field(P, kind):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]; ax = np.abs(x)
    n = (np.sin(23*x + 9*z + 2*y)*np.cos(17*y + 11*z) + .6*np.sin(41*z + 13*x) + .4*np.sin(29*x - 37*y + 5*z))*.35
    f = np.zeros(len(P))
    if kind == "jersey":
        f += .0035*n
        f += .0055*np.exp(-((z-1.02)/.05)**2)*np.sin(38*x + 3*y)             # hem bunching over the belt
        f += .0045*np.exp(-(((ax-.17)/.05)**2 + ((z-1.40)/.07)**2))*np.sin(30*z)   # armpit folds
        f += .004*np.exp(-((z-1.29)/.09)**2)*np.sin(22*x+40*z)*(y < 0)       # chest drape
    elif kind == "pants":
        f += .0035*n
        f += .006*np.exp(-((z-.53)/.06)**2)*np.sin(34*np.arctan2(x-np.sign(x)*.09, y+.01)*1.0 + 8*z)   # knee gather
        f += .005*np.exp(-((z-.93)/.07)**2)*(y < 0.02)*np.sin(26*x + 6*z)    # hip crease
    elif kind == "undershirt":
        f += .0025*n + .003*np.exp(-((z-1.25)/.12)**2)*np.sin(70*z)          # elbow wrinkles (arm hangs in A-pose; z ~ elbow)
    else: f += .0015*n
    return f

def make_shell(body, name, region, offset):
    me = body.data; dom = dominant_bone(me, body)
    keep = [p.index for p in me.polygons if region_of(p.center, [dom[i] for i in p.vertices]) == region]
    o = body.copy(); o.data = body.data.copy(); o.name = name; bpy.context.collection.objects.link(o)
    bm = bmesh.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
    kill = [f for f in bm.faces if f.index not in set(keep)]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.verts.ensure_lookup_table(); bm.normal_update()
    P = np.array([v.co[:] for v in bm.verts]); Nn = np.array([v.normal[:] for v in bm.verts])
    ff = fold_field(P, region if region in ("jersey", "pants", "undershirt") else "x")
    P2 = P + Nn*(offset + ff)[:, None]
    if region == "cleats": P2[:, 2] = np.maximum(P2[:, 2], 0.0)
    for v, p in zip(bm.verts, P2): v.co = Vector(p)
    bm.to_mesh(o.data); bm.free()
    for p in o.data.polygons: p.use_smooth = True
    # skin/armature bookkeeping: vertex groups are copied with the object; ensure modifier exists
    return o

def keep_skin_only(body):
    me = body.data; dom = dominant_bone(me, body)
    bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
    kill = [f for f in bm.faces if region_of(f.calc_center_median(), [dom[v.index] for v in f.verts]) != "skin"]
    bmesh.ops.delete(bm, geom=kill, context='FACES'); bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(me); bm.free()

def set_weight(o, arm, bone, verts=None):
    vg = o.vertex_groups.get(PFX+bone) or o.vertex_groups.new(name=PFX+bone)
    vg.add(list(range(len(o.data.vertices))) if verts is None else verts, 1.0, 'REPLACE')

def rig(o, arm):
    o.parent = arm
    if not any(m.type == 'ARMATURE' for m in o.modifiers):
        md = o.modifiers.new("Armature", 'ARMATURE'); md.object = arm

# ------------------------------------------------------------ gear
def bm_from(objf):
    bm = bmesh.new(); objf(bm); me = bpy.data.meshes.new("g"); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    return me
def dome(bm, R, cz, sq=1.0, seam=0.0, zmin=None, seg=64, ring=40, cx=0, cy=0, edge=None, thick=.004):
    """upper dome (z >= zmin) around the head, radii R=(rx,ry,rz)."""
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=ring, radius=1.0)
    for v in list(bm.verts):
        x, y, z = v.co; ph = math.atan2(x, -y)
        g = -seam*(np.exp(-(math.sin(3*ph)/.06)**2)) * max(0, z)              # 6 panel seams
        v.co = Vector((x*(R[0]+g), y*(R[1]+g), z*(R[2]+g*.6))) + Vector((cx, cy, cz))
    if edge is not None: cut_bm(bm, lambda co: co.z - edge(co.x, co.y))
    elif zmin is not None: bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < zmin], context='VERTS')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    if thick: bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=-thick)
def brow_edge(front, side, back):
    def f(x, y):
        ph = math.atan2(x, -y); w = max(0.0, math.cos(ph))**3
        base = side + (back-side)*_sm(-.01, .085, y)                       # eased from the temples to the nape (no step)
        return base + (front-base)*w
    return f
def brim(bm, cz, length=.085, width=.16, thick=.006, droop=.03, ycenter=-.098):
    """curved bill in front of the head (extruded arc)."""
    n = 44; rows = 9; verts = []
    for r in range(rows):
        t = r/(rows-1)
        for i in range(n):
            a = math.radians(-46 + 92*i/(n-1)); rad = .100 + length*t
            x = rad*math.sin(a)*(width/.16)*1.15; y = -rad*math.cos(a)*1.03 - .004
            z = cz + .003 - droop*(t**1.5) - .055*(abs(math.sin(a))**2)*t
            verts.append(bm.verts.new((x, y, z)))
    for r in range(rows-1):
        for i in range(n-1):
            bm.faces.new((verts[r*n+i], verts[r*n+i+1], verts[(r+1)*n+i+1], verts[(r+1)*n+i]))
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=thick)
def tube(bm, pts, r, seg=6):
    for a, b in zip(pts, pts[1:]): capsule(bm, a, b, r, seg)
def cage_mask(bm, catcher=True):
    cz = 1.72; zf = -.115
    ring = [(.075*math.sin(a), zf-.02*abs(math.sin(a)), cz+.02+.095*math.cos(a)) for a in np.linspace(-math.pi*.9, math.pi*.9, 20)]
    tube(bm, ring, .0035)
    for zz in (cz-.05, cz-.02, cz+.01, cz+.045, cz+.08):
        w = .075*math.sqrt(max(0, 1-((zz-(cz+.02))/.105)**2)); tube(bm, [(-w, zf-.015, zz), (0, zf-.05, zz), (w, zf-.015, zz)], .0028)
    for xx in (-.05, -.025, 0, .025, .05):
        tube(bm, [(xx, zf-.012, cz-.075), (xx, zf-.045, cz), (xx, zf-.012, cz+.11)], .0028)
    for sx in (-1, 1): tube(bm, [(sx*.078, -.05, cz+.02), (sx*.079, zf+.02, cz+.02)], .004)
def chest_prot(bm):
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        x, y, z = v.co; v.co = Vector((x*.43, y*.075, z*.50))
    bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=3, use_grid_fill=True)
    for v in bm.verts:
        v.co.y += -.04*(1 - (v.co.x/.215)**2)*.6 - .012*abs(v.co.z/.25)      # curve around torso
        v.co = v.co + Vector((0, -.135, 1.29))
    for sx in (1, -1):
        s = bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=.07)
        for v in s["verts"]: v.co = Vector((v.co.x*1.0 + sx*.20, v.co.y*.9 - .01, v.co.z*.8 + 1.47))
def shin_guard(bm, sx):
    for (z0, z1, r, y) in ((.15, .34, .066, -.055), (.34, .48, .072, -.06)):
        capsule(bm, (sx*.09, y, z0), (sx*.09, y-.004, z1), r, 14)
    s = bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=.075)
    for v in s["verts"]: v.co = Vector((v.co.x*.9 + sx*.09, v.co.y*.7 - .085, v.co.z*.8 + .53))
def belt(bm):
    bmesh.ops.create_cone(bm, cap_ends=False, segments=48, radius1=1.0, radius2=1.0, depth=.04)
    for v in bm.verts: v.co = Vector((v.co.x*.246, v.co.y*.170 + .008, v.co.z + .962))
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=.006)
    bmesh.ops.create_cube(bm, size=1.0)                                                  # buckle
    for v in list(bm.verts)[-8:]: v.co = Vector((v.co.x*.03, v.co.y*.008 - .162, v.co.z*.03 + .962))
def collar(bm):
    bmesh.ops.create_cone(bm, cap_ends=False, segments=36, radius1=1.0, radius2=1.0, depth=.032)
    for v in bm.verts: v.co = Vector((v.co.x*.112, v.co.y*.092 - .006, v.co.z + 1.535))
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=.012)
def glove(bm):
    wr = JOINTS["LeftHand"][1]; dvec = (JOINTS["LeftHand"][2]-wr).normalized()
    zdir = dvec; xdir = Vector((-1, 0, 0)); ydir = zdir.cross(xdir).normalized(); xdir = ydir.cross(zdir).normalized()
    W = lambda lx, ly, lz: wr + xdir*lx + ydir*ly + zdir*lz
    def blob(c, r):
        s = bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=12, radius=1.0)
        M = Matrix([[r[0], 0, 0], [0, r[1], 0], [0, 0, r[2]]]); R = Matrix((xdir, ydir, zdir)).transposed()
        for v in s["verts"]: v.co = R @ (M @ v.co) + c
    blob(W(.032, 0, .085), (.038, .058, .075))                                    # pocket / palm pad
    for ly, ln in ((-.032, .095), (-.011, .105), (.010, .10), (.031, .085)):        # finger sleeves
        blob(W(.045, ly, .085+ln*.6), (.014, .013, ln*.55))
    blob(W(.04, -.062, .075), (.020, .020, .07))                                   # thumb sleeve
    blob(W(.062, -.005, .11), (.010, .05, .075))                                   # web / heel
    blob(W(-.02, 0, .01), (.03, .045, .04))                                        # wrist strap
def helmet(bm, flap=1):
    dome(bm, (.106, .126, .122), 1.735, edge=brow_edge(1.775, 1.665, 1.665), cy=.003, thick=.006)
    brim(bm, 1.735-.005, length=.06, width=.13, thick=.008, droop=.02)
    s = bmesh.ops.create_uvsphere(bm, u_segments=18, v_segments=12, radius=1.0)                # left ear flap (right-handed batter)
    for v in s["verts"]: v.co = Vector((v.co.x*.014 + .098*flap, v.co.y*.06 - .005, v.co.z*.06 + 1.700))
def cap(bm):
    dome(bm, (.093, .112, .120), 1.735, seam=.0035, edge=brow_edge(1.778, 1.695, 1.685), cy=.003)
    brim(bm, 1.735-.004, length=.075, width=.15, thick=.005, droop=.028)
    s = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=.008)
    for v in s["verts"]: v.co += Vector((0, .0, 1.735+.121))
def hair(bm):
    dome(bm, (.092, .114, .130), 1.7265, edge=brow_edge(1.805, 1.70, 1.66), cy=.004, thick=.002)
    for v in bm.verts:
        v.co.z += .003*math.sin(v.co.x*260)*math.cos(v.co.y*210)

# ------------------------------------------------------------ smooth cuts (no stepped edges)
def cut_bm(bm, fn):
    """Cut `bm` exactly along the isoline fn(co) == 0 and delete the negative side (fn > 0 is kept). Crossing edges are split (custom data such as
    vertex-group weights is interpolated) and the faces re-split between the new vertices, so the boundary is a smooth curve instead of a staircase of faces."""
    bm.verts.ensure_lookup_table(); val = {v: fn(v.co) for v in bm.verts}
    for v, x in list(val.items()):
        if x == 0.0: val[v] = 1e-9
    cross = [e for e in bm.edges if (val[e.verts[0]] > 0) != (val[e.verts[1]] > 0)]
    new = set()
    for e in cross:
        a, b = e.verts; t = val[a]/(val[a]-val[b]); ne, nv = bmesh.utils.edge_split(e, a, t); val[nv] = 0.0; new.add(nv)
    for f in list(bm.faces):
        nv = [v for v in f.verts if v in new]
        if len(nv) == 2:
            loop = [l.vert for l in f.loops]; i, j = loop.index(nv[0]), loop.index(nv[1])
            if abs(i-j) not in (1, len(loop)-1):
                try: bmesh.utils.face_split(f, nv[0], nv[1])
                except Exception: pass
    dead = [f for f in bm.faces if any(val.get(v, 1.0) < -1e-12 for v in f.verts)]
    bmesh.ops.delete(bm, geom=dead, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')

def _sm(a, b, x): t = min(1.0, max(0.0, (x-a)/(b-a))); return t*t*(3-2*t)
NECK_C = (0.0, -.006); NECK_R = (.098, .084)
def neck_z0(y): return 1.50 + .03*max(-1.0, min(1.0, (y-NECK_C[1])/.08))       # crew-neck scoop: lower in front (-Y), higher at the back
def neck_f(p, r=1.0, dz=0.0):
    """> 0 outside the neck opening (or below its scoop), < 0 inside it."""
    e = math.hypot((p[0]-NECK_C[0])/(NECK_R[0]*r), (p[1]-NECK_C[1])/(NECK_R[1]*r)) - 1.0
    return min(max(e, (neck_z0(p[1]) + dz - p[2])*8.0), 1.0)
D_ARM_ = Vector((.766, 0, -.643)); SH_ = Vector((.21, 0, 1.50))
def arm_t(p):
    """(t, rho): position along the left-arm axis from the shoulder joint, and distance from that axis (x is mirrored for the right arm)."""
    q = Vector((abs(p[0]), p[1], p[2])) - SH_; t = q.dot(D_ARM_); return t, (q - D_ARM_*t).length
def in_arm(p, t, rho): return t > -.05 and rho < .118 and abs(p[0]) > .16 and p[2] < 1.62

def f_jersey(Ls):
    def f(p):
        hem = .955 - .03*max(0.0, min(1.0, p[1]*6))                              # longer tail at the back
        t, rho = arm_t(p); fs = (Ls - t) if in_arm(p, t, rho) else 1.0
        return min(p[2] - hem, neck_f(p), fs)
    return f
def f_undershirt(p):
    t, rho = arm_t(p); fw = (.545 - t) if in_arm(p, t, rho) else 1.0
    return min(p[2] - .94, neck_f(p, .93, .012), fw)
def f_pants(zh):
    def f(p): return min(1.015 - p[2], p[2] - zh, .30 - abs(p[0]))
    return f
def f_socks(p): return min(.53 - p[2], p[2] - .108, .30 - abs(p[0]))
def f_cleats(p): return min(.128 - p[2], .30 - abs(p[0]))
def f_skin_neck(p):
    e = math.hypot((p[0]-NECK_C[0])/NECK_R[0], (p[1]-NECK_C[1])/NECK_R[1]) - 1.0
    return min(.30 - e, p[2] - 1.445, 1.72 - p[2])

def make_shell_cut(body, name, fn, kind, offset, taper_top=0.0):
    """Clothing shell: copy of the whole skinned body cut along the smooth field `fn`, then pushed out along the normals (+ fabric folds)."""
    o = body.copy(); o.data = body.data.copy(); o.name = name; bpy.context.collection.objects.link(o)
    bm = bmesh.new(); bm.from_mesh(o.data); cut_bm(bm, lambda co: fn(co))
    bm.verts.ensure_lookup_table(); bm.normal_update()
    P = np.array([v.co[:] for v in bm.verts]); Nn = np.array([v.normal[:] for v in bm.verts])
    ff = fold_field(P, kind if kind in ("jersey", "pants", "undershirt") else "x")
    off = offset - taper_top*np.clip((P[:, 2]-.94)/.075, 0, 1)**2*(3-2*np.clip((P[:, 2]-.94)/.075, 0, 1)) if taper_top else offset
    P2 = P + Nn*(off + ff)[:, None]
    if kind == "cleats": P2[:, 2] = np.maximum(P2[:, 2], 0.0)
    for v, p in zip(bm.verts, P2): v.co = Vector(p)
    bm.to_mesh(o.data); bm.free()
    for p in o.data.polygons: p.use_smooth = True
    return o

def cut_object(o, fn):
    bm = bmesh.new(); bm.from_mesh(o.data); cut_bm(bm, fn); bm.to_mesh(o.data); bm.free()

def neck_collar(bm, r=.0068, seg=8, n=72, out=.0135):
    """Ribbed crew collar: a tube following the neck opening curve of the jersey (so it hides the cut edge), slightly outside and above it."""
    rings = []
    for i in range(n):
        ph = 2*math.pi*i/n; x = NECK_C[0] + (NECK_R[0]+out)*math.cos(ph); y = NECK_C[1] + (NECK_R[1]+out)*math.sin(ph); z = neck_z0(y) + .011
        rings.append((Vector((x, y, z)), ph))
    vs = []
    for i, (c, ph) in enumerate(rings):
        nxt = rings[(i+1) % n][0]; prv = rings[(i-1) % n][0]; t = (nxt-prv).normalized(); radial = Vector((math.cos(ph), math.sin(ph), 0)); up = Vector((0, 0, 1))
        a = t.cross(up).normalized(); b = t.cross(a).normalized()
        vs.append([bm.verts.new(c + (a*math.cos(2*math.pi*k/seg)*r*1.25 + b*math.sin(2*math.pi*k/seg)*r*.8)) for k in range(seg)])
    for i in range(n):
        for k in range(seg): bm.faces.new((vs[i][k], vs[i][(k+1) % seg], vs[(i+1) % n][(k+1) % seg], vs[(i+1) % n][k]))

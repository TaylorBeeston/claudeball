# Extra player parts: hair styles, facial hair, uniform trim, accessories, soles/laces. Requires common.py, player_rig.py, player_body.py, player_cloth.py exec'd.
# Every builder returns a Blender object (mesh in model space, rest pose), not yet weighted / rigged / assigned a material (the build script does that).
import bpy, bmesh, math, numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

# ---------------------------------------------------------------- helpers
def _obj(name, bm, smooth=True):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = smooth
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o); return o
def bvh_of(obj):
    bm = bmesh.new(); bm.from_mesh(obj.data); t = BVHTree.FromBMesh(bm); bm.free(); return t
def hit(bvh, origin, direction):
    loc, nrm, idx, dist = bvh.ray_cast(Vector(origin), Vector(direction)); return (loc, nrm) if loc is not None else (None, None)
def surface_strip(bm, bvh, samples, width, lift, closed=False):
    """samples: list of (origin, direction) rays; builds a ribbon lying on the first surface hit by every ray (missing rays are skipped)."""
    pts = []
    for o, d in samples:
        l, n = hit(bvh, o, d)
        if l is not None: pts.append((l, n.normalized()))
    if len(pts) < 2: return
    m = len(pts); rows = []
    for i, (p, n) in enumerate(pts):
        a = pts[(i-1) % m][0] if (closed or i > 0) else p; b = pts[(i+1) % m][0] if (closed or i < m-1) else p
        t = (b-a).normalized(); s = n.cross(t).normalized()
        rows.append((bm.verts.new(p + n*lift + s*width/2), bm.verts.new(p + n*lift - s*width/2)))
    for i in range(m-1 + (1 if closed else 0)):
        j = (i+1) % m; bm.faces.new((rows[i][0], rows[i][1], rows[j][1], rows[j][0]))
def blob(bm, c, r, sq=(1, 1, 1), seg=10, ring=6):
    s = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=ring, radius=1.0)
    for v in s["verts"]: v.co = Vector((v.co.x*r*sq[0], v.co.y*r*sq[1], v.co.z*r*sq[2])) + Vector(c)
def ring_samples(center, axis, up_hint, radius, n=32, t0=0.0):
    """rays from an axis outward, one per angle around it."""
    axis = Vector(axis).normalized(); u = (Vector(up_hint) - axis*Vector(up_hint).dot(axis)).normalized(); w = axis.cross(u)
    out = []
    for k in range(n):
        ph = 2*math.pi*k/n; d = u*math.cos(ph) + w*math.sin(ph); out.append((Vector(center) + d*.005, d))
    return out
def head_copy(head, name, keep_fn, amount_fn, flatten=None):
    """Shell of the Head mesh: faces where keep_fn(q) > 0 (q = position relative to the head centre) are kept and pushed out along the normal by amount_fn."""
    me = head.data.copy(); bm = bmesh.new(); bm.from_mesh(me)
    HCv = Vector(HC)
    cut_bm(bm, lambda co: keep_fn(co - HCv))
    bm.verts.ensure_lookup_table(); bm.normal_update()
    for v in bm.verts:
        q = v.co - HCv; v.co = v.co + v.normal*amount_fn(q)
    return _obj(name, bm)

# ---------------------------------------------------------------- hair styles
def hair_short(bm):   hair(bm)                                                            # existing short crop
def hair_buzz(bm):
    dome(bm, (.0865, .1055, .1265), 1.7265, edge=brow_edge(1.775, 1.705, 1.665), cy=.0035, thick=.0012)
def hair_curly(bm):
    dome(bm, (.093, .116, .129), 1.728, edge=brow_edge(1.80, 1.69, 1.655), cy=.004, thick=.002, seg=72, ring=48)
    for v in bm.verts:
        x, y, z = v.co; n = math.sin(x*92+1.3)*math.sin(y*84+.4)*math.sin(z*88+2.1); k = 1 + .045*n
        v.co = Vector((x, y-.004, z-1.728))*k + Vector((0, .004, 1.728))
def hair_long(bm):
    dome(bm, (.089, .111, .124), 1.728, edge=brow_edge(1.80, 1.685, 1.62), cy=.004, thick=.003)
    rows, n = 12, 41; verts = []
    for r in range(rows):
        t = r/(rows-1); z = 1.70 - .21*t
        for i in range(n):
            ph = math.radians(-112 + 224*i/(n-1)); rx = .092 + .012*t + .004*math.sin(i*1.3+r); ry = .103 + .016*t
            verts.append(bm.verts.new((math.sin(ph)*rx, .004 + math.cos(ph)*ry + .01*t*t, z + .003*math.sin(i*.9+r*.7))))
    for r in range(rows-1):
        for i in range(n-1): bm.faces.new((verts[r*n+i], verts[r*n+i+1], verts[(r+1)*n+i+1], verts[(r+1)*n+i]))
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=.004)

# ---------------------------------------------------------------- facial hair (shells of the head mesh; mouth left open so the lips show)
def _mouth(q, rx=.031, rz=.017, zc=-.056):
    return math.hypot(q.x/rx, (q.z-zc)/rz) - 1.0 if q.y < -.05 else 1.0
def beard_keep(top=-.030):
    def f(q):
        edge = top + .050*max(0.0, min(1.0, (abs(q.x)-.040)/.038))              # sideburns rise toward the ear
        return min(edge - q.z, .048 - q.y, .076 - abs(q.x), _mouth(q)*.2)
    return f
def stubble_keep(q):
    edge = -.006 + .020*max(0.0, min(1.0, (abs(q.x)-.045)/.03))
    return min(edge - q.z, .045 - q.y, .078 - abs(q.x), _mouth(q, .028, .012, -.052)*.2)
def _taper(v, k=.014): return max(0.0, min(1.0, v/k))
def beard_full(head):
    f = beard_keep(); return head_copy(head, "Gear_Beard_Full", f, lambda q: .0018 + .0065*_taper(f(q))*(1 + .35*max(0.0, -q.z-.07)/.05))
def beard_stubble(head):
    return head_copy(head, "Gear_Beard_Stubble", stubble_keep, lambda q: .0007*_taper(stubble_keep(q), .008))
def mustache(head):
    def f(q): return min(.030 - abs(q.x), q.z + .048, -.030 - q.z, -q.y + .060)
    return head_copy(head, "Gear_Mustache", f, lambda q: .0012 + .0052*_taper(f(q), .006))
def goatee(head):
    def f(q): return min(.021 - abs(q.x), q.z + .108, -.072 - q.z, -q.y + .055)
    return head_copy(head, "Gear_Goatee", f, lambda q: .0015 + .0065*_taper(f(q), .008))
def eye_black(head):
    def f(q):
        e = min(math.hypot((q.x-.037)/.014, (q.z+.006)/.0042), math.hypot((q.x+.037)/.014, (q.z+.006)/.0042))
        return (1.0 - e) if q.y < -.05 else -1.0
    return head_copy(head, "Gear_EyeBlack", f, lambda q: .0009)

# ---------------------------------------------------------------- uniform trim (lies on the default `Jersey` / `Pants` / `Socks` surfaces)
def _arm_frame(sx):
    d = Vector((D_ARM_.x*sx, 0, D_ARM_.z)); sh = Vector((SH_.x*sx, 0, SH_.z)); return sh, d
def piping(jersey, pants, socks):
    """Gear_Piping: sleeve-end stripes, front placket line, pants side stripes, sock stripes (one mesh, material `piping`)."""
    bm = bmesh.new(); bj, bp, bs = bvh_of(jersey), bvh_of(pants), bvh_of(socks)
    for sx in (1, -1):
        sh, d = _arm_frame(sx)
        for tt in (.285, .262):                                                            # two bands at the elbow-length sleeve end
            c = sh + d*tt; surface_strip(bm, bj, ring_samples(c, d, (0, -1, 0), .09, 36), .012, .0022, closed=True)
        surface_strip(bm, bp, [(Vector((sx*1.0, .004, z)), Vector((-sx, 0, 0))) for z in np.linspace(1.0, .53, 24)], .016, .0022)     # pants side stripe
        for z in (.36, .395, .43):                                                          # stirrup / sock stripes
            surface_strip(bm, bs, ring_samples((sx*.09, .012, z), (0, 0, 1), (0, -1, 0), .07, 32), .012, .0018, closed=True)
    surface_strip(bm, bj, [(Vector((0, -1.0, z)), Vector((0, 1, 0))) for z in np.linspace(1.455, .995, 28)], .020, .0024)        # front placket
    return _obj("Gear_Piping", bm)
def buttons(jersey):
    bm = bmesh.new(); bj = bvh_of(jersey)
    for z in (1.40, 1.30, 1.20, 1.10, 1.02):
        l, n = hit(bj, Vector((0, -1.0, z)), Vector((0, 1, 0)))
        if l is not None: blob(bm, l + n*.0035, .0055, (1, 1, .55), 10, 6)
    return _obj("Gear_Buttons", bm)

# ---------------------------------------------------------------- accessories
def batting_glove(hand, side):
    me = hand.data.copy(); bm = bmesh.new(); bm.from_mesh(me); bm.normal_update()
    for v in bm.verts: v.co = v.co + v.normal*.0022
    sx = 1 if side == "Left" else -1
    wr = JOINTS[side+"Hand"][1]; dvec = (JOINTS[side+"Hand"][2]-wr).normalized(); ring = bmesh.ops.create_cone(bm, cap_ends=False, segments=20, radius1=.033, radius2=.033, depth=.028)
    R = dvec.to_track_quat('Z', 'Y').to_matrix()
    for v in ring["verts"]: v.co = R @ v.co + wr + dvec*.006
    return _obj("Gear_BattingGlove_"+side[0], bm)
def wristband(side):
    sx = 1 if side == "Left" else -1; sh, d = _arm_frame(sx); bm = bmesh.new()
    ring = bmesh.ops.create_cone(bm, cap_ends=False, segments=24, radius1=.0355, radius2=.0355, depth=.045)
    R = d.to_track_quat('Z', 'Y').to_matrix()
    for v in ring["verts"]: v.co = R @ v.co + sh + d*.53
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=.004)
    return _obj("Gear_Wristband_"+side[0], bm)
def f_armsleeve(sx, t0=.10, t1=.56):
    def f(p):
        t, rho = arm_t(p)
        return min(t - t0, t1 - t, sx*p[0] - .12) if in_arm(p, t, rho) else -1.0
    return f

# ---------------------------------------------------------------- shoes: soles and laces
def _sole_half_width(y):
    return np.interp(y, [.06, .03, -.02, -.08, -.14, -.20, -.245, -.262], [.020, .046, .046, .040, .049, .047, .034, .012])
def soles(cleats):
    """Gear_Soles: a dark rubber slab under each foot following the foot outline (0-15 mm thick)."""
    bm = bmesh.new(); ys = np.linspace(.050, -.246, 33); ws = [float(_sole_half_width(y)) for y in ys]
    for sx in (1, -1):
        top, bot = [], []
        for y, w in zip(ys, ws): top += [bm.verts.new((sx*.09 - w, y, .015)), bm.verts.new((sx*.09 + w, y, .015))]
        for y, w in zip(ys, ws): bot += [bm.verts.new((sx*.09 - w*1.01, y, 0.0)), bm.verts.new((sx*.09 + w*1.01, y, 0.0))]
        for i in range(len(ys)-1):
            a, b = 2*i, 2*(i+1)
            bm.faces.new((top[a], top[a+1], top[b+1], top[b])); bm.faces.new((bot[a], bot[b], bot[b+1], bot[a+1]))
            bm.faces.new((top[a], top[b], bot[b], bot[a])); bm.faces.new((top[a+1], bot[a+1], bot[b+1], top[b+1]))
        bm.faces.new((top[0], bot[0], bot[1], top[1])); bm.faces.new((top[-2], top[-1], bot[-1], bot[-2]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    return _obj("Gear_Soles", bm)
def laces(cleats):
    bm = bmesh.new(); bc = bvh_of(cleats)
    for sx in (1, -1):
        for y in np.linspace(-.040, -.150, 6):
            l1, n1 = hit(bc, Vector((sx*.09 - .028, y, .5)), Vector((0, 0, -1))); l2, n2 = hit(bc, Vector((sx*.09 + .028, y, .5)), Vector((0, 0, -1)))
            lm, nm = hit(bc, Vector((sx*.09, y, .5)), Vector((0, 0, -1)))
            if None in (l1, l2, lm): continue
            pts = [l1 + n1*.0024, lm + nm*.0032, l2 + n2*.0024]
            for a, b in zip(pts, pts[1:]): capsule(bm, a, b, .0022, 6)
    return _obj("Gear_Laces", bm)

# ---------------------------------------------------------------- cap / helmet details
def cap_eyelets(bm):
    for k in range(6):
        ph = 2*math.pi*(k+.5)/6; r = .062
        blob(bm, (math.sin(ph)*.093*.55, -math.cos(ph)*.112*.55 + .003, 1.735 + .120*.83), .0034, (1, 1, .5), 8, 5)
def helmet_v2(bm, flap=1):
    """Batting helmet: hard shell + ear flap (with ear hole) on the left side for a right-handed batter + short bill."""
    def edge(x, y):
        base = brow_edge(1.775, 1.668, 1.662)(x, y); dip = .05*math.exp(-(((x-.095*flap)/.045)**2 + ((y-.004)/.055)**2)); return base - dip
    dome(bm, (.106, .126, .122), 1.735, edge=edge, cy=.003, thick=.006)
    def hole(co):
        if co.x*flap < .05: return 1.0
        return math.hypot((co.y-.004)/.021, (co.z-1.706)/.021) - 1.0
    cut_bm(bm, hole)
    brim(bm, 1.735-.005, length=.06, width=.13, thick=.008, droop=.03)

# ---------------------------------------------------------------- weights
def copy_weights(dst, srcs):
    """Nearest-vertex weight transfer from the given (already weighted) source objects; creates the same vertex groups on dst."""
    from mathutils.kdtree import KDTree
    pts = []
    for so in srcs:
        names = {g.index: g.name for g in so.vertex_groups}
        for v in so.data.vertices: pts.append((v.co.copy(), [(names[g.group], g.weight) for g in v.groups]))
    kd = KDTree(len(pts))
    for i, (c, _) in enumerate(pts): kd.insert(c, i)
    kd.balance()
    for v in dst.data.vertices:
        _, i, _ = kd.find(v.co)
        for nm, w in pts[i][1]:
            vg = dst.vertex_groups.get(nm) or dst.vertex_groups.new(name=nm); vg.add([v.index], w, 'REPLACE')
def weights_by(dst, fn):
    """fn(co) -> {bone_name (without prefix): weight}"""
    for v in dst.data.vertices:
        for nm, w in fn(v.co).items():
            if w > 0: vg = dst.vertex_groups.get(PFX+nm) or dst.vertex_groups.new(name=PFX+nm); vg.add([v.index], w, 'REPLACE')

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
    dome(bm, (.0885, .1125, .1285), 1.7262, edge=brow_edge(1.785, 1.705, 1.665), cy=.0035, thick=.0012)
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
def _mouth(q, rx=.031, rz=.017, zc=-.092):
    return math.hypot(q.x/rx, (q.z-zc)/rz) - 1.0 if q.y < -.05 else 1.0
def beard_keep(top=-.052):
    def f(q):
        edge = top + .050*max(0.0, min(1.0, (abs(q.x)-.040)/.038))              # sideburns rise toward the ear
        return min(edge - q.z, .060 - q.y, .090 - abs(q.x), _mouth(q)*.2, q.z + .142, max(q.z + .118, -q.y - .075))
    return f
def stubble_keep(q):
    edge = -.040 + .020*max(0.0, min(1.0, (abs(q.x)-.045)/.03))
    return min(edge - q.z, .060 - q.y, .088 - abs(q.x), _mouth(q, .028, .012, -.090)*.2, q.z + .142, max(q.z + .118, -q.y - .075))
def _taper(v, k=.014): return max(0.0, min(1.0, v/k))
def beard_full(head):
    f = beard_keep(); return head_copy(head, "Gear_Beard_Full", f, lambda q: .0018 + .0065*_taper(f(q))*(1 + .35*max(0.0, -q.z-.10)/.05))
def beard_stubble(head):
    return head_copy(head, "Gear_Beard_Stubble", stubble_keep, lambda q: .0007*_taper(stubble_keep(q), .008))
def mustache(head):
    def f(q): return min(.030 - abs(q.x), q.z + .080, -.061 - q.z, -q.y + .070)
    return head_copy(head, "Gear_Mustache", f, lambda q: .0012 + .0052*_taper(f(q), .006))
def goatee(head):
    def f(q): return min(.021 - abs(q.x), q.z + .138, -.104 - q.z, -q.y + .070)
    return head_copy(head, "Gear_Goatee", f, lambda q: .0015 + .0065*_taper(f(q), .008))
def eye_black(head):
    def f(q):
        e = min(math.hypot((q.x-.036)/.014, (q.z+.019)/.0042), math.hypot((q.x+.036)/.014, (q.z+.019)/.0042))
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
            sv = [v.co for v in socks.data.vertices if abs(v.co.z - z) < .012 and v.co.x*sx > 0]; cx, cy = (sum(v.x for v in sv)/len(sv), sum(v.y for v in sv)/len(sv)) if sv else (sx*.1, 0.0)
            surface_strip(bm, bs, ring_samples((cx, cy, z), (0, 0, 1), (0, -1, 0), .07, 32), .012, .0018, closed=True)
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
def make_cleats(body, off=.0085, ztop=.128):
    """Baseball cleat from the foot: convex hull of the foot vertices below `ztop` (closes the toe gaps), subdivided, smoothed, pushed >= 4 mm clear of the skin, cut open at the ankle."""
    bmb = bmesh.new(); bmb.from_mesh(body.data); bvh_b = BVHTree.FromBMesh(bmb); bmb.free()
    bm = bmesh.new()
    for sx in (1, -1):
        pts = [v.co.copy() for v in body.data.vertices if v.co.z < ztop + .02 and v.co.x*sx > .02 and v.co.y < .10]
        tmp = bmesh.new(); vs = [tmp.verts.new(p) for p in pts]; res = bmesh.ops.convex_hull(tmp, input=vs, use_existing_faces=False)
        dv = {g for g in list(res["geom_interior"]) + list(res["geom_unused"]) if isinstance(g, bmesh.types.BMVert)}; bmesh.ops.delete(tmp, geom=list(dv), context='VERTS')
        bmesh.ops.subdivide_edges(tmp, edges=list(tmp.edges), cuts=2, use_grid_fill=True)
        for _ in range(10): bmesh.ops.smooth_vert(tmp, verts=list(tmp.verts), factor=.45, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        tmp.normal_update()
        for v in tmp.verts:
            v.co = v.co + v.normal*off
            if v.co.z < .004: v.co.z = 0.0
        for _ in range(3):
            for v in tmp.verts:
                loc, n, i, d = bvh_b.find_nearest(v.co)
                if loc is not None and (v.co - loc).dot(n) < .004 and d < .02: v.co = loc + n*.004
        cut_bm(tmp, lambda co: ztop - co.z)
        mp = {}; 
        for v in tmp.verts: mp[v] = bm.verts.new(v.co)
        for f in tmp.faces: bm.faces.new([mp[v] for v in f.verts])
        tmp.free()
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    o = _obj("Cleats", bm); copy_weights(o, [body]); return o
def soles(cleats):
    """Gear_Soles: a dark rubber slab under each shoe (outline = the shoe's footprint from 72 angular bins, 0-18 mm thick, slightly larger than the shoe)."""
    bm = bmesh.new()
    for sx in (1, -1):
        pts = np.array([(v.co.x, v.co.y) for v in cleats.data.vertices if v.co.z < .035 and v.co.x*sx > 0]); c = pts.mean(0); ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0]); rad = np.hypot(pts[:, 0] - c[0], pts[:, 1] - c[1])
        nb = 72; edge = np.zeros(nb)
        for k in range(nb):
            m = (ang >= -math.pi + 2*math.pi*k/nb) & (ang < -math.pi + 2*math.pi*(k + 1)/nb); edge[k] = rad[m].max() if m.any() else 0.0
        for _ in range(3): edge = (np.roll(edge, 1) + 2*edge + np.roll(edge, -1))/4
        edge = np.maximum(edge, .02) + .004
        top = [bm.verts.new((c[0] + edge[k]*math.cos(-math.pi + 2*math.pi*(k + .5)/nb), c[1] + edge[k]*math.sin(-math.pi + 2*math.pi*(k + .5)/nb), .019)) for k in range(nb)]
        bot = [bm.verts.new((c[0] + (edge[k] + .0015)*math.cos(-math.pi + 2*math.pi*(k + .5)/nb), c[1] + (edge[k] + .0015)*math.sin(-math.pi + 2*math.pi*(k + .5)/nb), 0.0)) for k in range(nb)]
        for k in range(nb):
            k2 = (k + 1) % nb; bm.faces.new((top[k], top[k2], bot[k2], bot[k])); 
        bm.faces.new(top[::-1]); bm.faces.new(bot)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    return _obj("Gear_Soles", bm)
def spikes(soles_obj):
    """Gear_Spikes: six metal cleats (short cones, 8 mm) under each sole: three rows (toe / ball / heel)."""
    bm = bmesh.new()
    for sx in (1, -1):
        pts = np.array([(v.co.x, v.co.y) for v in soles_obj.data.vertices if abs(v.co.z) < 1e-4 and v.co.x*sx > 0]); x0, x1, y0, y1 = pts[:, 0].min(), pts[:, 0].max(), pts[:, 1].min(), pts[:, 1].max()
        cx, W, L = (x0 + x1)/2, x1 - x0, y1 - y0
        for fy, fx in ((.17, .26), (.17, -.26), (.34, .34), (.34, -.34), (.84, .26), (.84, -.26)):
            c = bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=.0045, radius2=.0016, depth=.009)
            for v in c["verts"]: v.co = Vector((cx + fx*W + v.co.x, y0 + fy*L + v.co.y, -.0045 + v.co.z))
    return _obj("Gear_Spikes", bm)
def cap_logo(cap_obj, text="C", w=.075, h=.052):
    """Gear_CapLogo: a stitched front-panel logo patch following the cap surface (ray-cast grid from the head centre, lifted 1.2 mm); alpha texture is made in player_mats."""
    from mathutils.bvhtree import BVHTree
    bvh = bvh_of(cap_obj); bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap"); nu, nv = 14, 10; grid = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            u = i/nu - .5; v = j/nv - .5; x = u*w; z = 1.815 + v*h
            loc, n, idx, dist = bvh.ray_cast(Vector((x, -.6, z)), Vector((0, 1, 0)))
            if loc is None: row.append(None); continue
            row.append(bm.verts.new(loc + n.normalized()*.0013))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            q = (grid[j][i], grid[j][i+1], grid[j+1][i+1], grid[j+1][i])
            if None in q: continue
            f = bm.faces.new(q)
            for lp, (ii, jj) in zip(f.loops, ((i, j), (i+1, j), (i+1, j+1), (i, j+1))): lp[uvl].uv = (ii/nu, jj/nv)
    return _obj("Gear_CapLogo", bm)
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

# ---------------------------------------------------------------- belt: a 4 cm band cut from the body (so it follows the waist and the build morphs), loops, buckle
BELT_C = Vector((0, -.005, .975))
def finish_belt(belt, thickness=.0055):
    """belt: shell object from make_shell_cut(f_belt). Adds thickness (inward), 7 belt loops; returns (belt, buckle object)."""
    from mathutils.kdtree import KDTree
    src = [(v.co.copy(), [(belt.vertex_groups[g.group].name, g.weight) for g in v.groups]) for v in belt.data.vertices]
    bm = bmesh.new(); bm.from_mesh(belt.data); bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=-thickness); bvh = BVHTree.FromBMesh(bm)
    for ang in (-112, -72, -36, 36, 72, 112, 180):
        a = math.radians(ang); d = Vector((math.sin(a), -math.cos(a), 0)); l, n, i, dist = bvh.ray_cast(BELT_C + d*.5, -d)
        if l is None: continue
        t = n.cross(Vector((0, 0, 1))).normalized(); up = Vector((0, 0, 1)); M = Matrix((t, up, n)).transposed()
        c = bmesh.ops.create_cube(bm, size=1.0)
        for v in c["verts"]: v.co = M @ Vector((v.co.x*.015, v.co.y*.054, v.co.z*.0045)) + l + n*.0016
    bm.to_mesh(belt.data); bm.free()
    for p in belt.data.polygons: p.use_smooth = True
    kd = KDTree(len(src))
    for i, (c, _) in enumerate(src): kd.insert(c, i)
    kd.balance()
    for v in belt.data.vertices:                                                        # weights for the new (solidify / loop) vertices: nearest original belt vertex
        if len(v.groups): continue
        _, i, _ = kd.find(v.co)
        for nm, w in src[i][1]: vg = belt.vertex_groups.get(nm) or belt.vertex_groups.new(name=nm); vg.add([v.index], w, 'REPLACE')
    # buckle: rectangular frame + prong bar at the front centre, weighted like the belt
    bm2 = bmesh.new(); bm3 = bmesh.new(); bm3.from_mesh(belt.data); hb = BVHTree.FromBMesh(bm3); bm3.free()
    l, n, i, dist = hb.ray_cast(BELT_C + Vector((0, -.5, 0)), Vector((0, 1, 0)))
    if l is not None:
        t = Vector((1, 0, 0)); up = Vector((0, 0, 1)); M = Matrix((t, up, n)).transposed()
        def box(cx, cz, sx, sz, th=.0075):
            c = bmesh.ops.create_cube(bm2, size=1.0)
            for v in c["verts"]: v.co = M @ Vector((v.co.x*sx + cx, v.co.y*sz + cz, v.co.z*th)) + l + n*.0022
        W, H, B = .056, .040, .0075
        box(0, H/2-B/2, W, B); box(0, -H/2+B/2, W, B); box(-W/2+B/2, 0, B, H); box(W/2-B/2, 0, B, H); box(.008, 0, .0045, H*.86, .0055)
    bo = _obj("Gear_BeltBuckle", bm2, smooth=False)
    return belt, bo

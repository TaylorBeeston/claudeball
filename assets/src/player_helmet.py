# Batting helmet, catcher's hockey-style helmet + cage, umpire mask. Built from a smooth "star" fit of the head (distance from the skull centre HC to the
# true head surface, ears included, smoothed): the shell is therefore an egg-shaped dome that follows the skull instead of copying every bump of the head mesh.
# Requires common.py, player_rig.py, player_mpfb.py (HC), player_cloth.py (capsule), player_extra.py (_obj), player_headwear.py (_head_bm, brim_from_edge, signed_clearance) exec'd.
import bpy, bmesh, math, numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

NU, NPHI = 96, 54
def _blur(A, su, sp):
    """Gaussian blur of A[u, phi] (wraps in u, clamps in phi)."""
    def k(s): x = np.arange(-int(3*s) - 1, int(3*s) + 2); w = np.exp(-x**2/(2*s*s)); return w/w.sum()
    ku, kp = k(su), k(sp); h = len(ku)//2
    B = np.concatenate([A[-h:], A, A[:h]], 0); B = sum(ku[i]*B[i:i + A.shape[0]] for i in range(len(ku)))
    h = len(kp)//2; C = np.concatenate([np.repeat(B[:, :1], h, 1), B, np.repeat(B[:, -1:], h, 1)], 1); return sum(kp[i]*C[:, i:i + A.shape[1]] for i in range(len(kp)))
def star_radius(head, phi_max=math.radians(152), nu=NU, nphi=NPHI):
    """R[u, phi]: distance from HC to the outermost head surface point along the direction (azimuth u from the front, positive toward +x; polar angle phi from the top)."""
    bvh = BVHTree.FromBMesh(_head_bm(head)); R = np.zeros((nu, nphi))
    for i in range(nu):
        u = 2*math.pi*i/nu
        for j in range(nphi):
            phi = phi_max*j/(nphi - 1); d = Vector((math.sin(phi)*math.sin(u), -math.sin(phi)*math.cos(u), math.cos(phi))); o = Vector(HC); last = 0.0
            for _ in range(6):
                l, n, idx, dist = bvh.ray_cast(o, d)
                if l is None: break
                last = (l - HC).length; o = l + d*1e-4
            R[i, j] = last if last > 0 else .09
    return R, phi_max
def dome(R, phi_max, edge_z, clear, extra=None, rim=.004, smooth=(3.0, 2.0), nu=80, rows=22):
    """Shell around the head: radius = max(blur(R) + clear, R + clear*.6); lower edge at height edge_z(u) (array over the NU azimuths of the star fit); extra(u, phi, t) adds a
    radial bulge; the lower rim rolls out by `rim`. Returns the open (not yet solidified) bmesh."""
    nur, nphi = R.shape; Rs = np.maximum(_blur(R, *smooth) + clear, R + clear*.6); phis = np.linspace(0, phi_max, nphi)
    bm = bmesh.new(); top = bm.verts.new((HC.x, HC.y, HC.z + Rs[:, 0].mean())); ring = []
    ez_u = np.interp(np.arange(nu)*nur/nu, np.arange(nur + 1), np.r_[edge_z, edge_z[:1]])
    for i in range(nu):
        u = 2*math.pi*i/nu; fi = i*nur/nu; i0 = int(fi) % nur; i1 = (i0 + 1) % nur; w = fi - int(fi); prof = Rs[i0]*(1 - w) + Rs[i1]*w
        zs = HC.z + prof*np.cos(phis); phi_e = float(np.interp(ez_u[i], zs[::-1], phis[::-1])); phi_e = max(phi_e, math.radians(40)); col = []
        for r in range(1, rows + 1):
            t = r/rows; phi = phi_e*t; rad = float(np.interp(phi, phis, prof))
            if extra: rad += extra(u, phi, t)
            rad += rim*max(0.0, (t - .93)/.07)**2
            col.append(bm.verts.new((HC.x + rad*math.sin(phi)*math.sin(u), HC.y - rad*math.sin(phi)*math.cos(u), HC.z + rad*math.cos(phi))))
        ring.append(col)
    for i in range(nu):
        i2 = (i + 1) % nu; bm.faces.new((top, ring[i2][0], ring[i][0]))
        for r in range(rows - 1): bm.faces.new((ring[i][r], ring[i2][r], ring[i2][r + 1], ring[i][r + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces); return bm
def finish(bm, thick, cutters=(), name="shell"):
    """Solidify outward by `thick`, then boolean-subtract the cutter meshes (bmeshes) - clean smooth openings."""
    if thick: bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=thick)
    if cutters:
        me = bpy.data.meshes.new(name + "_t"); bm.to_mesh(me); o = bpy.data.objects.new(name + "_t", me); bpy.context.collection.objects.link(o); tmp = [o]
        for k, cb in enumerate(cutters):
            cm = bpy.data.meshes.new("cut"); cb.to_mesh(cm); co = bpy.data.objects.new("cut", cm); bpy.context.collection.objects.link(co); tmp.append(co)
            md = o.modifiers.new("B%d" % k, 'BOOLEAN'); md.operation = 'DIFFERENCE'; md.object = co; md.solver = 'EXACT'
        dg = bpy.context.evaluated_depsgraph_get(); ev = o.evaluated_get(dg); me2 = ev.to_mesh(); bm.clear(); bm.from_mesh(me2); ev.to_mesh_clear()
        for t in tmp: bpy.data.objects.remove(t, do_unlink=True)
        for k in bpy.data.meshes:
            if k.users == 0: bpy.data.meshes.remove(k)
    for f in bm.faces: f.smooth = True
    return bm
class _P:
    def __init__(self, co): self.co = co
def cutter_cyl(centre, axis, radii, length, seg=28):
    """Elliptical cylinder (bmesh) along `axis` ('x' or 'y' or 'z') with the two radii in the other axes, for boolean cuts."""
    cb = bmesh.new(); r = bmesh.ops.create_cone(cb, cap_ends=True, segments=seg, radius1=1.0, radius2=1.0, depth=length)
    for v in r["verts"]:
        x, y, z = v.co
        if axis == 'x': v.co = Vector((z, x*radii[0], y*radii[1]))
        elif axis == 'y': v.co = Vector((x*radii[0], z, y*radii[1]))
        else: v.co = Vector((x*radii[0], y*radii[1], z))
        v.co += Vector(centre)
    return cb
def _edge(front, side, back, nu=NU, dips=()):
    """Lower-edge height around the head (u from the front): `front` at u=0, `side` at +-90 deg, `back` at 180; dips = (u_centre_rad, width_rad, depth_m)."""
    out = []
    for i in range(nu):
        u = 2*math.pi*i/nu; c = math.cos(u); s = abs(math.sin(u)); z = front*max(0, c)**2 + back*max(0, -c)**2 + side*(1 - max(0, c)**2 - max(0, -c)**2)
        for uc, w, d in dips:
            du = (u - uc + math.pi) % (2*math.pi) - math.pi; z -= d*math.exp(-(du/w)**2)
        out.append(z)
    return np.array(out)
def _smooth_edge(z, it=3):
    for _ in range(it): z = (np.roll(z, 1) + 2*z + np.roll(z, -1))/4
    return z

def rounder(R, phi_max, clear, k=1.0, p=2.6):
    """The star fit R pushed out to an ellipsoid around the skull's own extents (front / back / sides / top): a helmet shell is a round dome with room
    in it, not a tight copy of the skull (the old shell followed the skull and read as a tall egg). Returns the radii to hand to `dome`."""
    nu, nphi = R.shape; phis = np.linspace(0, phi_max, nphi); us = 2*np.pi*np.arange(nu)/nu
    S = np.sin(phis)[None, :]; X = R*S*np.sin(us)[:, None]; Y = -R*S*np.cos(us)[:, None]; Z = R*np.cos(phis)[None, :]
    a = np.abs(X).max(); bf = (-Y).max(); bb = Y.max(); c = Z.max()
    E = np.zeros_like(R)
    for i, u in enumerate(us):
        for j, ph in enumerate(phis):
            d = np.array([math.sin(ph)*math.sin(u), -math.sin(ph)*math.cos(u), math.cos(ph)]); b = bf if d[1] < 0 else bb
            cz = c if d[2] > 0 else c*1.25                                                  # below the skull centre the ellipsoid tucks in (no bell at the rim)
            E[i, j] = 1.0/(abs(d[0]/a)**p + abs(d[1]/b)**p + abs(d[2]/cz)**p)**(1.0/p)          # a superellipsoid: widest at the temples, a flatter crown
    return np.maximum(R, R + k*(E - R))

def build_batting_helmet(head, flap=0, name="Gear_Helmet", R=None):
    """MLB-style batting helmet: a round glossy dome (skull fit rounded out to an ellipsoid, 1.6 cm clear incl. padding) that sits low on the brow, longer at
    the back, a short moulded bill, and ear flaps over BOTH ears (flap=0, the default: the user disliked the bare ear of the one-flap helmet; flap=+1/-1 = one
    flap over the left / right ear) with a small ear hole each. Returns (object, inner-surface BVH)."""
    Rh, phi_max = R if R else star_radius(head)
    Rr = rounder(Rh, phi_max, .0165, k=.85)
    sides = (1, -1) if flap == 0 else (flap,)
    dips = tuple((math.radians(90*sd), .52, .092) for sd in sides) + (() if flap == 0 else ((-math.radians(90*flap), .40, -.078),))
    edge = _smooth_edge(_edge(1.772, 1.702, 1.648, dips=dips), 4)
    def extra(u, phi, t):                                                                 # the flaps bulge a little over the ears
        b = 0.0
        for sd in sides:
            du = (u - math.radians(90*sd) + math.pi) % (2*math.pi) - math.pi
            b += .008*math.exp(-(du/.50)**2)*min(1.0, max(0.0, (t - .40)/.40))
        return b
    bm = dome(Rr, phi_max, edge, .0165, extra=extra, rim=.0035, smooth=(3.5, 2.2))
    inner = BVHTree.FromBMesh(bm); edge_pts = [_P(v.co.copy()) for v in bm.verts if v.is_boundary]
    # a small ear hole over each ear canal (~3 cm), not the old 8 x 11 cm window
    cuts = [cutter_cyl((.150*sd, -.034, 1.712), 'x', (.0135, .017), .12) for sd in sides]
    finish(bm, .0050, cutters=cuts, name=name)
    bb = bmesh.new(); brim_from_edge(bb, edge_pts, length=.048, droop=.016, side_curl=.030, thick=.006, arc=42, lift=-.002, rows=7)
    bmesh.ops.recalc_face_normals(bb, faces=bb.faces); bmesh.ops.solidify(bb, geom=list(bb.faces), thickness=.005)
    for f in bb.faces: f.smooth = True
    mesh_into(bm, bb)
    return _obj(name, bm), inner

def build_catcher_helmet(head, name="Gear_Helmet_Catcher", R=None):
    """Hockey-style catcher's helmet: larger smooth shell (2.4 cm clear), covers the ears (ear vents), low back, open face (the cage is Gear_CatcherMask)."""
    Rh, phi_max = R if R else star_radius(head)
    edge = _smooth_edge(_edge(1.768, 1.665, 1.650), 4)
    bm = dome(Rh, phi_max, edge, .024, rim=.004, smooth=(4.0, 2.4)); inner = BVHTree.FromBMesh(bm)
    cuts = [cutter_cyl((s*.12, -.036, 1.716 + dz), 'x', (.016, .0055), .12, 12) for s in (1, -1) for dz in (-.022, 0.0, .022)]
    finish(bm, .0060, cutters=cuts, name=name)
    return _obj(name, bm), inner

# ---------------------------------------------------------------- cage (face guard)
def tube(bm, pts, r, seg=5):
    """Light tube (ring sweep, no end spheres) through the points."""
    pts = [Vector(p) for p in pts]; rings = []
    for i, p in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized(); a = d.cross(Vector((0, 0, 1)) if abs(d.z) < .9 else Vector((1, 0, 0))).normalized(); b = d.cross(a)
        rings.append([bm.verts.new(p + (a*math.cos(2*math.pi*k/seg) + b*math.sin(2*math.pi*k/seg))*r) for k in range(seg)])
    for i in range(len(pts) - 1):
        for k in range(seg): bm.faces.new((rings[i][k], rings[i][(k + 1) % seg], rings[i + 1][(k + 1) % seg], rings[i + 1][k]))

CAGE_Z = (1.560, 1.600, 1.640, 1.685, 1.720, 1.750)
CAGE_YF = (-.190, -.216, -.230, -.236, -.222, -.200)                                    # front depth of the cage at a = 0
CAGE_W = (.062, .084, .098, .103, .102, .099)                                           # half width where the rails reach the sides
CAGE_YC = -.075                                                                          # y of the side rails (in front of the ears)
def cage_pt(a, z, yf_k=1.0):
    zz = np.array(CAGE_Z); yf = float(np.interp(z, zz, CAGE_YF))*yf_k; w = float(np.interp(z, zz, CAGE_W))
    return Vector((w*math.sin(a), CAGE_YC + (yf - CAGE_YC)*math.cos(a), z))
def cage(bm, kind="umpire"):
    """Wire cage over the face. kind: 'umpire' (traditional, 6 horizontal + 5 vertical bars, padded forehead / chin / cheek frame) or 'hockey' (catcher: 4 + 3 bars, thicker)."""
    hz = (1.585, 1.620, 1.655, 1.690, 1.722, 1.746) if kind == "umpire" else (1.600, 1.650, 1.700, 1.745)
    va = (-62, -31, 0, 31, 62) if kind == "umpire" else (-48, 0, 48)
    rb = .0030 if kind == "umpire" else .0036; rf = .0046 if kind == "umpire" else .0052
    A = np.radians(np.linspace(-90, 90, 37))
    for z in hz: tube(bm, [cage_pt(a, z) for a in A], rb, 6)
    zs = np.linspace(CAGE_Z[0] + .004, CAGE_Z[-1] - .004, 26)
    for d in va: tube(bm, [cage_pt(math.radians(d), z) for z in zs], rb, 6)
    for z in (CAGE_Z[0] + .004, CAGE_Z[-1] - .004): tube(bm, [cage_pt(a, z) for a in A], rf, 8)                 # rim bars
    for s in (-1, 1): tube(bm, [cage_pt(s*math.pi/2, z) for z in zs], rf, 8)                                    # side rails
def pad_band(head, z0, z1, a_deg, off, thick, R=None, kind="forehead"):
    """Padding: strip following the skull (star radius + off) between heights z0..z1 and azimuth +-a_deg from the front (a closed band over the forehead / a cup under the chin)."""
    Rh, phi_max = R if R else star_radius(head); Rs = np.maximum(_blur(Rh, 3, 2) + 0, Rh)
    phis = np.linspace(0, phi_max, Rh.shape[1]); bm = bmesh.new(); rows = []
    us = np.radians(np.linspace(-a_deg, a_deg, 31)); zs = np.linspace(z0, z1, 5)
    for z in zs:
        row = []
        for u in us:
            uu = (u % (2*math.pi))*Rh.shape[0]/(2*math.pi); i = int(round(uu)) % Rh.shape[0]
            # find phi for this height: iterate
            phi = math.acos(max(-1, min(1, (z - HC.z)/.11)))
            for _ in range(4):
                r = float(np.interp(phi, phis, Rs[i])) + off; c = (z - HC.z)/r; phi = math.acos(max(-1, min(1, c)))
            r = float(np.interp(phi, phis, Rs[i])) + off
            row.append(bm.verts.new((HC.x + r*math.sin(phi)*math.sin(u), HC.y - r*math.sin(phi)*math.cos(u), z)))
        rows.append(row)
    for r in range(len(rows) - 1):
        for i in range(len(us) - 1): bm.faces.new((rows[r][i], rows[r][i + 1], rows[r + 1][i + 1], rows[r + 1][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=thick)
    return bm
def strap(bm, R, z, u0, u1, w=.016, off=.016, thick=.003, n=40):
    """Elastic strap around the back of the head at height z from azimuth u0..u1 (deg, from the front)."""
    phis = np.linspace(0, math.radians(152), R.shape[1]); up, dn = [], []
    for u in np.radians(np.linspace(u0, u1, n)):
        i = int(round((u % (2*math.pi))*R.shape[0]/(2*math.pi))) % R.shape[0]
        phi = math.acos(max(-1, min(1, (z - HC.z)/.11)))
        for _ in range(4): r = float(np.interp(phi, phis, R[i])) + off; phi = math.acos(max(-1, min(1, (z - HC.z)/r)))
        r = float(np.interp(phi, phis, R[i])) + off
        up.append(bm.verts.new((HC.x + r*math.sin(phi)*math.sin(u), HC.y - r*math.sin(phi)*math.cos(u), z + w/2))); dn.append(bm.verts.new((HC.x + r*math.sin(phi)*math.sin(u), HC.y - r*math.sin(phi)*math.cos(u), z - w/2)))
    for k in range(n - 1): bm.faces.new((up[k], up[k + 1], dn[k + 1], dn[k]))
    return up, dn

def chin_cup(width_deg=62, z0=1.563, depth=.022, height=.030):
    cup = bmesh.new(); rows = []
    for dz in np.linspace(0, height, 4):
        rows.append([cup.verts.new(cage_pt(a, z0) + Vector((0, (depth - .5*dz)*(1 - abs(a)/1.25) , dz))) for a in np.radians(np.linspace(-width_deg, width_deg, 19))])
    for r in range(3):
        for i in range(18): cup.faces.new((rows[r][i], rows[r][i + 1], rows[r + 1][i + 1], rows[r + 1][i]))
    bmesh.ops.recalc_face_normals(cup, faces=cup.faces); bmesh.ops.solidify(cup, geom=list(cup.faces), thickness=.012); return cup
def build_umpire_mask(head, name="Gear_CatcherMask", R=None):
    """Traditional umpire mask: black wire cage + padded forehead / chin frame + two elastic straps behind the ears."""
    Rh, phi_max = R if R else star_radius(head)
    bm = bmesh.new(); cage(bm, "umpire"); n_cage = len(bm.faces)
    mesh_into(bm, pad_band(head, 1.738, 1.762, 72, .018, .012, R=(Rh, phi_max))); mesh_into(bm, chin_cup())
    for z in (1.742, 1.700):
        for (u0, u1) in ((100, 262), (-262, -100)):
            sb = bmesh.new(); strap(sb, Rh, z, u0, u1, off=.022, w=.017); bmesh.ops.solidify(sb, geom=list(sb.faces), thickness=.003); mesh_into(bm, sb)
    for f in bm.faces: f.smooth = True
    o = _obj(name, bm); o["cb_pad_from"] = n_cage; return o
def mesh_into(bm, src):
    mp = {}
    for v in src.verts: mp[v] = bm.verts.new(v.co)
    for f in src.faces: bm.faces.new([mp[v] for v in f.verts])
    src.free()
def build_hockey_cage(head, name="Gear_CatcherMask", R=None):
    """Catcher's cage: thick bars, welded rim; sits in front of the hockey helmet. Black."""
    Rh, phi_max = R if R else star_radius(head)
    bm = bmesh.new(); cage(bm, "hockey"); n_cage = len(bm.faces)
    fb = pad_band(head, 1.746, 1.766, 60, .026, .010, R=(Rh, phi_max)); mesh_into(bm, fb)
    o = _obj(name, bm); o["cb_pad_from"] = n_cage; return o

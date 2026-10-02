# Head-fitted headwear and hair: every piece is built from the head mesh itself (cut along a smooth line, smoothed, pushed out along the normals by a
# clearance), so it follows the skull, can never sit inside it, and uses the same spatial morph function as the head (player_morph.head_morph).
# Requires common.py, player_rig.py, player_body.py (HC), player_cloth.py (cut_bm, brow_edge, capsule), player_extra.py (_obj, blob), player_morph.py exec'd.
import bpy, bmesh, math, numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

def _head_bm(head):
    bm = bmesh.new(); bm.from_mesh(head.data); bm.verts.ensure_lookup_table(); return bm
def signed_clearance(bvh, p):
    loc, n, idx, d = bvh.find_nearest(p)
    return d if (p - loc).dot(n) >= 0 else -d
def keep_largest_island(bm):
    """Delete every connected piece except the biggest (the ears are separate islands of the head mesh)."""
    seen = set(); comps = []
    for f in bm.faces:
        if f in seen: continue
        stack = [f]; seen.add(f); comp = []
        while stack:
            g = stack.pop(); comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h not in seen: seen.add(h); stack.append(h)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    for c in comps[1:]: bmesh.ops.delete(bm, geom=c, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')

def head_shell(head, name, cut_fn, clearance_fn, smooth_iters=8, thick=0.0035, noise=None, min_clear=.004, decorate=None):
    """Shell of the head above `cut_fn` (>0 kept): smoothed, offset by clearance_fn(q) (q = position relative to HC), verified >= min_clear from the true head
    surface (incl. brow ridge / ears), then solidified outward by `thick`. decorate(bm) may add geometry. Returns (object, inner-surface BVH)."""
    hb = _head_bm(head); hbvh = BVHTree.FromBMesh(hb)
    bm = _head_bm(head); cut_bm(bm, cut_fn); keep_largest_island(bm); bm.verts.ensure_lookup_table()
    interior = [v for v in bm.verts if not v.is_boundary]
    for _ in range(smooth_iters): bmesh.ops.smooth_vert(bm, verts=interior, factor=.45, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.normal_update()
    for v in bm.verts:
        q = v.co - HC; c = clearance_fn(q) + (noise(q) if noise else 0.0); v.co = v.co + v.normal*c
    for _ in range(4):                                                                  # push out anything closer than min_clear to the real head
        moved = False
        for v in bm.verts:
            sd = signed_clearance(hbvh, v.co)
            if sd < min_clear:
                loc, n, idx, d = hbvh.find_nearest(v.co); dirv = n if sd < 0 else (v.co - loc).normalized(); v.co = v.co + dirv*(min_clear - sd + .0005); moved = True
        if not moved: break
    inner = BVHTree.FromBMesh(bm)
    if decorate: decorate(bm, inner)
    for v in bm.verts:                                                                  # decorations (seams) must not dip below the clearance either
        sd = signed_clearance(hbvh, v.co)
        if sd < min_clear*.8:
            loc, n, idx, d = hbvh.find_nearest(v.co); v.co = v.co + (n if sd < 0 else (v.co - loc).normalized())*(min_clear*.8 - sd + .0004)
    inner = BVHTree.FromBMesh(bm)
    if thick: bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=thick)
    return bm, inner, hbvh

def _crown_edge(front, side, back): return brow_edge(front, side, back)
def _sm1(a, b, x): t = max(0.0, min(1.0, (x-a)/(b-a))); return t*t*(3-2*t)

def brim_from_edge(bm, inner_bm_verts, length, droop, side_curl, width_taper=0.55, rows=9, arc=60, thick=.0035, lift=0.0):
    """Bill attached along the front of the crown edge: base row = crown boundary vertices in front, rows go outward (radially, longer at the centre),
    curved down toward the sides (banana) and drooping toward the tip."""
    pts = []
    for v in inner_bm_verts:
        q = v.co - HC; ang = math.degrees(math.atan2(q.x, -q.y))
        if abs(ang) <= arc: pts.append((ang, v.co.copy()))
    pts.sort(key=lambda a: a[0])
    if len(pts) < 4: return
    # the cut edge is irregular (uneven vertex spacing, small height/radius jitter): fit smooth r(angle) and z(angle) curves and resample them at even angles, so the bill's ribs are even
    ang = np.array([p[0] for p in pts]); rr = np.array([math.hypot((p[1]-HC).x, (p[1]-HC).y) for p in pts]); zz = np.array([p[1].z for p in pts])
    m = 33; grid_a = np.linspace(ang[0], ang[-1], m)
    def smooth(y):
        k = np.exp(-(np.linspace(-2.5, 2.5, 15))**2/2); k /= k.sum(); pad = np.concatenate([np.full(7, y[0]), y, np.full(7, y[-1])]); return np.convolve(pad, k, mode='valid')
    for _ in range(3): rr = smooth(rr); zz = smooth(zz)
    r_s = np.interp(grid_a, ang, rr); z_s = np.interp(grid_a, ang, zz)
    pts = [(float(a_), Vector((HC.x + r_*math.sin(math.radians(a_)), HC.y - r_*math.cos(math.radians(a_)), z_))) for a_, r_, z_ in zip(grid_a, r_s, z_s)]
    grid = []
    for t in np.linspace(0, 1, rows):
        row = []
        for ang, p in pts:
            a = math.radians(ang); n = Vector((math.sin(a), -math.cos(a), 0)); L = length*(math.cos(a*.85)**.7)
            kf = .55*abs(math.sin(a))**.8; d = (n*(1 - kf) + Vector((0, -1, 0))*kf).normalized()          # the sides of the bill sweep forward, not outward (no sun-hat flare)
            q = p + d*(L*t); q.x = HC.x + (q.x - HC.x)*(1 - .5*width_taper*t)                                # the tip is narrower than the base
            row.append(bm.verts.new(q + Vector((0, 0, lift*t - droop*t**1.6 - side_curl*(math.sin(a)**2)*t))))
        grid.append(row)
    for r in range(rows-1):
        for i in range(len(pts)-1): bm.faces.new((grid[r][i], grid[r][i+1], grid[r+1][i+1], grid[r+1][i]))
    return grid

# ---------------------------------------------------------------- cap
CAP_EDGE = (1.776, 1.772, 1.712)                                   # front / temple / nape edge heights: the sides stay above the ears (ear top 1.754, +1 cm with ears_large)
def build_cap(head):
    edge = _crown_edge(CAP_EDGE[0], CAP_EDGE[1], CAP_EDGE[2])
    def decorate(bm, inner):
        # panel seams: 6 shallow grooves (front centre, +-60, +-120, back centre) on the crown
        for v in bm.verts:
            q = v.co - HC; r = math.hypot(q.x, q.y); psi = math.atan2(q.x, -q.y); best = 9.0
            for k in range(6): d = abs((psi - math.radians(60*k) + math.pi) % (2*math.pi) - math.pi); best = min(best, d)
            g = math.exp(-((best*r)/.0042)**2)*_sm1(1.70, 1.78, v.co.z)
            v.co = v.co - Vector((q.x, q.y, q.z*.6)).normalized()*.0016*g
        bm.normal_update()
        edge_verts = [v for v in bm.verts if v.is_boundary]
        brim_from_edge(bm, edge_verts, length=.072, droop=.030, side_curl=.065, thick=.0035, lift=.004, arc=54, width_taper=.45)
    bm, inner, hbvh = head_shell(head, "Gear_Cap", lambda co: co.z - edge(co.x, co.y), lambda q: .0105 + .004*_sm1(-.02, .12, q.z), smooth_iters=6, thick=.0035, decorate=decorate, min_clear=.006)
    # button, eyelets
    top = Vector((HC.x, HC.y, 1.95))
    l, n, i, d = inner.ray_cast(top, Vector((0, 0, -1)))
    if l is not None: blob(bm, l + Vector((0, 0, .0045)), .0072, (1, 1, .7), 12, 7)
    for k in range(6):
        ph = math.radians(60*k + 30); dirv = Vector((math.sin(ph)*.62, -math.cos(ph)*.62, .78)).normalized()
        l, n, i, d = inner.ray_cast(HC + dirv*.35, -dirv)
        if l is not None: blob(bm, l + n*.005, .0032, (1, 1, .45), 8, 5)
    return _obj("Gear_Cap", bm), inner

# ---------------------------------------------------------------- batting helmet (ear flap on the left for a right-handed batter)
def build_helmet(head, flap=1):
    ear = Vector((.092*flap, -.040, 1.716))
    def edge(x, y):
        base = _crown_edge(1.762, 1.676, 1.655)(x, y); dip = .085*math.exp(-(((x-.095*flap)/.05)**2 + ((y+.025)/.045)**2)) if x*flap > 0 else 0.0
        return base - dip
    def decorate(bm, inner):
        edge_verts = [v for v in bm.verts if v.is_boundary]
        brim_from_edge(bm, edge_verts, length=.052, droop=.012, side_curl=.014, thick=.006, arc=36, lift=.002, rows=6)
    def hole(co):                                                                       # ear opening, big enough for `ears_large` (ear ~ 0.03 x 0.045 m)
        if co.x*flap < .04: return 1.0
        return math.hypot((co.y-ear.y)/.036, (co.z-ear.z)/.050) - 1.0
    bm, inner, hbvh = head_shell(head, "Gear_Helmet", lambda co: min(co.z - edge(co.x, co.y), hole(co)*.05), lambda q: .0125 + .002*_sm1(-.02, .1, q.z), smooth_iters=12, thick=.0055, decorate=decorate, min_clear=.0085)
    return _obj("Gear_Helmet", bm), inner

# ---------------------------------------------------------------- hair (hugs the skull; variants by thickness / texture)
def hair_edge(front=1.806, side=1.760, back=1.655): return _crown_edge(front, side, back)
def build_hair(head, name, thickness, noise_amp=0.0, noise_freq=90, front=1.806, side=1.760, back=1.655, long_back=False, thick_solid=.0015, smooth_iters=4):
    edge = hair_edge(front, side, back)
    def noise(q):
        if not noise_amp: return 0.0
        return noise_amp*(math.sin(q.x*noise_freq+1.3)*math.sin(q.y*(noise_freq*.9)+.4)*math.sin(q.z*(noise_freq*.95)+2.1))
    def decorate(bm, inner):
        if long_back:
            rows, n = 12, 41
            verts = []
            for r in range(rows):
                t = r/(rows-1); z = 1.70 - .21*t
                for i in range(n):
                    ph = math.radians(-74 + 148*i/(n-1)); rx = .096 + .012*t + .004*math.sin(i*1.3+r); ry = .108 + .016*t
                    verts.append(bm.verts.new((math.sin(ph)*rx, HC.y + .010 + math.cos(ph)*ry + .01*t*t, z + .003*math.sin(i*.9+r*.7))))
            for r in range(rows-1):
                for i in range(n-1): bm.faces.new((verts[r*n+i], verts[r*n+i+1], verts[(r+1)*n+i+1], verts[(r+1)*n+i]))
    def ear_notch(co):                                                                  # keep the hair off the ears
        return 1.0 if abs(co.x) < .04 else (math.hypot((co.y-.006)/.038, (co.z-1.722)/.052) - 1.0)*.05
    bm, inner, hbvh = head_shell(head, name, lambda co: min(co.z - edge(co.x, co.y), ear_notch(co)), lambda q: thickness, smooth_iters=smooth_iters, thick=thick_solid, noise=noise, decorate=decorate, min_clear=thickness*.6)
    return _obj(name, bm)

# ---------------------------------------------------------------- shape keys: hair squashed under a cap / helmet
def add_under_cap_key(obj, cap_inner, name="hair_under_cap", margin=.0012):
    """Shape key that pushes every hair vertex lying under the cap crown down onto the crown's inner surface (vertices below the cap edge are left alone)."""
    me = obj.data; obj.shape_key_add(name="Basis", from_mix=False) if me.shape_keys is None else None
    sk = obj.shape_key_add(name=name, from_mix=False); sk.slider_min = 0.0; sk.slider_max = 1.0
    P = np.empty(len(me.vertices)*3, np.float32); me.vertices.foreach_get("co", P); P = P.reshape(-1, 3).astype(np.float64)
    out = P.copy(); n_sq = 0
    for i, p in enumerate(P):
        v = Vector(p) - HC; r = v.length
        if r < 1e-6: continue
        d = v/r; loc, nrm, idx, dist = cap_inner.ray_cast(HC + d*.02, d)
        if loc is not None and dist + .02 < r + margin:
            out[i] = np.array((HC + d*(dist + .02 - margin))[:]); n_sq += 1
    sk.data.foreach_set("co", out.astype(np.float32).ravel()); return n_sq

# ---------------------------------------------------------------- numeric fit report over all head morph extremes
def morph_positions(obj, fn, names):
    me = obj.data; P = np.empty(len(me.vertices)*3, np.float32); me.vertices.foreach_get("co", P); P = P.reshape(-1, 3).astype(np.float64)
    for nm in names: P = fn(P, nm)
    return P
def fit_report(head, items, morph_sets):
    """items: {name: (obj, [morph names it supports])}. For each morph set (applied to the head; and to an item only where it has that key) returns the
    smallest signed distance of any item vertex from the (morphed) head surface. Negative = penetration."""
    out = {}
    for ms in morph_sets:
        hp = morph_positions(head, head_morph, ms); bm = bmesh.new(); bm.from_mesh(head.data)
        bm.verts.ensure_lookup_table()
        for v, p in zip(bm.verts, hp): v.co = Vector(p)
        bvh = BVHTree.FromBMesh(bm); bm.free()
        for nm, (obj, keys) in items.items():
            ip = morph_positions(obj, head_morph, [k for k in ms if k in keys])
            out.setdefault(nm, {})["+".join(ms) or "rest"] = round(min(signed_clearance(bvh, Vector(p)) for p in ip), 4)
    return out

def hair_cap_gap(cap_obj, hair_obj, cap_edge=None):
    """Smallest radial gap (cap inner surface minus hair surface) over hair vertices lying under the cap crown; negative = hair pokes through the cap."""
    edge = brow_edge(*(cap_edge or CAP_EDGE)); cb = bmesh.new(); cb.from_mesh(cap_obj.data); bvh = BVHTree.FromBMesh(cb); cb.free(); worst = 9.0; n = 0
    for v in hair_obj.data.vertices:
        if v.co.z < edge(v.co.x, v.co.y) + .004: continue
        d = v.co - HC; r = d.length; d = d / r; l, nn, i, dist = bvh.ray_cast(HC + d*.02, d)
        if l is None or nn.dot(d) > 0: continue                      # only the crown's inner surface counts
        worst = min(worst, (dist + .02) - r); n += 1
    return round(worst, 4), n
def fit_summary(head, gear):
    items = {"cap": (gear["Gear_Cap"], ["head_narrow", "head_wide", "brow_heavy"]), "helmet": (gear["Gear_Helmet"], ["head_narrow", "head_wide", "ears_large", "jaw_square", "brow_heavy"])}
    for k, n in (("hair", "Gear_Hair"), ("buzz", "Gear_Hair_Buzz"), ("curly", "Gear_Hair_Curly"), ("long", "Gear_Hair_Long")): items[k] = (gear[n], ["head_narrow", "head_wide", "ears_large", "brow_heavy"])
    sets = [[], ["head_narrow"], ["head_wide"], ["jaw_square"], ["nose_large"], ["ears_large"], ["head_narrow", "jaw_square", "nose_large"], ["head_wide", "ears_large"], ["brow_heavy"], ["head_wide", "brow_heavy"]]
    return {"min_clearance_from_head": fit_report(head, items, sets), "hair_under_cap_gap": {n: hair_cap_gap(gear["Gear_Cap"], gear[n]) for n in ("Gear_Hair", "Gear_Hair_Buzz", "Gear_Hair_Curly")}}

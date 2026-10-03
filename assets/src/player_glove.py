# Fielder / first-base / catcher gloves built around an open hand mesh that sits fully inside them.
# Hand-local frame (left hand): +x = palm normal (toward the ball when catching), +y = thumb side, +z = along the fingers, origin = the wrist joint.
# Requires common.py, player_rig.py (JOINTS), player_anim.py (hand_frame), player_body.py (hand_mesh, capsule), player_cloth.py (set_weight), player_extra.py (_obj).
import bpy, bmesh, math, numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

# ---------------------------------------------------------------- the open hand that lives inside the glove
def open_hand(side="Left", name="Hand_L_Open"):
    """Flat, slightly relaxed hand (fingers nearly straight) - the hand as it sits in the glove (never seen: the glove covers it entirely)."""
    return hand_mesh(side, curl=.10, spread=6, name=name, seg=10, thumb_tip=(.010, -.062, .088))

# ---------------------------------------------------------------- glove kinds (all lengths in metres, hand-local coordinates)
#   back / pad: x of the back of the glove and of the flat pad front; pocket: ball-centre (x, y, z) and pocket sphere radius;
#   fingers: (length to the fingertip, half spread of the four finger centres, finger half-thickness x, finger radius y); thumb: (tip y, tip z)
KINDS = {
 "infield":   dict(grow=1.05, node="Gear_Glove",           pocket_node="Glove_Pocket",           back=-.056, pad=.064, half_w=.066, heel_z=(-.030, .075), pocket=(.080, -.004, .112), pr=.0425, fingers=(.205, .036, .034, .0215), thumb=(-.088, .150)),
 "outfield":  dict(node="Gear_Glove_Outfield",  pocket_node="Glove_Pocket_Outfield",  back=-.058, pad=.068, half_w=.071, heel_z=(-.030, .080), pocket=(.086, -.004, .128), pr=.0420, fingers=(.232, .038, .035, .0225), thumb=(-.094, .170)),
 "firstbase": dict(node="Gear_Glove_FirstBase", pocket_node="Glove_Pocket_FirstBase", back=-.056, pad=.062, half_w=.060, heel_z=(-.030, .075), pocket=(.078, -.004, .150), pr=.0425, fingers=(.240, .0, .033, .0300), thumb=(-.080, .190)),
 "catcher":   dict(grow=1.10, node="Gear_Glove_Catcher",   pocket_node="Glove_Pocket_Catcher",   back=-.060, pad=.076, half_w=.104, heel_z=(-.030, .080), pocket=(.096, -.004, .118), pr=.0450, fingers=(.215, .0, .040, .0),   thumb=(-.100, .120)),
}

def _add_ellipsoid(bm, c, r, seg=28, ring=18):
    s = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=ring, radius=1.0)
    for v in s["verts"]: v.co = Vector((v.co.x*r[0], v.co.y*r[1], v.co.z*r[2])) + Vector(c)
def _add_capsule(bm, a, b, r, seg=20, sq=(1.0, 1.0)):
    a, b = Vector(a), Vector(b); d = b - a; L = d.length; z = d.normalized()
    cone = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r*.94, depth=L)
    R = z.to_track_quat('Z', 'Y').to_matrix()
    for v in cone["verts"]: v.co = R @ Vector((v.co.x*sq[0], v.co.y*sq[1], v.co.z)) + (a + b)/2
    for p, rr in ((a, r), (b, r*.94)):
        s = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=12, radius=rr)
        for v in s["verts"]: v.co = R @ Vector((v.co.x*sq[0], v.co.y*sq[1], v.co.z)) + p

GLOVE_EASE = 1.03                                                   # gloves are scaled 3 % more than the hand (about 3 mm of room on every side)
def _hscale(z):
    """Local scale factor of the hand map (HAND_S about the wrist, blended in between z = -2 cm and +7 cm along the hand axis)."""
    u = np.clip((np.asarray(z, float) + .02)/.09, 0, 1); return 1 + (HAND_S*GLOVE_EASE - 1)*u*u*(3 - 2*u)
def KS(kind):
    """KINDS[kind] with the hand scale (and the catcher's extra growth) applied to the hand-local lengths: pocket, pad, finger length (what the keys / laces / checks use)."""
    K = dict(KINDS[kind]); g = K.get("grow", 1.0); px, py, pz = K["pocket"]; sc = float(_hscale(np.array([pz]))[0]); py, pz = py*sc, pz*sc
    if g != 1.0: py *= g; pz = .06 + (pz - .06)*g
    K["pocket"] = (px*sc, py, pz); L = K["fingers"][0]; K["fingers"] = (L*float(_hscale(np.array([L]))[0])*g,) + tuple(K["fingers"][1:]); K["pad"] = K["pad"]*sc; return K
def _frame(side):
    sx = 1 if side == "Left" else -1
    wr = JOINTS[side+"Hand"][1]; dvec = (JOINTS[side+"Hand"][2] - wr).normalized()
    zdir = dvec; xdir = Vector((-sx, 0, 0)); ydir = zdir.cross(xdir).normalized(); xdir = ydir.cross(zdir).normalized()
    return wr, xdir, ydir, zdir
def local_to_world(side):
    wr, xd, yd, zd = _frame(side); M = Matrix(((xd.x, yd.x, zd.x, wr.x), (xd.y, yd.y, zd.y, wr.y), (xd.z, yd.z, zd.z, wr.z), (0, 0, 0, 1))); return M

def build_glove(kind, side="Left"):
    """Returns (glove object, pocket centre in model space). Union of primitives -> voxel remesh -> pocket carved with a sphere -> smoothed and decimated."""
    K = KINDS[kind]; bm = bmesh.new(); hw = K["half_w"] + .003; z0, z1 = K["heel_z"]; back, pad = K["back"], K["pad"]; L, spread, ft, fr = K["fingers"]; ft += .004; fr += (.004 if fr else 0.0)      # (+3-4 mm: the MPFB hand is a little broader than the old capsule hand)
    xm = (back + pad)/2; xr_ = (pad - back)/2
    _add_ellipsoid(bm, (xm, 0, (z0 + z1)/2 + .02), (xr_, hw, (z1 - z0)/2 + .045))                                     # heel / palm block
    if kind == "catcher":                                                                                          # round mitt: one big disc-like lobe with a thumb lobe
        _add_ellipsoid(bm, (xm, .0, .125), (xr_*1.02, hw, .105), 32, 22)
        _add_ellipsoid(bm, (xm*.9, -.055, .10), (xr_*.75, .050, .085))
        _add_capsule(bm, (xm*.5 + .006, -.078, .03), (xm*.5 + .006, -.098, .125), .033, sq=(1.25, 1.0))                              # thumb
    elif kind == "firstbase":                                                                                       # long scoop: elongated body, fingers together, thumb apart
        _add_ellipsoid(bm, (xm*.95, .0, .152), (xr_*.95, hw*.86, .115), 30, 22)
        _add_capsule(bm, (xm*.5 + .006, -.052, .03), (xm*.5 + .006, -.078, .19), .031, sq=(1.2, 1.0))
        _add_ellipsoid(bm, (xm*.85, .006, .198), (xr_*.85, hw*.76, .050))
    else:
        for i, t in enumerate((-1.5, -.5, .5, 1.5)):                                                               # four finger sleeves (index at -y, pinky at +y)
            y = t*spread; ln = L*(0.96 if abs(t) > 1 else 1.0)*(1.03 if i in (1, 2) else 1.0)
            _add_capsule(bm, (xm*.45, y, .07), (xm*.45, y*1.05, ln - fr), fr, sq=(ft/fr*1.0, 1.0))
        _add_capsule(bm, (xm*.5 + .006, -.05, .03), (xm*.5 + .006, K["thumb"][0], K["thumb"][1] - .022), .0275, sq=(1.35, 1.0))       # thumb sleeve
        _add_ellipsoid(bm, (xm*.95, -.048, .125), (xr_*.7, .042, .050))                                              # web between thumb and index
    # cuff: opening that clears the forearm (wrist radius ~ .04) and extends a few cm up the forearm
    ring = bmesh.ops.create_cone(bm, cap_ends=False, segments=32, radius1=.066, radius2=.066, depth=.05)
    R = Matrix.Rotation(0, 3, 'X')
    for v in ring["verts"]: v.co = Vector((v.co.x*1.02, v.co.y*.98, v.co.z)) + Vector((xm*.35, 0, -.005))
    mesh = bpy.data.meshes.new("glove_union"); bm.to_mesh(mesh); bm.free(); o = bpy.data.objects.new("glove_tmp", mesh); bpy.context.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    md = o.modifiers.new("R", 'REMESH'); md.mode = 'VOXEL'; md.voxel_size = .0032; md.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier="R")
    # wrist bore: the forearm slides in here (circle r .046 about the wrist axis); the walls that remain are >= 1 cm thick
    cy = bmesh.new(); bmesh.ops.create_cone(cy, cap_ends=True, segments=40, radius1=.059, radius2=.052, depth=.09)
    for v in cy.verts: v.co = Vector((v.co.x + .004, v.co.y, v.co.z - .025))
    cm = bpy.data.meshes.new("bore_tmp"); cy.to_mesh(cm); cy.free(); co = bpy.data.objects.new("bore_tmp", cm); bpy.context.collection.objects.link(co)
    bb = o.modifiers.new("Bore", 'BOOLEAN'); bb.operation = 'DIFFERENCE'; bb.object = co; bb.solver = 'EXACT'
    bpy.ops.object.modifier_apply(modifier="Bore"); bpy.data.objects.remove(co, do_unlink=True)
    # scale with the hand (same map as the MPFB hand, see hand_scale_map) so the hand stays inside with the same margins; the catcher's mitt grows further (real mitts are 33-36 cm)
    grow = K.get("grow", 1.0); Pw = np.array([v.co[:] for v in o.data.vertices]); ss = _hscale(Pw[:, 2]); Pw = Pw*ss[:, None]
    if grow != 1.0: Pw[:, 1] *= grow; Pw[:, 2] = .06 + (Pw[:, 2] - .06)*grow
    o.data.vertices.foreach_set("co", Pw.astype(np.float32).ravel()); o.data.update()
    pc0 = Vector(K["pocket"]); pc0 = pc0*float(_hscale(np.array([pc0.z]))[0])
    if grow != 1.0: pc0.y *= grow; pc0.z = .06 + (pc0.z - .06)*grow
    # pocket
    pc = pc0; sph = bmesh.new(); bmesh.ops.create_uvsphere(sph, u_segments=32, v_segments=20, radius=K["pr"])
    for v in sph.verts: v.co = v.co*Vector((1.0, 1.0, 1.0)) + pc
    if kind == "firstbase":
        for v in sph.verts: v.co.z = pc.z + (v.co.z - pc.z)*1.55
    if kind == "catcher":
        for v in sph.verts: v.co.y = pc.y + (v.co.y - pc.y)*1.25; v.co.z = pc.z + (v.co.z - pc.z)*1.15
    sm = bpy.data.meshes.new("pocket_tmp"); sph.to_mesh(sm); sph.free(); so = bpy.data.objects.new("pocket_tmp", sm); bpy.context.collection.objects.link(so)
    bo = o.modifiers.new("B", 'BOOLEAN'); bo.operation = 'DIFFERENCE'; bo.object = so; bo.solver = 'EXACT'
    bpy.ops.object.modifier_apply(modifier="B"); bpy.data.objects.remove(so, do_unlink=True)
    sm2 = o.modifiers.new("S", 'CORRECTIVE_SMOOTH'); sm2.iterations = 6; sm2.factor = .6; sm2.rest_source = 'BIND'
    try: bpy.ops.object.modifier_apply(modifier="S")
    except Exception: o.modifiers.remove(sm2)
    dc = o.modifiers.new("D", 'DECIMATE'); dc.ratio = .34 if kind in ("infield", "outfield") else .30; bpy.ops.object.modifier_apply(modifier="D")
    for p in o.data.polygons: p.use_smooth = True
    # local -> model space
    M = local_to_world(side); o.data.transform(M); o.name = K["node"]; o.data.name = K["node"]
    return o, M @ pc

# ---------------------------------------------------------------- shape keys glove_open / glove_closed
ZOFF = .042; RAMP = .06                                                                       # the fingers fold over the TOP of the ball (beyond pocket z + 4.2 cm), never through it
def add_glove_keys(o, kind, side="Left", close_deg=38.0, open_deg=-16.0):
    """Basis = neutral catching state. glove_closed: fingers (and thumb) fold over the pocket; glove_open: fingers spread back / thumb out."""
    M = local_to_world(side); Mi = M.inverted(); K = KS(kind)
    me = o.data; P = np.array([(Mi @ v.co)[:] for v in me.vertices])
    if me.shape_keys is None: o.shape_key_add(name="Basis", from_mix=False)
    def rot_fingers(P, deg):
        out = P.copy(); z0 = K["pocket"][2] + ZOFF; w = np.clip((P[:, 2] - z0)/RAMP, 0, 1); w = w*w*(3 - 2*w)
        if kind in ("catcher",): w = w*.55
        ang = np.radians(deg)*w; px, pz = K["pocket"][0] - .012, z0
        dx, dz = P[:, 0] - px, P[:, 2] - pz
        out[:, 0] = px + dx*np.cos(ang) + dz*np.sin(ang); out[:, 2] = pz - dx*np.sin(ang) + dz*np.cos(ang)
        return out
    def rot_thumb(P, deg):
        out = P.copy(); tw = np.clip((-P[:, 1] - .052)/.03, 0, 1)*np.clip((P[:, 2] - .03)/.05, 0, 1); ang = np.radians(deg)*tw
        py, pz = -.05, .04; dy, dz = P[:, 1] - py, P[:, 2] - pz
        out[:, 1] = py + dy*np.cos(ang) - dz*np.sin(ang)*.55; out[:, 2] = pz + dz*np.cos(ang) + dy*np.sin(ang)*.55
        out[:, 0] += tw*np.radians(deg)*.03
        return out
    for nm, deg in (("glove_open", open_deg), ("glove_closed", close_deg)):
        Q = rot_thumb(rot_fingers(P, deg), -deg*.9)
        sk = o.shape_key_add(name=nm, from_mix=False); sk.slider_min = 0.0; sk.slider_max = 1.0; sk.value = 0.0
        sk.data.foreach_set("co", np.array([(M @ Vector(q))[:] for q in Q], np.float32).ravel())

# ---------------------------------------------------------------- weights: rigid on the hand, the cuff blends into the forearm
def weight_glove(o, side="Left"):
    Mi = local_to_world(side).inverted()
    for v in o.data.vertices:
        z = (Mi @ v.co).z; w = max(0.0, min(1.0, (z + .058)/.09)); w = w*w*(3 - 2*w)
        for nm, ww in ((side+"Hand", w), (side+"ForeArm", 1 - w)):
            if ww > 1e-4: vg = o.vertex_groups.get(PFX+nm) or o.vertex_groups.new(name=PFX+nm); vg.add([v.index], ww, 'REPLACE')

# ---------------------------------------------------------------- laces and wrist strap
def glove_laces(glove, kind, side="Left"):
    """Tan lace lines on the palm face between the fingers and around the web; strap around the wrist with a velcro tab. Returns a mesh object."""
    M = local_to_world(side); K = KS(kind); bm = bmesh.new(); gb = bmesh.new(); gb.from_mesh(glove.data); bvh = BVHTree.FromBMesh(gb); gb.free()
    ring = bmesh.ops.create_cone(bm, cap_ends=False, segments=32, radius1=.0715, radius2=.0715, depth=.026)          # wrist strap
    for v in ring["verts"]: v.co = M @ (Vector((v.co.x*1.03, v.co.y*.99, v.co.z)) + Vector((K["pad"]*.05, 0, .003)))
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=.004)
    def on_surface(lp, dirloc):
        p = M @ Vector(lp); d = (M.to_3x3() @ Vector(dirloc)).normalized(); l, n, i, dist = bvh.ray_cast(p - d*.15, d); return (l, n) if l is not None else (None, None)
    lines = []
    L = K["fingers"][0]
    if kind in ("infield", "outfield"):
        for y in (-.036, 0.0, .036): lines.append([(x_, y, z_) for x_, z_ in ((.03, .12), (.03, .15), (.03, L - .045))])
    elif kind == "firstbase": lines.append([(.03, y_, z_) for y_, z_ in ((.0, .10), (.0, .16), (.0, L - .05))])
    for path in lines:
        pts = []
        for lp in np.linspace(path[0], path[-1], 12):
            l, n = on_surface((lp[0] + .08, lp[1], lp[2]), (-1, 0, 0))
            if l is not None: pts.append(l + n*.0016)
        for a, b in zip(pts, pts[1:]): capsule(bm, a, b, .0021, 6)
    # lace loops around the pocket rim
    pc = Vector(K["pocket"]); ring_pts = []
    for k in range(20):
        ph = 2*math.pi*k/20; lp = (pc.x + .06, pc.y + math.cos(ph)*(K["pr"]*1.08), pc.z + math.sin(ph)*(K["pr"]*1.08 if kind != "firstbase" else K["pr"]*1.6))
        l, n = on_surface(lp, (-1, 0, 0))
        if l is not None: ring_pts.append(l + n*.0016)
    for a, b in zip(ring_pts, ring_pts[1:] + ring_pts[:1]): capsule(bm, a, b, .0024, 6)
    me = bpy.data.meshes.new(K["node"] + "_laces"); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    o = bpy.data.objects.new(K["node"] + "_Laces", me); bpy.context.collection.objects.link(o); return o

# ---------------------------------------------------------------- numeric checks
def glove_report(glove, hand, side="Left"):
    """Hand vertices inside the glove (parity ray test), smallest hand-to-glove-surface distance (clearance), glove vertices inside the forearm tube."""
    gb = bmesh.new(); gb.from_mesh(glove.data); bvh = BVHTree.FromBMesh(gb); gb.free(); inside = 0; mind = 9.0; n = 0; Mi = local_to_world(side).inverted()
    for v in hand.data.vertices:
        if (Mi @ v.co).z < .022: continue                                   # the wrist stump lies in the cuff bore (covered by the cuff walls)
        p = v.co; hits = 0; d = Vector((0.0, 0.31, 0.95)).normalized(); o = p.copy()
        for _ in range(12):
            l, nn, i, dist = bvh.ray_cast(o, d)
            if l is None: break
            hits += 1; o = l + d*1e-4
        if hits % 2 == 1: inside += 1
        _, _, _, dd = bvh.find_nearest(p); mind = min(mind, dd); n += 1
    # forearm tube: from the elbow joint to the wrist joint, radius 0.043 (+ undershirt sleeve) -> glove vertices must stay outside it
    el = JOINTS[side+"ForeArm"][1]; wr = JOINTS[side+"Hand"][1]; ax = (wr - el); L2 = ax.length; axn = ax/L2; bad = 0; worst = 9.0
    for v in glove.data.vertices:
        q = v.co - el; t = q.dot(axn)
        if 0.0 <= t <= L2:
            r = (q - axn*t).length; worst = min(worst, r - .043)
            if r < .043: bad += 1
    return dict(hand_inside=f"{inside}/{n}", min_clearance_mm=round(mind*1000, 1), glove_verts_in_forearm=bad, worst_forearm_margin_mm=round(worst*1000, 1) if worst < 9 else None, tris=len(glove.data.polygons))

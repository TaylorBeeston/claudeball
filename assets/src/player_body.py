# Athletic body via Skin modifier + hand-modelled head/hands. Requires common.py + player_rig.py exec'd.
import bpy, bmesh, math, numpy as np
from mathutils import Vector, Matrix
D_ARM = ARM_D.copy()

def body_skin(level=2, SC=1.12):
    verts, radii, edges = [], [], []
    def add(p, r, link=None):
        verts.append(Vector(p)); radii.append((r[0]*SC, r[1]*SC)); i = len(verts)-1
        if link is not None: edges.append((link, i))
        return i
    pel = add((0, .005, .985), (.190, .130))
    wai = add((0, 0, 1.13), (.160, .112), pel)
    ch1 = add((0, -.005, 1.27), (.190, .135), wai)
    ch2 = add((0, -.005, 1.39), (.212, .135), ch1)
    nb = add((0, .0, 1.495), (.138, .100), ch2)                # trapezius base
    nk = add((0, -.018, 1.640), (.060, .066), nb)              # neck (ends inside the head)
    for sx in (1, -1):
        m = lambda v: Vector((v[0]*sx, v[1], v[2]))
        trap = add(m((.112, .0, 1.515)), (.066, .056), nb)         # upper trapezius slope
        sh = Vector((.21, 0, 1.50))
        dl = add(m(sh), (.078, .080), trap)                    # deltoid
        b1 = add(m(sh + D_ARM*.11), (.060, .064), dl)          # biceps/triceps
        el = add(m(sh + D_ARM*.31), (.048, .050), b1)
        fa = add(m(sh + D_ARM*.31 + D_ARM*.09), (.050, .052), el)   # forearm belly
        wr = add(m(sh + D_ARM*.58), (.031, .026), fa)
        hp = add(m((.095, .012, .90)), (.118, .128), pel)      # glute/hip
        th = add(m((.094, -.002, .72)), (.102, .108), hp)      # thigh
        kn = add(m((.090, -.010, .52)), (.068, .070), th)
        ca = add(m((.090, .026, .38)), (.072, .086), kn)       # calf
        an = add(m((.090, .000, .11)), (.044, .046), ca)
        ba = add(m((.090, -.120, .048)), (.050, .040), an)     # foot ball
        to = add(m((.090, -.225, .032)), (.042, .030), ba)
    me = bpy.data.meshes.new("Body"); me.from_pydata([tuple(v) for v in verts], edges, [])
    o = bpy.data.objects.new("Body", me); bpy.context.collection.objects.link(o); bpy.context.view_layer.objects.active = o
    sk = o.modifiers.new("Skin", 'SKIN'); sk.branch_smoothing = 0.55; sk.use_smooth_shade = True
    o.modifiers.new("Sub", 'SUBSURF').levels = level
    me.skin_vertices[0].data[pel].use_root = True
    for i, r in enumerate(radii): me.skin_vertices[0].data[i].radius = r
    ev = o.evaluated_get(bpy.context.evaluated_depsgraph_get()); nm = bpy.data.meshes.new_from_object(ev)
    o.modifiers.clear(); o.data = nm
    for p in nm.polygons: p.use_smooth = True
    return o

def sstep(a, b, x): t = np.clip((x-a)/(b-a), 0, 1); return t*t*(3-2*t)
def g2(x, w, cx, cw, sx, sw): return np.exp(-(((x-cx)/sx)**2 + ((w-cw)/sw)**2))
HC = Vector((0, -.004, 1.725)); HR = (.079, .100, .118)

def head_uv_dir(x, y, z):
    """unit-sphere coords -> (u, v); front (-Y) at u = .5"""
    F = -y; u = np.arctan2(x, F)/(2*np.pi) + .5; v = (z+1)/2; return u, v

def build_head(seg=72, rings=52):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    vs = list(bm.verts); N = np.array([[v.co.x, v.co.y, v.co.z] for v in vs])
    x, y, z = N[:, 0], N[:, 1], N[:, 2]; F = -y; ff = sstep(-.05, .55, F)
    a = np.array(HR)
    # base shape: jaw taper + chin, wider cranium
    lowk = np.clip(-z, 0, 1); ax = HR[0]*(1 - .23*lowk**1.8 + .05*np.clip(z, 0, 1)); ay = HR[1]*(1 + .02*np.clip(z, 0, 1))
    # round cranium instead of a tall egg: the upper hemisphere is a superellipsoid (exponent 2 -> 2.5, fuller shoulders of the dome, no pointed crown), crown 11.8 cm above the head centre,
    # chin 13 cm below it (head height 24.8 cm = 1/7.5 of the body); the back of the skull (occiput) bulges and the forehead is a little flatter
    ne = 2.0 + .5*sstep(0.0, .35, z); rr = (np.abs(x)**ne + np.abs(y)**ne + np.abs(z)**ne)**(-1.0/ne); sx_, sy_, sz_ = x*rr, y*rr, z*rr
    az = np.where(z > 0, HR[2], .130)
    occ = .011*sstep(.0, .75, y)*np.exp(-((z - .18)/.42)**2)
    P = np.stack([sx_*ax, sy_*ay + occ, sz_*az], 1)
    disp = np.zeros(len(vs))
    def add(cx, cw, sx, sw, amp, mirror=True):
        nonlocal disp
        disp += amp*(g2(x, z, cx, cw, sx, sw) + (.94*g2(x, z, -cx, cw, sx, sw) if mirror and cx != 0 else 0))*ff      # right side 6 % weaker: subtle asymmetry
    add(0, -.18, .16, .11, .019); add(0, .06, .07, .24, .009); add(.20, -.24, .10, .07, .009)       # nose tip/bridge/wings
    add(0, .21, .55, .075, .008)                                                                       # brow ridge
    add(.42, .09, .17, .10, -.008)                                                                     # eye sockets
    add(.55, -.10, .22, .15, .006)                                                                     # cheekbones
    add(0, -.43, .27, .05, .007); add(0, -.53, .25, .055, .008); add(0, -.478, .29, .014, -.007)    # lips + mouth line
    add(0, -.78, .26, .13, .012)                                                                       # chin
    add(.42, .21, .20, .035, -.0045); add(.40, -.02, .20, .05, -.003)                                  # upper-lid crease, lower orbital bag
    add(0, -.36, .05, .06, -.0025); add(.10, -.285, .045, .03, -.006)                                  # philtrum groove, nostrils
    add(0, -.46, .14, .016, .0035)                                                                     # cupid bow / upper-lip edge
    add(.80, -.45, .12, .22, .006); add(.55, -.92, .30, .06, -.004)                                    # jaw angle, under-chin crease
    add(.32, -.55, .35, .22, -.004)                                                                    # nasolabial/cheek hollow
    Nn = np.stack([x*ax/HR[0], y*ay/HR[1], z*az/HR[2]], 1); Nn /= np.linalg.norm(Nn, axis=1, keepdims=True)
    P = P + Nn*disp[:, None]
    for v, p in zip(vs, P): v.co = Vector(p) + HC
    uvl = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        us = []
        for l in f.loops:
            c = l.vert.co - HC; nx, ny, nz = c.x/HR[0], c.y/HR[1], c.z/HR[2]; n = max(1e-6, math.sqrt(nx*nx+ny*ny+nz*nz))
            u, v = head_uv_dir(np.array(nx/n), np.array(ny/n), np.array(nz/n)); us.append([float(u), float(v)])
        if max(u for u, _ in us) - min(u for u, _ in us) > .5:
            for uv in us:
                if uv[0] < .5: uv[0] += 1.0
        for l, uv in zip(f.loops, us): l[uvl].uv = uv
    me = bpy.data.meshes.new("HeadSkin"); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    h = bpy.data.objects.new("HeadSkin", me); bpy.context.collection.objects.link(h); return h

def face_texture(n=1024, seed=3):
    """Neutral (near white) painted face detail in the cylindrical head UV space; multiplied by the `face` material skin tone."""
    uu, vv = np.meshgrid((np.arange(n)+.5)/n, (np.arange(n)+.5)/n); w = vv*2-1; r = np.sqrt(np.clip(1-w*w, 0, 1)); th = (uu-.5)*2*np.pi
    x = r*np.sin(th); Fm = r*np.cos(th); front = Fm > -.05
    img = np.ones((n, n, 3), np.float32)*.96
    nz = noise_tex(n, [16, 64, 256, 512], seed); img *= (0.93 + .12*nz)[..., None]
    def paint(cx, cw, sx, sw, col, amp, mirror=True):
        m = g2(x, w, cx, cw, sx, sw) + (g2(x, w, -cx, cw, sx, sw) if mirror and cx != 0 else 0); m = np.clip(m*amp, 0, 1)*front
        for c in range(3): img[..., c] = img[..., c]*(1-m) + col[c]*m
    paint(0, -.44, .26, .05, (1.0, .60, .60), .9); paint(0, -.53, .24, .05, (1.0, .55, .58), .9)     # lips
    paint(0, -.478, .28, .012, (.35, .15, .15), .9)                                                   # mouth line
    paint(.36, .225, .25, .045, (.20, .14, .11), 1.0); paint(.36, .232, .19, .030, (.14, .10, .08), .9); paint(.19, .215, .07, .04, (.20, .14, .11), .8)   # eyebrows (thick, tapering)
    paint(.41, .118, .16, .013, (.08, .06, .05), .95); paint(.41, .088, .13, .010, (.55, .38, .34), .5)   # upper lash line, lower lid line
    paint(.55, -.20, .30, .22, (.95, .62, .58), .18)                                                       # cheek blush
    paint(.42, .10, .13, .075, (.78, .62, .58), .55)                                                   # eyelid shadow
    paint(0, -.60, .55, .38, (.86, .80, .78), .35)                                                     # stubble/jaw tone
    paint(.14, -.28, .05, .04, (.55, .38, .36), .8)                                                    # nostrils
    return np.clip(img, 0, 1)

def face_height(n=1024, seed=3):
    """Height field for the face normal map: pores + wrinkles (forehead lines, crow's feet, nasolabial folds, lip lines) in the head UV space."""
    uu, vv = np.meshgrid((np.arange(n)+.5)/n, (np.arange(n)+.5)/n); w = vv*2-1; r = np.sqrt(np.clip(1-w*w, 0, 1)); th = (uu-.5)*2*np.pi
    x = r*np.sin(th); front = (r*np.cos(th)) > -.05
    h = noise_tex(n, [128, 256, 512], seed)*.6 + noise_tex(n, [16, 32], seed+1)*.15
    def line(cx, cw, sx, sw, amp): return amp*(g2(x, w, cx, cw, sx, sw) + (g2(x, w, -cx, cw, sx, sw) if cx else 0))*front
    h = h + line(0, .43, .32, .012, -.35) + line(0, .50, .30, .010, -.28) + line(0, .37, .26, .010, -.22)      # forehead lines
    h = h + line(.66, .12, .07, .05, -.25) + line(.70, .06, .06, .04, -.2)                                           # crow's feet
    h = h + line(.26, -.30, .035, .16, -.45) + line(.34, -.34, .03, .12, -.3)                                       # nasolabial folds
    h = h + line(0, -.45, .22, .008, -.4) + line(0, -.60, .20, .012, -.2) + line(0, .13, .22, .05, .2)             # lip line, chin crease, brow bridge
    return h

def eyes_meshes():
    out = []
    for sx in (1, -1):
        bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=16, radius=.0125)
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi/2, 3, 'X'))     # north pole -> -Y (front)
        bmesh.ops.translate(bm, vec=(sx*.033, -.074, 1.738), verts=bm.verts)
        me = bpy.data.meshes.new("Eye"); bm.to_mesh(me); bm.free()
        # uv: v measured from the pole facing forward
        uvl = me.uv_layers.new(name="UVMap")
        for lp in me.loops:
            c = me.vertices[lp.vertex_index].co - Vector((sx*.033, -.074, 1.738)); c = c.normalized()
            uvl.data[lp.index].uv = (math.atan2(c.x, c.z)/(2*math.pi)+.5, .5 - .5*c.y)   # v -> 1 at the front pole (-Y => c.y=-1), 0 at the back
        for p in me.polygons: p.use_smooth = True
        o = bpy.data.objects.new("Eye", me); bpy.context.collection.objects.link(o); out.append(o)
    return out

def eye_texture(n=512):
    """Sclera / iris / pupil painted around the front pole (v -> 1). Iris radius ~29 deg, pupil ~10 deg (real eye: iris 11.7 mm across a 24 mm globe)."""
    v = (np.arange(n)+.5)/n; u = (np.arange(n)+.5)/n; vv = np.tile(v[:, None], (1, n)); uu = np.tile(u[None, :], (n, 1))
    theta = np.degrees(np.arccos(np.clip(2*vv-1, -1, 1)))              # angle from the front pole
    img = np.ones((n, n, 3), np.float32)*np.array([.93, .92, .90])
    veins = (np.sin(uu*2*np.pi*23 + theta*.4)*.5+.5)*np.clip((theta-32)/30, 0, 1)*.05; img[..., 1:] -= veins[..., None]*np.array([1, 1])
    fib = .5 + .5*np.sin(uu*2*np.pi*40); ring = np.clip((theta-23)/6, 0, 1)
    iris = theta < 29; col = np.array([.30, .42, .24])*(0.75 + .35*fib[..., None]) * (1 - .4*ring[..., None]) + np.array([.07, .05, .02])*(theta[..., None]/29)*.4
    img = np.where(iris[..., None], col, img)
    img = np.where(((theta >= 27) & (theta < 31))[..., None], img*.35, img)          # limbal ring
    img = np.where((theta < 10.5)[..., None], np.array([.01, .01, .012]), img)       # pupil
    return np.clip(img, 0, 1)

def ears():
    out = []
    for sx in (1, -1):
        bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0)
        for v in bm.verts: v.co = Vector((v.co.x*.010, v.co.y*.022, v.co.z*.032))
        bmesh.ops.translate(bm, vec=(sx*.081, .006, 1.722), verts=bm.verts)
        me = bpy.data.meshes.new("Ear"); bm.to_mesh(me); bm.free()
        uvl = me.uv_layers.new(name="UVMap")
        for lp in me.loops: uvl.data[lp.index].uv = (0.05 if sx > 0 else .95, .5)
        for p in me.polygons: p.use_smooth = True
        o = bpy.data.objects.new("Ear", me); bpy.context.collection.objects.link(o); out.append(o)
    return out

def capsule(bm, a, b, r, seg=8):
    a, b = Vector(a), Vector(b); d = b-a; L = d.length; z = d.normalized()
    ret = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r*.92, depth=L)
    R = z.to_track_quat('Z', 'Y').to_matrix(); vs = ret["verts"]
    for v in vs: v.co = R @ v.co + (a+b)/2
    for p in (a, b):
        s = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(5, seg//2+1), radius=r*.96)
        for v in s["verts"]: v.co += p

def hand_mesh(side, curl=1.0, spread=0.0, thumb=(1.0, 0.0), name=None, seg=10, curls=None, thumb_out=0.0, thumb_tip=None):
    """Rigid hand (palm + 4 fingers + thumb), wrist at the ForeArm tail; fingertips along the Hand bone. Defaults = the firm grip used for bats (fist-like).
    curl scales the finger flexion (0 = straight), curls = optional per-finger scale, spread fans the fingers apart (degrees), thumb_out abducts the thumb."""
    sx = 1 if side == "Left" else -1
    wr = JOINTS[side+"Hand"][1]; dvec = JOINTS[side+"Hand"][2]-wr; dvec.normalize()
    bm = bmesh.new()
    # local frame: Z along hand, X = palm normal (toward the body), Y = forward (thumb side)
    zdir = dvec; xdir = Vector((-sx, 0, 0)); ydir = zdir.cross(xdir).normalized(); xdir = ydir.cross(zdir).normalized()
    def W(lx, ly, lz): return wr + xdir*lx + ydir*ly + zdir*lz
    capsule(bm, W(0, 0, .012), W(0, 0, .085), .030, seg+2)                            # palm
    for i, (ly, ln) in enumerate(((-.020, 1.0), (-.007, 1.1), (.007, 1.05), (.020, .9))):
        p0 = W(0, ly, .090); ang = 0.0; pos = p0; seglen = (.030*ln, .022*ln, .018*ln); cs = curl*(curls[i] if curls else 1.0)
        fan = math.radians(spread)*(i-1.5)/1.5
        for k, sl in enumerate(seglen):
            ang += math.radians((38, 62, 50)[k])*cs; dl = (math.sin(ang), 0, math.cos(ang))     # curls toward the palm (+X local)
            q = pos + (xdir*dl[0] + zdir*dl[2])*sl + ydir*(math.sin(fan)*sl); capsule(bm, pos, q, .0085 - .0008*k, seg); pos = q
    p0 = W(.005, -.032, .030); pos = p0                                                  # thumb
    if thumb_tip is not None:                                                            # reach a given local point (ball hold): two segments with a slight bulge
        T = W(*thumb_tip); mid = (p0+T)/2 + xdir*.006 - zdir*.004
        capsule(bm, p0, mid, .0105, seg); capsule(bm, mid, T, .0095, seg)
    for k, (sl, an) in enumerate(() if thumb_tip is not None else ((.034, (35, -40)), (.028, (20, -60)))):
        dvv = (ydir*(-math.sin(math.radians(an[1]))*.3 - .5 - thumb_out) + zdir*.85*thumb[0] + xdir*(.35*k + thumb[1])).normalized()
        q = pos + dvv*sl; capsule(bm, pos, q, .0105-.001*k, seg); pos = q
    me = bpy.data.meshes.new(name or "Hand"+side); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    o = bpy.data.objects.new(name or "Hand"+side, me); bpy.context.collection.objects.link(o); return o

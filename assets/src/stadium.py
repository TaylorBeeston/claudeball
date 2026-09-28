for f in ("common", "geom", "meshkit", "textures"): exec(open(CB_SRC + f"/{f}.py").read())
import types; geom = types.SimpleNamespace(wall_path=wall_path)
exec(open(CB_SRC + "/stadium_gen.py").read().split("if __name__")[0].replace("import numpy as np, sys, os", "import numpy as np").replace("sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\nimport geom\n", ""))
reset_scene()
G = generate(0.5); M, K = G['M'], G['K']; V = G['V']
FLAT = lambda n, c, r=0.8, m=0.0: (lambda mm: (mm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].__setattr__("default_value", c),
            mm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].__setattr__("default_value", r),
            mm.node_tree.nodes["Principled BSDF"].inputs["Metallic"].__setattr__("default_value", m), mm)[-1])(bpy.data.materials.new(n))
def mat(n, c, r=0.8, m=0.0):
    mm = bpy.data.materials.new(n); mm.use_nodes = True; b = mm.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = c; b.inputs["Roughness"].default_value = r; b.inputs["Metallic"].default_value = m; return mm
def emissive(n, c, strength):
    mm = mat(n, c, 0.4); b = mm.node_tree.nodes["Principled BSDF"]
    b.inputs["Emission Color"].default_value = c; b.inputs["Emission Strength"].default_value = strength; return mm
cd, chn = dirt_tex(seed=9, base=(0.42, 0.42, 0.41), var=0.22)
M_CONC = vc_material("concrete", make_image("concrete_albedo", cd, path=ROOT+"/tex/concrete_albedo.png"),
                     make_image("concrete_normal", height_to_normal(chn, 2.0), 'Non-Color', ROOT+"/tex/concrete_normal.png"), 0.85, 0.5)
M_FASC = mat("fascia_dark", (0.05, 0.06, 0.08, 1), 0.5, 0.2)
M_PAD = mat("wall_padding", (0.02, 0.10, 0.05, 1), 0.85); M_YEL = mat("wall_yellow_line", (0.95, 0.72, 0.03, 1), 0.5)
M_GLASS = mat("press_glass", (0.05, 0.10, 0.14, 1), 0.08, 0.6); M_STEEL = mat("steel", (0.55, 0.57, 0.6, 1), 0.45, 0.9)
M_DUGR = mat("dugout_roof", (0.15, 0.16, 0.18, 1), 0.7); M_EYE = mat("batters_eye", (0.01, 0.03, 0.02, 1), 0.95)
M_LAMP = emissive("stadium_light", (1.0, 0.97, 0.88, 1), 40.0)
SEATC = [(0.02, 0.06, 0.30, 1), (0.03, 0.10, 0.28, 1), (0.05, 0.08, 0.20, 1)]
objs = []

def B3(v): return (v[0], -v[2], v[1])
def make_mesh(name, verts, faces, mats, mat_idx=None, uv=None, cols=None, smooth=False):
    me = bpy.data.meshes.new(name); me.from_pydata([B3(v) for v in verts], [], faces); me.update()
    if uv is not None:
        u = me.uv_layers.new(name="UVMap"); li = np.empty(len(me.loops), np.int32); me.loops.foreach_get("vertex_index", li)
        u.data.foreach_set("uv", np.asarray(uv, np.float32)[li].ravel())
    if cols is not None:
        ca = me.color_attributes.new("Color", 'FLOAT_COLOR', 'POINT'); c4 = np.concatenate([cols, np.ones((len(cols), 1))], 1)
        ca.data.foreach_set("color", c4.astype(np.float32).ravel())
    for m_ in mats: me.materials.append(m_)
    if mat_idx is not None: me.polygons.foreach_set("material_index", np.asarray(mat_idx, np.int32))
    for p in me.polygons: p.use_smooth = smooth
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o); objs.append(o); return o

# ---------------- bowl loft (concrete tread/riser/back walls + dark fascia bands)
jj, kk = np.meshgrid(np.arange(M), np.arange(K-1), indexing='ij')
a = jj*K+kk; b = ((jj+1) % M)*K+kk; c = b+1; d = a+1
a, b, c, d = a.reshape(-1), b.reshape(-1), c.reshape(-1), d.reshape(-1)
Vf = V.reshape(-1, 3)
area = np.linalg.norm(np.cross(Vf[b]-Vf[a], Vf[c]-Vf[a]), axis=1) + np.linalg.norm(np.cross(Vf[c]-Vf[a], Vf[d]-Vf[a]), axis=1)
# orientation: the first tread (k=2) must face +Y
q = (a[5*(K-1)+2], b[5*(K-1)+2], c[5*(K-1)+2]); nrm = np.cross(Vf[q[1]]-Vf[q[0]], Vf[q[2]]-Vf[q[0]])
flip = nrm[1] < 0
keep = (area.reshape(-1) > 1e-5)
qa, qb, qc, qd = [x.reshape(-1)[keep] for x in (a, b, c, d)]
if flip: qb, qd = qd, qb
faces = np.stack([qa, qb, qc, qd], 1).tolist()
tagf = G['tag'].reshape(-1)[keep]
cum = np.concatenate([np.zeros((M, 1)), np.cumsum(np.linalg.norm(np.diff(G['prof'], axis=1), axis=2), axis=1)], 1)
uv = np.stack([np.repeat(G['S'][:, None], K, 1)/4.0, cum/4.0], 2).reshape(-1, 2)
cols = np.repeat(G['cols'][:, None, :], K, 1).reshape(-1, 3)
make_mesh("Bowl", Vf, faces, [M_CONC, M_FASC], tagf, uv, cols)

# ---------------- outfield wall: padded (dark green) + yellow top line, loft along path at o = 0
P, N_, hw = G['P'], G['N'], G['hw']
def ribbon(name, o, y0, y1, mat_, samples=None, cap=None):
    idx = np.arange(M) if samples is None else np.asarray(samples)
    n = len(idx); vs, fs = [], []
    for i, j in enumerate(idx):
        p = P[j]+N_[j]*(o if np.isscalar(o) else o[j]); ya = y0 if np.isscalar(y0) else y0[j]; yb = y1 if np.isscalar(y1) else y1[j]
        vs += [(p[0], ya, p[1]), (p[0], yb, p[1])]
    closed = samples is None
    for i in range(n if closed else n-1):
        i2 = (i+1) % n; fs.append((2*i, 2*i2, 2*i2+1, 2*i+1))
    return vs, fs
def add_ribbon(name, o, y0, y1, mat_, samples=None, flip_=None):
    vs, fs = ribbon(name, o, y0, y1, mat_, samples)
    # face toward the field (-N): test first quad
    v0, v1, v2 = [np.array(vs[i]) for i in fs[0][:3]]; nn = np.cross(v1-v0, v2-v0)
    ref = -np.array([N_[0 if samples is None else samples[0]][0], 0, N_[0 if samples is None else samples[0]][1]])
    if nn.dot(ref) < 0: fs = [f[::-1] for f in fs]
    return make_mesh(name, vs, fs, [mat_])
add_ribbon("Wall_Padding", 0.0, 0.0, hw-0.15, M_PAD)
add_ribbon("Wall_YellowLine", 0.0, hw-0.15, hw, M_YEL)
# batter's eye: dark wall 12 m high behind center field
eye = np.where(G['eye'])[0]
add_ribbon("BattersEye", 0.4, 0.0, 12.0, M_EYE, samples=eye)
# backstop netting: alpha net texture on a ribbon behind home
net = np.zeros((256, 256, 4), np.float32)
for i in range(0, 256, 16): net[i:i+2, :, :] = (0.7, 0.7, 0.7, 1); net[:, i:i+2, :] = (0.7, 0.7, 0.7, 1)
ni = make_image("net", net[..., :3], path=ROOT+"/tex/net.png")
ni.alpha_mode = 'STRAIGHT'
arr = np.zeros((256, 256, 4), np.float32); arr[..., :3] = net[..., :3]; arr[..., 3] = net[..., 3]
ni2 = bpy.data.images.new("net_rgba", 256, 256, alpha=True); ni2.pixels.foreach_set(arr.ravel()); ni2.pack()
M_NET = mat("backstop_net", (0.6, 0.6, 0.6, 1), 0.9); nt = M_NET.node_tree; t_ = nt.nodes.new("ShaderNodeTexImage"); t_.image = ni2
nt.links.new(t_.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"]); nt.links.new(t_.outputs["Alpha"], nt.nodes["Principled BSDF"].inputs["Alpha"])
M_NET.surface_render_method = 'BLENDED'
nets = np.where((np.abs(P[:, 0]) < 24) & (P[:, 1] < 6))[0]
o_ = add_ribbon("BackstopNetting", 0.5, 1.2, 9.5, M_NET, samples=nets)
me = o_.data; u = me.uv_layers.new(name="UVMap")
L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P[nets], axis=0), axis=0 if False else 1))]
vuv = []
for i in range(len(nets)): vuv += [(L[i]/2.0, 0.0), (L[i]/2.0, 4.0)]
li = np.empty(len(me.loops), np.int32); me.loops.foreach_get("vertex_index", li); u.data.foreach_set("uv", np.asarray(vuv, np.float32)[li].ravel())
mb = MB("NetPosts")
for j in nets[::12]:
    p = P[j]+N_[j]*0.5; mb.box(p[0], p[1], 0.12, 0.12, 0.0, 9.6)
objs.append(mb.build(M_STEEL))

# ---------------- press box, glass band on the first fascia behind home
mk = G['marks'][0]; sel = np.where((np.abs(P[:, 0]) < 14) & (P[:, 1] < 0))[0]
od = np.array([mk[j][0][0] for j in sel]); yd = np.array([mk[j][0][1] for j in sel])
def strip_between(name, sel, o0, o1, y0, y1, mat_):
    vs, fs = [], []
    for i, j in enumerate(sel):
        for oo, yy in ((o0[i], y0[i]), (o1[i], y0[i]), (o1[i], y1[i]), (o0[i], y1[i])):
            p = P[j]+N_[j]*oo; vs.append((p[0], yy, p[1]))
    n = len(sel)
    for i in range(n-1):
        for k in range(4):
            k2 = (k+1) % 4; fs.append((4*i+k, 4*(i+1)+k, 4*(i+1)+k2, 4*i+k2))
    fs += [(0, 1, 2, 3), (4*(n-1)+3, 4*(n-1)+2, 4*(n-1)+1, 4*(n-1))]
    # make every face point outward from the strip's centroid
    cen = np.mean(np.array(vs), axis=0); out = []
    for f in fs:
        v0, v1, v2 = [np.array(vs[i]) for i in f[:3]]; nn = np.cross(v1-v0, v2-v0); ctr = np.mean([vs[i] for i in f], axis=0)
        # approximate outward using distance from the strip's local axis is overkill: use per-quad local centre
        out.append(f)
    return vs, out
vs, fs = strip_between("PressBox", sel, od-1.6, od-0.05, yd+0.5, yd+3.6, M_GLASS)
# orient faces: ensure normals point away from the box interior (local centre = mean of the 4 verts of its ring slice)
def orient(vs, fs, ring=4):
    res = []
    for f in fs:
        i0 = f[0]//ring*ring; cen = np.mean(vs[i0:i0+ring], axis=0) if True else 0
        v0, v1, v2 = [np.array(vs[i]) for i in f[:3]]; nn = np.cross(v1-v0, v2-v0); ctr = np.mean([vs[i] for i in f], axis=0)
        res.append(f if nn.dot(ctr-cen) >= 0 else f[::-1])
    return res
make_mesh("PressBox", vs, orient(vs, fs), [M_GLASS])

# ---------------- scoreboard (left-center) with emissive screen plane
jS = int(np.argmin(np.abs(np.degrees(np.arctan2(P[:, 0], P[:, 1])) + 22) + (P[:, 1] < 90)*1000))
E1 = G['marks'][0][jS][2]; base = P[jS]+N_[jS]*(E1[0]-0.5); tang = np.array([-N_[jS][1], N_[jS][0]])
face = -N_[jS]; rot = np.arctan2(tang[1], tang[0])
mb = MB("Scoreboard")
mb.box(base[0], base[1], 30.0, 2.0, E1[1]+1.0, E1[1]+14.5, rot=rot)
for sgn in (-1, 1): mb.box(*(base+tang*sgn*11), 1.0, 1.0, 0.0, E1[1]+1.0, rot=rot)
objs.append(mb.build(M_FASC))
sb = np.zeros((384, 1024, 3), np.float32); sb[:] = (0.02, 0.03, 0.05)
sb[20:60, 20:1004] = (0.1, 0.1, 0.3); sb[80:200, 40:520] = (0.05, 0.25, 0.1); sb[80:200, 560:1000] = (0.05, 0.1, 0.25)
sb[230:340, 40:1000:] = (0.2, 0.2, 0.05)
M_SCR = bpy.data.materials.new("scoreboard_screen"); M_SCR.use_nodes = True
img = make_image("scoreboard", sb, path=ROOT+"/tex/scoreboard.png"); bp = M_SCR.node_tree.nodes["Principled BSDF"]
tn = M_SCR.node_tree.nodes.new("ShaderNodeTexImage"); tn.image = img
M_SCR.node_tree.links.new(tn.outputs["Color"], bp.inputs["Base Color"]); M_SCR.node_tree.links.new(tn.outputs["Color"], bp.inputs["Emission Color"]); bp.inputs["Emission Strength"].default_value = 2.0
sc_ = MB("Scoreboard_Screen")
cx, cz = base + face*1.05
hx, hz = tang*13.5
y0s, y1s = E1[1]+2.5, E1[1]+13.0
v = [sc_.vert(cx-hx, y0s, cz-hz, uv=(0, 0)), sc_.vert(cx+hx, y0s, cz+hz, uv=(1, 0)), sc_.vert(cx+hx, y1s, cz+hz, uv=(1, 1)), sc_.vert(cx-hx, y1s, cz-hz, uv=(0, 1))]
sc_.quad_out(*v, (base[0]-face[0]*5, y0s, base[1]-face[1]*5))
objs.append(sc_.build(M_SCR))

# ---------------- dugout roofs
for nm, side in (("DugoutRoof_1B", 1), ("DugoutRoof_3B", -1)):
    s0, s1, o0, o1 = 12.0, 30.0, 8.6, 12.8; S2 = math.sqrt(.5)
    ctr = (side*((s0+s1)/2+(o0+o1)/2)*S2, ((s0+s1)/2-(o0+o1)/2)*S2)
    mb = MB(nm); mb.box(ctr[0], ctr[1], (o1-o0), (s1-s0), 2.6, 2.85, rot=-side*math.pi/4); objs.append(mb.build(M_DUGR))

# ---------------- light towers (steel mast + emissive lamp banks)
def tower(name, px, pz, h=46.0):
    mb = MB(name); face = np.array([0.0-px, 60.0-pz]); face /= np.linalg.norm(face); rot = math.atan2(face[1], face[0]) - math.pi/2
    mb.box(px, pz, 1.4, 1.4, 0.0, h*0.55, rot=rot); mb.box(px, pz, 0.9, 0.9, h*0.55, h, rot=rot)
    lamps = MB(name+"_Lamps")
    for r_ in range(5):
        for c_ in range(9):
            lx = (c_-4)*1.0; ly = h+0.8+r_*0.9
            ox, oz = px + face[0]*0.7 + (-face[1])*lx, pz + face[1]*0.7 + face[0]*lx
            lamps.box(ox, oz, 0.7, 0.2, ly, ly+0.7, rot=rot)
    mb.box(px, pz, 10.0, 0.5, h, h+5.2, rot=rot)
    objs.append(mb.build(M_STEEL)); objs.append(lamps.build(M_LAMP))
Om = 62.0
def rim(target, extra=10.0):
    j = int(np.argmin(np.linalg.norm(P-np.array(target), axis=1))); o = float(G['prof'][j, -1, 0])+extra; return P[j]+N_[j]*o
for i, tg in enumerate(((-71, 71), (71, 71), (-58, 30), (58, 30), (-20, 118), (20, 118))):
    p = rim(tg); tower(f"LightTower_{i+1}", p[0], p[1])

# ---------------- advertising boards on the outfield wall (atlas 3x2, one 3 m panel per cell, cycling)
adimg = bpy.data.images.load(ROOT+"/ads/ad_atlas.png"); adimg.pack()
M_AD = mat("ad_boards", (1, 1, 1, 1), 0.5); _t = M_AD.node_tree.nodes.new("ShaderNodeTexImage"); _t.image = adimg
M_AD.node_tree.links.new(_t.outputs["Color"], M_AD.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
sel_ = np.where((P[:, 1] > 76) & (~G['eye']))[0]
avs, afs, auv = [], [], []
seg = None; acc = 0.0; k = 0
for i, j in enumerate(sel_):
    if i > 0:
        acc += np.linalg.norm(P[j]-P[sel_[i-1]])
        if acc >= 3.0 or (j - sel_[i-1]) != 1: seg = None; acc = 0.0; k += 1
    if seg is None:
        seg = len(avs); cell = k % 6; cx, cy = (cell % 3)/3.0, 0.5 - (cell//3)*0.5
    p = P[j]+N_[j]*(-0.03)
    avs += [(p[0], 0.35, p[1]), (p[0], 1.25, p[1])]; u = cx + (acc/3.0)/3.0
    auv += [(u, cy), (u, cy+0.5)]
    if len(avs) >= 4 and seg is not None and len(avs)-2 >= seg+2: afs.append((len(avs)-4, len(avs)-2, len(avs)-1, len(avs)-3))
fs_ = []
for f in afs:
    v0, v1, v2 = [np.array(avs[i]) for i in f[:3]]; nn = np.cross(v1-v0, v2-v0); ref = -np.array([N_[0][0], 0, N_[0][1]])
    ctr = np.mean([avs[i] for i in f], axis=0); jj_ = sel_[np.argmin(np.linalg.norm(P[sel_]-np.array([ctr[0], ctr[2]]), axis=1))]
    fs_.append(f if nn.dot(-np.array([N_[jj_][0], 0, N_[jj_][1]])) >= 0 else f[::-1])
make_mesh("AdBoards", avs, fs_, [M_AD], uv=auv)

# ---------------- seat templates (instanced in post-processing): 10 tris, facing +Z (center field)
def seat_template(name, col):
    mb = MB(name); w = 0.46
    def Q(pts, ref):
        v = [mb.vert(*p) for p in pts]; mb.quad_out(*v, ref)
    Q([(-w/2, 0.42, -0.25), (w/2, 0.42, -0.25), (w/2, 0.42, 0.22), (-w/2, 0.42, 0.22)], (0, 0.2, 0))        # cushion top
    Q([(-w/2, 0.42, 0.22), (w/2, 0.42, 0.22), (w/2, 0.30, 0.22), (-w/2, 0.30, 0.22)], (0, 0.3, 0))          # cushion front
    Q([(-w/2, 0.42, -0.25), (w/2, 0.42, -0.25), (w/2, 0.95, -0.30), (-w/2, 0.95, -0.30)], (0, 0.6, -1.0))   # backrest front
    Q([(-w/2, 0.95, -0.30), (w/2, 0.95, -0.30), (w/2, 0.95, -0.36), (-w/2, 0.95, -0.36)], (0, 0.5, -0.3))   # backrest top
    Q([(-w/2, 0.42, -0.30), (w/2, 0.42, -0.30), (w/2, 0.95, -0.36), (-w/2, 0.95, -0.36)], (0, 0.6, 0.5))    # backrest back
    return mb.build(mat(name+"_mat", col, 0.6))
for t in range(3):
    o = seat_template(f"Seats_T{t+1}", SEATC[t]); objs.append(o)
np.savez_compressed(ROOT+"/src/seats.npz", **{f"pos{t}": G['seats'][t][0] for t in range(3)}, **{f"yaw{t}": G['seats'][t][1] for t in range(3)})
result = {"objs": len(objs), "seats": [len(G['seats'][t][0]) for t in range(3)], "tris": sum(len(o.data.polygons) for o in objs)}
export(objs, ROOT+"/stadium.glb", mirror=True, jpg=True, export_vertex_color='ACTIVE', export_active_vertex_color_when_no_material=True)
exec(open(CB_SRC + "/inject_instances.py").read())
_d = np.load(ROOT+"/src/seats.npz")
inject(ROOT+"/stadium.glb", {f"Seats_T{t+1}": (_d[f"pos{t}"]*np.array([-1, 1, 1], np.float32), -_d[f"yaw{t}"]) for t in range(3)})

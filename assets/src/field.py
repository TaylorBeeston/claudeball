for f in ("common", "geom", "meshkit", "textures"): exec(open(CB_SRC + f"/{f}.py").read())
import json
reset_scene()
S2 = math.sqrt(.5)
# ---------------- materials
import os
M_GRASS = acg_material("grass", acg("Grass005", tint=(.80, .92, .70), gain=.78), .92, 1.0)                                  # lawn (blade-level photo), mowing bands / wear come from the vertex colours
M_DIRT = acg_material("dirt", acg("Ground080", tint=(.82, .56, .40), gain=.95), .95, .25)                                  # infield clay (beige photo tinted red-brown)
M_TRACK = acg_material("track", acg("Ground110", tint=(.95, .62, .46), gain=1.05), .95, 1.0)                                # warning track: crushed stone
def flat(name, col, rough=0.8):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = col; b.inputs["Roughness"].default_value = rough; return m
_ch = noise_tex(512, [16, 64, 256], 21); M_CHALK = vc_material("chalk", make_image("chalk_albedo", np.repeat((.82+.18*_ch)[..., None], 3, 2), path=ROOT+"/tex/chalk_albedo.png"),
    make_image("chalk_normal", height_to_normal(_ch, 4.0), 'Non-Color', ROOT+"/tex/chalk_normal.png"), .95, .8); M_BASE = acg_material("base_white", acg("Fabric036", tint=(.95, .95, .93), gain=1.15, lumnorm=True), .6, .5)
M_YELLOW = flat("pole_yellow", (0.95, 0.75, 0.05, 1), 0.5); M_DUG = acg_material("dugout_concrete", acg("Concrete034", tint=(.85, .85, .83), gain=.8), .9, .9)
M_BENCH = flat("dugout_bench", (0.35, 0.22, 0.12, 1), 0.7); M_RUB = acg_material("rubber_white", acg("Rubber004", tint=(.95, .95, .93), gain=1.15, lumnorm=True), .7, .25)
M_PLATE = acg_material("plate_white", acg("Rubber004", tint=(.95, .95, .93), gain=1.15, lumnorm=True), .7, .25)
Y_DIRT, Y_G2, Y_CUT, Y_CH = 0.010, 0.020, 0.026, 0.034
LIGHT, DARK = (1, 1, 1, 1), (0.72, 0.80, 0.70, 1)
objs = []
def circle(cx, cz, r, n=96, a0=0.0, a1=2*math.pi):
    return [(cx+r*math.cos(a0+(a1-a0)*i/n), cz+r*math.sin(a0+(a1-a0)*i/n)) for i in range(n)]

# ---------------- ground (regular cells so vertex colours can carry mowing tint, wear and moisture)
outline = ground_outline()
def carved(p):
    ps = [p]
    for side in (1, -1): ps = [q for pp in ps for q in carve(pp, side)]
    return ps
b1, b2, b3 = base_center(1), base_center(2), base_center(3)
rngc = np.random.default_rng(5); band_tint = rngc.normal(1.0, .035, 200)
def vn(x, z): return .5+.5*math.sin(x*.71+math.sin(z*.43)*2)*math.cos(z*.63+math.sin(x*.37)*2)
SPOTS = [b1, b2, b3, (-8.5, 27.0), (8.5, 27.0), (-14, 19), (14, 19), (0, 28), (0, 74), (-30, 60), (30, 60)]
def wear(x, z):
    w = 0.0
    for i, (cx, cz) in enumerate(SPOTS): w += (0.55 if i < 3 else .28)*math.exp(-(((x-cx)**2+(z-cz)**2)/(2*(2.6 if i < 3 else 3.5)**2)))
    d = math.hypot(x, z-0) ; w += .35*math.exp(-((math.hypot(x-C_MOUND[0], z-C_MOUND[1])-6.5)/2.2)**2)         # ring around the mound
    r = math.hypot(x, z); dd = abs(fence_dist(math.atan2(x, z)) - r) if z > 0 else 99; w += .5*max(0, 1-dd/6.0) if dd < 6 else 0   # scuffing near the track
    return min(w, .85)
WEAR_T = np.array([.74, .62, .42])
def grass_col(k, dark):
    def f(x, z):
        base = np.array(DARK[:3]) if dark else np.array(LIGHT[:3]); w = wear(x, z); n = .96+.06*vn(x*1.3, z*1.3)
        c = (base*(1-w) + WEAR_T*w*base.mean()) * band_tint[k % 200] * n
        return (min(c[0], 1), min(c[1], 1), min(c[2], 1), 1)
    return f
mb = MB("Grass_Outfield", uv_scale=1.6); CELL = 4.6/3
for i, j, p in grid_cells(outline, CELL, 0.0, (-100.0, -100.0), (200.0, 260.0), clip_fn=carved):
    k = i//3; mb.poly(p, 0.0, grass_col(k, k % 2 == 0))
objs.append(mb.build(M_GRASS))
def dirt_col(x, z):
    w = math.exp(-(math.hypot(x-C_MOUND[0], z-C_MOUND[1])/6.0)**2)*.28 + math.exp(-(math.hypot(x, z)/7.0)**2)*.2
    for cx, cz in (b1, b2, b3): w += .22*math.exp(-((x-cx)**2+(z-cz)**2)/(2*3.0**2))
    n = .9+.1*vn(x*.9, z*.9); c = (1-min(w, .4))*n; return (c, c*.97, c*.94, 1)
mb = MB("Dirt", uv_scale=0.9)
cir = circle(*C_MOUND, 95*FT, 160)
for i, j, p in grid_cells(cir, 2.0, 0.0, (-70.0, -70.0), (140.0, 140.0), clip_fn=carved): mb.poly(p, Y_DIRT, dirt_col)
ap = clip_poly(outline, 0.0, -1.0, 6.0)
for i, j, p in grid_cells(ap, 2.0, 0.0, (-70.0, -70.0), (140.0, 140.0), clip_fn=carved): mb.poly(p, Y_DIRT, dirt_col)
objs.append(mb.build(M_DIRT))
mb = MB("WarningTrack", uv_scale=1.6)
outer = fence_pts(); inner = fence_pts(off=15*FT)
trk = outer + list(reversed(inner))
def track_col(x, z):
    r = math.hypot(x, z); dd = abs(fence_dist(math.atan2(x, z)) - r); n = .92+.08*vn(x*.6, z*.6); c = n*(.82+.18*min(dd/4.57, 1)); return (c, c, c, 1)
for i, j, p in grid_cells(trk, 2.0, 0.0, (-100.0, -100.0), (200.0, 260.0)): mb.poly(p, Y_DIRT, track_col)
objs.append(mb.build(M_TRACK))
# ---------------- infield grass diamond (diagonal mowing) with dirt cutouts on top
inset = 3*FT*math.sqrt(2)
diamond = [(0, inset), ((38.795-2*inset)/2, (38.795)/2), (0, 38.795-inset), (-(38.795-2*inset)/2, 38.795/2)]
mb = MB("Grass_Infield", uv_scale=1.6)
for i, j, p in grid_cells(diamond, 1.0, math.pi/4, (-30.0, -30.0), (100.0, 100.0)):
    k = i//3; mb.poly(p, Y_G2, grass_col(k+7, k % 2 == 0))
objs.append(mb.build(M_GRASS))
mb = MB("Dirt_Cutouts", uv_scale=0.9)
mb.poly(circle(0, 0.2, 13*FT, 72), Y_CUT, dirt_col)                 # home plate circle (13 ft radius)
for bc in (b1, b2, b3): mb.poly(circle(*bc, 1.6, 40), Y_CUT, dirt_col)
objs.append(mb.build(M_DIRT))
# ---------------- mound (MLB spec) + rubber
# 18 ft diameter circle centred 59 ft from the plate apex; 10 in above the plate; level area 5 ft wide x 34 in long whose front edge is 6 in in front of the
# rubber's front edge (rubber front edge 60 ft 6 in from the apex, rubber 24 x 6 in, i.e. spanning z = 60.5..61 ft); from the level area the surface falls
# 1 in per foot in every direction (measured from the level rectangle), eased to the field over the last 1.5 ft of the circle.
mb = MB("Mound", uv_scale=0.9); H = 10*IN; RO = 9*FT; NR, NS = 72, 128
LV_X, LV_Z0, LV_Z1 = 2.5*FT, 60.0*FT, 60.0*FT + 34*IN
def _sm(e): e = min(1.0, max(0.0, e)); return e*e*(3 - 2*e)
def mound_h(x, z):
    """Mound height above the field (m) at (x, z): min( plane cone, circle skirt ).
    cone  = H - (1 in / ft) * d,  d = distance (m) from the level rectangle |x| <= 2.5 ft, 60 ft <= z <= 60 ft + 34 in (MLB: 1 in per ft fall);
    skirt = H * smoothstep((9 ft - r) / 1.5 ft),  r = distance from the mound centre (0, 59 ft): the mound ends exactly on its 18 ft diameter circle;
    result clamped to >= 0."""
    dx = max(abs(x) - LV_X, 0.0); dz = max(LV_Z0 - z, z - LV_Z1, 0.0); d = math.hypot(dx, dz)
    r = math.hypot(x - C_MOUND[0], z - C_MOUND[1])
    return max(0.0, min(H - d*(1*IN/FT), H*_sm((RO - r)/(1.5*FT))))
rings = []
for i in range(NR+1):
    r = RO*i/NR
    row = []
    for k in range(NS):
        x = C_MOUND[0]+r*math.cos(2*math.pi*k/NS); z = C_MOUND[1]+r*math.sin(2*math.pi*k/NS)
        c = dirt_col(x, z); row.append(mb.vert(x, max(Y_CUT+0.002, mound_h(x, z)), z, col=c))
    rings.append(row)
for i in range(NR):
    for k in range(NS):
        a, b_, c, d_ = rings[i][k], rings[i][(k+1) % NS], rings[i+1][(k+1) % NS], rings[i+1][k]
        mb.tri(a, b_, c); mb.tri(a, c, d_)
objs.append(mb.build(M_DIRT, smooth=True))
rub = MB("PitchersRubber", uv_scale=.5); rub.box(0, 60.5*FT+3*IN, 24*IN, 6*IN, H-0.03, H+0.008)
objs.append(rub.build(M_RUB))
# ---------------- home plate (17 in front edge, 8.5 in sides, 12 in slanted; apex at origin)
hp = MB("HomePlate", uv_scale=.5); w = 8.5*IN; sd = 8.5*IN + math.sqrt((12*IN)**2 - w*w)
pl = [(0, 0), (w, sd-8.5*IN), (w, sd), (-w, sd), (-w, sd-8.5*IN)]
hp.poly(pl, Y_CUT+0.012); 
for i in range(5):
    j = (i+1) % 5; a = hp.vert(pl[i][0], Y_CUT+0.012, pl[i][1]); b_ = hp.vert(pl[j][0], Y_CUT+0.012, pl[j][1])
    c = hp.vert(pl[j][0], Y_CUT-0.02, pl[j][1]); d_ = hp.vert(pl[i][0], Y_CUT-0.02, pl[i][1])
    hp.quad_out(a, b_, c, d_, (0, 0, sd/2))
objs.append(hp.build(M_PLATE))
# ---------------- bases: 15 in square, 3 in high
for n, (cx, cz) in ((1, b1), (2, b2), (3, b3)):
    bb = MB(f"Base_{n}B", uv_scale=.5); bb.box(cx, cz, 15*IN, 15*IN, Y_CUT, Y_CUT+3*IN, rot=math.pi/4)
    objs.append(bb.build(M_BASE))
# ---------------- chalk (MLB Rule 2.01 layout): foul lines, batter's boxes, catcher's box, 3 ft running lane, coaches' boxes, on-deck circles
ch = MB("Chalk"); LW = 3*IN
def along(s, o=0.0, side=1): return (side*(s+o)*S2, (s-o)*S2)          # s = distance along the 1B (side 1) / 3B (side -1) line, o = offset into foul territory
# batter's boxes: 4 ft x 6 ft, inner line 6 in from the plate, centred on the plate's front-to-back midpoint
bx0, bx1 = w + 6*IN, w + 6*IN + 4*FT; zc = sd/2; zb0, zb1 = zc - 3*FT, zc + 3*FT
for sgn in (1, -1):
    ch.strip([(sgn*bx0, zb0), (sgn*bx1, zb0), (sgn*bx1, zb1), (sgn*bx0, zb1)], LW, Y_CH, closed=True)
# foul lines: not chalked across the plate or inside the batter's box; they start where the 45 deg line leaves the front of the box and run to the poles
s_start = zb1*math.sqrt(2)
ch.strip([along(s_start, 0, 1), POLE_R], LW, Y_CH); ch.strip([along(s_start, 0, -1), POLE_L], LW, Y_CH)
# catcher's box: 43 in wide, side lines run 8 ft back from the rear line of the batter's boxes, closed at the back
cbw = 43*IN/2; zcb = zb0 - 8*FT
ch.strip([(-cbw, zb0), (-cbw, zcb), (cbw, zcb), (cbw, zb0)], LW, Y_CH)
# first-base running lane: 3 ft outside the foul line from the 45 ft mark to first base, closed at the 45 ft end
ch.strip([along(45*FT, 3*FT), along(90*FT, 3*FT)], LW, Y_CH); ch.strip([along(45*FT, 3*FT), along(45*FT, 0.0)], LW, Y_CH)
for side in (1, -1):
    # coaches' boxes: 20 ft long parallel to the foul line, 15 ft from it, 10 ft deep (open on the far side), centred on the base
    s0, s1 = 90*FT - 10*FT, 90*FT + 10*FT; o0, o1 = 15*FT, 25*FT
    ch.strip([along(s0, o1, side), along(s0, o0, side), along(s1, o0, side), along(s1, o1, side)], LW, Y_CH)
    ch.strip(circle(side*11.3, 0.0, 0.76, 48), 0.06, Y_CH, closed=True)          # on-deck circles (5 ft diameter)
objs.append(ch.build(M_CHALK))
# ---------------- foul poles (yellow, 45 ft) with fair-side screen
for nm, (px, pz) in (("FoulPole_R", POLE_R), ("FoulPole_L", POLE_L)):
    fp = MB(nm); fp.box(px, pz, 0.15, 0.15, 0.0, 14.0)
    objs.append(fp.build(M_YELLOW))
# ---------------- dugouts (concrete shells; roofs are in stadium.glb) and bullpens
M_PADN = acg_material("dugout_padding", acg("Leather026", tint=(.12, .2, .55), gain=.7, lumnorm=True), .8, .6); M_WOOD = acg_material("dugout_wood", acg("Wood066", gain=1.0), .65, .8); M_RAIL = acg_material("dugout_steel", acg("Metal032"), .4, .7, metal=1.0)
M_DARK = flat("dugout_interior", (0.06, 0.06, 0.07, 1), 0.9); M_FLOOR = flat("dugout_floor", (0.28, 0.28, 0.29, 1), 0.85)
for nm, side in (("Dugout_1B", 1), ("Dugout_3B", -1)):
    s0, s1 = DUG_S; o0, o1 = DUG_O; rot = -side*math.pi/4; fl = DUG_FLOOR; ln = s1-s0
    def P(s, o): return dug_xy(s, o, side)
    def BX(mb_, s_lo, s_hi, o_lo, o_hi, y0, y1):
        cx, cz = P((s_lo+s_hi)/2, (o_lo+o_hi)/2); mb_.box(cx, cz, o_hi-o_lo, s_hi-s_lo, y0, y1, rot=rot)
    conc, pad, wood, rail, dark = MB(nm, uv_scale=1.6), MB(nm+"_Padding", uv_scale=.6), MB(nm+"_Bench", uv_scale=.6), MB(nm+"_Rail", uv_scale=.5), MB(nm+"_Interior")
    BX(conc, s0, s1, o0, o1, fl-.3, fl)                                         # floor slab (top at fl)
    BX(conc, s0, s1, o0, o0+.30, fl, .55)                                       # front wall (field side), lip 0.55 m above the field
    BX(conc, s0, s1, o1-.30, o1, fl, 2.55)                                      # back wall
    BX(conc, s0, s0+.25, o0+.30, o1-.30, fl, 2.55); BX(conc, s1-.25, s1, o0+.30, o1-.30, fl, 2.55)   # end walls (tunnel entrance omitted: steps at s0 end)
    BX(pad, s0+.3, s1-.3, o1-.34, o1-.30, fl+.9, 2.2)                           # padded back panel
    BX(pad, s0+.3, s1-.3, o0+.28, o0+.34, fl+.6, .50)                           # padded front rail facing the bench
    BX(rail, s0, s1, o0-.05, o0+.12, .55, .68)                                  # top rail along the lip
    for k in range(int(ln//2.4)+1):
        BX(rail, s0+k*2.4-.03, s0+k*2.4+.03, o0-.02, o0+.08, .68, 1.05)        # rail posts
    BX(wood, s0+1.3, s1-.6, o1-1.25, o1-.75, fl+.42, fl+.50)                    # bench seat
    BX(wood, s0+1.3, s1-.6, o1-.78, o1-.70, fl+.50, fl+1.0)                     # bench back
    for k in range(6): BX(rail, s0+1.5+k*(ln-2.5)/5, s0+1.6+k*(ln-2.5)/5, o1-1.2, o1-.8, fl, fl+.42)   # bench legs
    for k in range(4): BX(conc, s0+.25+k*.28, s0+.25+(k+1)*.28, o0+.6, o0+1.5, fl, fl+.18*(4-k)+.0)     # steps at the s0 end (rise from floor)
    BX(rail, s1-5.5, s1-.5, o1-.7, o1-.35, fl+1.6, fl+1.66)                     # helmet/bat rack rail
    for k in range(8): BX(dark, s1-5.3+k*.62, s1-5.3+k*.62+.08, o1-.75, o1-.5, fl+1.66, fl+2.0)   # bat/helmet rack pegs
    BX(dark, s0+.25, s1-.25, o0+.30, o1-.30, fl-.01, fl+.001)                   # (kept for tri budget: dark interior floor shadow plane)
    for mbx, mat_ in ((conc, M_DUG), (pad, M_PADN), (wood, M_WOOD), (rail, M_RAIL), (dark, M_DARK)): objs.append(mbx.build(mat_))
for nm, side in (("Bullpen_R", 1), ("Bullpen_L", -1)):
    bp = MB(nm, uv_scale=0.9); m0 = along(62, 8, side); p0 = along(80.4, 8, side)
    bp.poly(circle(*m0, 2.0, 32), Y_CUT); bp.poly(circle(*p0, 1.6, 32), Y_CUT)
    bp.box(*m0, 0.6, 0.15, Y_CUT, Y_CUT+0.20)
    objs.append(bp.build(M_DIRT))
    bpl = MB(nm+"_Plate"); bpl.poly(pl if False else [(p0[0]+x, p0[1]+z) for x, z in pl], Y_CUT+0.012); objs.append(bpl.build(M_PLATE))
# ---------------- layout metadata for engine / sim / stadium
FX = lambda p: [-p[0], p[1]]
layout = {"units": "meters", "axes": "Y up, +Z center field, +X THIRD base (first base at -X), origin home plate apex",
          "bases": {"home": [0, 0], "first": FX(b1), "second": FX(b2), "third": FX(b3)},
          "mound_center": FX(C_MOUND), "rubber_front_z": 60.5*FT, "rubber_size": [24*IN, 6*IN], "mound_height": H, "mound_top_y": H, "mound_radius": 9*FT, "mound_level_area": {"x_half": 2.5*FT, "z_from": 60.0*FT, "z_to": 60.0*FT+34*IN}, "mound_slope_per_m": 1*IN/FT,
          "mound_profile": "h(x,z)=max(0,min(H-(1in/ft)*d, H*smoothstep((R-r)/(1.5ft)))); H=10in=0.254m, R=9ft, r=hypot(x-cx,z-cz) from mound_center (z=59ft), d=distance to the level rectangle |x|<=2.5ft, z in [60ft,60ft+34in]; front slope is exactly 1in/ft to the circle edge",
          "foul_poles": {"left": FX(POLE_L), "right": FX(POLE_R)}, "warning_track_width": 15*FT,
          "fence": [[round(-x, 3), round(z, 3)] for x, z in fence_pts(91)],
          "ground_outline": [[round(-x, 3), round(z, 3)] for x, z in outline], "backstop_z": BACKSTOP_Z}
json.dump(layout, open(ROOT+"/field_layout.json", "w"), indent=1)
_BOXT = {"_Padding": .6, "_Bench": .8, "_Rail": .5}
for o_ in objs:                                    # box-projected UVs where the planar xz UVs would streak on vertical faces
    if o_.name.startswith("Dugout") and not o_.name.endswith("_Interior"): box_uv_obj(o_, next((v for k, v in _BOXT.items() if o_.name.endswith(k)), 1.2))
    elif o_.name in ("PitchersRubber", "HomePlate") or o_.name.startswith("Base_"): box_uv_obj(o_, .5)
export(objs, ROOT+"/field.glb", mirror=True, jpg=True, export_vertex_color='ACTIVE', export_active_vertex_color_when_no_material=True)
result = {"objs": [o.name for o in objs], "tris": sum(len(o.data.polygons) for o in objs)}

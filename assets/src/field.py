for f in ("common", "geom", "meshkit", "textures"): exec(open(CB_SRC + f"/{f}.py").read())
import json
reset_scene()
S2 = math.sqrt(.5)
# ---------------- materials
g, gh = grass_tex(); d, dh = dirt_tex(); t, th = dirt_tex(seed=5, base=(0.42, 0.19, 0.11), var=0.3)
def mk(nm, arr, h, ns, rough=0.95):
    return vc_material(nm, make_image(nm+"_albedo", arr, path=ROOT+f"/tex/{nm}_albedo.png"),
                       make_image(nm+"_normal", height_to_normal(h, ns), 'Non-Color', ROOT+f"/tex/{nm}_normal.png"), rough)
M_GRASS = mk("grass", g, gh, 3.0); M_DIRT = mk("dirt", d, dh, 5.0); M_TRACK = mk("track", t, th, 5.0)
def flat(name, col, rough=0.8):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = col; b.inputs["Roughness"].default_value = rough; return m
M_CHALK = flat("chalk", (0.9, 0.9, 0.88, 1), 0.95); M_BASE = flat("base_white", (0.85, 0.85, 0.85, 1), 0.6)
M_YELLOW = flat("pole_yellow", (0.95, 0.75, 0.05, 1), 0.5); M_DUG = flat("dugout_concrete", (0.45, 0.45, 0.45, 1), 0.9)
M_BENCH = flat("dugout_bench", (0.35, 0.22, 0.12, 1), 0.7); M_RUB = flat("rubber_white", (0.9, 0.9, 0.9, 1), 0.7)
M_PLATE = flat("plate_white", (0.9, 0.9, 0.9, 1), 0.7)
Y_DIRT, Y_G2, Y_CUT, Y_CH = 0.010, 0.020, 0.026, 0.034
LIGHT, DARK = (1, 1, 1, 1), (0.72, 0.80, 0.70, 1)
objs = []
def circle(cx, cz, r, n=96, a0=0.0, a1=2*math.pi):
    return [(cx+r*math.cos(a0+(a1-a0)*i/n), cz+r*math.sin(a0+(a1-a0)*i/n)) for i in range(n)]

# ---------------- outfield / foul grass: 4.6 m mowing bands running toward center field
outline = ground_outline()
mb = MB("Grass_Outfield")
def carved(p):
    ps = [p]
    for side in (1, -1): ps = [q for pp in ps for q in carve(pp, side)]
    return ps
for k, p in bands(outline, 0.0, 4.6, -70, 70):
    for q in carved(p): mb.poly(q, 0.0, LIGHT if k % 2 else DARK)
objs.append(mb.build(M_GRASS))
# ---------------- dirt: skin (95 ft circle around mound), warning track, home area, base paths
mb = MB("Dirt")
for q in carved(circle(*C_MOUND, 95*FT, 160)): mb.poly(q, Y_DIRT)
for q in carved(clip_poly(outline, 0.0, -1.0, 6.0)): mb.poly(q, Y_DIRT)   # backstop apron
objs.append(mb.build(M_DIRT))
mb = MB("WarningTrack")
outer = fence_pts(); inner = fence_pts(off=15*FT)
mb.poly(outer + list(reversed(inner)), Y_DIRT, holes=())
objs.append(mb.build(M_TRACK))
# ---------------- infield grass diamond (diagonal mowing) with dirt cutouts on top
b1, b2, b3 = base_center(1), base_center(2), base_center(3)
inset = 3*FT*math.sqrt(2)
diamond = [(0, inset), (18.1, 18.1+inset), (0, 38.795-inset*1.0+0.0), (-18.1, 18.1+inset)]
diamond = [(0, inset), ((38.795-2*inset)/2 + 0.0, (38.795)/2), (0, 38.795-inset), (-(38.795-2*inset)/2, 38.795/2)]
mb = MB("Grass_Infield")
for k, p in bands(diamond, math.pi/4, 3.0, -30, 60): mb.poly(p, Y_G2, LIGHT if k % 2 else DARK)
objs.append(mb.build(M_GRASS))
mb = MB("Dirt_Cutouts")
mb.poly(circle(0, 0.2, 13*FT, 72), Y_CUT)                 # home plate circle (13 ft radius)
for bc in (b1, b2, b3): mb.poly(circle(*bc, 1.6, 40), Y_CUT)
objs.append(mb.build(M_DIRT))
# ---------------- mound (18 ft diameter, 10 in above plate) + rubber
mb = MB("Mound"); H = 10*IN; RO = 9*FT; RP = 1.4; NR, NS = 20, 72
rings = []
for i in range(NR+1):
    r = RO*i/NR
    u = max(0.0, min(1.0, (RO - r)/(RO-RP))); h = Y_CUT+0.002 + (H-Y_CUT-0.002)*(u*u*(3-2*u))
    rings.append([mb.vert(C_MOUND[0]+r*math.cos(2*math.pi*k/NS), h, C_MOUND[1]+r*math.sin(2*math.pi*k/NS)) for k in range(NS)])
for i in range(NR):
    for k in range(NS):
        a, b_, c, d_ = rings[i][k], rings[i][(k+1) % NS], rings[i+1][(k+1) % NS], rings[i+1][k]
        mb.tri(a, b_, c); mb.tri(a, c, d_)
objs.append(mb.build(M_DIRT, smooth=True))
rub = MB("PitchersRubber"); rub.box(0, 60.5*FT-3*IN, 24*IN, 6*IN, H-0.03, H+0.012)
objs.append(rub.build(M_RUB))
# ---------------- home plate (17 in front edge, 8.5 in sides, 12 in slanted; apex at origin)
hp = MB("HomePlate"); w = 8.5*IN; sd = 8.5*IN + math.sqrt((12*IN)**2 - w*w)
pl = [(0, 0), (w, sd-8.5*IN), (w, sd), (-w, sd), (-w, sd-8.5*IN)]
hp.poly(pl, Y_CUT+0.012); 
for i in range(5):
    j = (i+1) % 5; a = hp.vert(pl[i][0], Y_CUT+0.012, pl[i][1]); b_ = hp.vert(pl[j][0], Y_CUT+0.012, pl[j][1])
    c = hp.vert(pl[j][0], Y_CUT-0.02, pl[j][1]); d_ = hp.vert(pl[i][0], Y_CUT-0.02, pl[i][1])
    hp.quad_out(a, b_, c, d_, (0, 0, sd/2))
objs.append(hp.build(M_PLATE))
# ---------------- bases: 15 in square, 3 in high
for n, (cx, cz) in ((1, b1), (2, b2), (3, b3)):
    bb = MB(f"Base_{n}B"); bb.box(cx, cz, 15*IN, 15*IN, Y_CUT, Y_CUT+3*IN, rot=math.pi/4)
    objs.append(bb.build(M_BASE))
# ---------------- chalk: foul lines, batter's boxes, catcher's box, coach boxes, lane, on-deck circles
ch = MB("Chalk"); LW = 3*IN
ch.strip([(0, 0), POLE_R], LW, Y_CH); ch.strip([(0, 0), POLE_L], LW, Y_CH)
bx0, bx1 = w + 6*IN, w + 6*IN + 4*FT; zc = sd/2
for sgn in (1, -1):
    r = [(sgn*bx0, zc-3*FT), (sgn*bx1, zc-3*FT), (sgn*bx1, zc+3*FT), (sgn*bx0, zc+3*FT)]
    ch.strip(r, 5*IN*0.4, Y_CH, closed=True)
cbw = 43*IN/2
ch.strip([(-cbw, 3*FT+zc+0.0-2.4-0.0+2.4-0.9*0), (-cbw, -2.4), (cbw, -2.4), (cbw, 3*FT+zc-2.4-0.0+0.0-0.0)], 5*IN*0.4, Y_CH)
# first-base 3 ft running lane (45 ft -> 1B, on the foul side of the foul line)
s45 = 45*FT; lane = [((s45)*S2 + off*S2, (s45)*S2 - off*S2) for off in [0]]
def along(s, o=0.0, side=1): return (side*(s+o)*S2, (s-o)*S2)
ch.strip([along(45*FT, 3*FT), along(88*FT, 3*FT)], LW, Y_CH); ch.strip([along(45*FT, 3*FT), along(45*FT, 0.0)], LW, Y_CH)
ch.strip([along(88*FT, 3*FT), along(88*FT, 0.0)], LW, Y_CH)
for side in (1, -1):                                        # coach boxes: 10 ft x 20 ft?? (approx) beside 1B/3B
    for o0 in (15*FT,):
        s0, s1 = 90*FT-10*FT, 90*FT+10*FT
        ch.strip([along(s0, o0, side), along(s1, o0, side), along(s1, o0+10*FT, side), along(s0, o0+10*FT, side)], LW*0.8, Y_CH, closed=True)
    ch.strip(circle(side*11.3, 0.0, 0.76, 48), 0.06, Y_CH, closed=True)          # on-deck circles (5 ft diameter)
objs.append(ch.build(M_CHALK))
# ---------------- foul poles (yellow, 45 ft) with fair-side screen
for nm, (px, pz) in (("FoulPole_R", POLE_R), ("FoulPole_L", POLE_L)):
    fp = MB(nm); fp.box(px, pz, 0.15, 0.15, 0.0, 14.0)
    objs.append(fp.build(M_YELLOW))
# ---------------- dugouts (concrete shells; roofs are in stadium.glb) and bullpens
M_PADN = flat("dugout_padding", (0.02, 0.05, 0.16, 1), 0.8); M_WOOD = flat("dugout_wood", (0.45, 0.3, 0.16, 1), 0.65); M_RAIL = flat("dugout_steel", (0.6, 0.62, 0.65, 1), 0.4)
M_DARK = flat("dugout_interior", (0.06, 0.06, 0.07, 1), 0.9); M_FLOOR = flat("dugout_floor", (0.28, 0.28, 0.29, 1), 0.85)
for nm, side in (("Dugout_1B", 1), ("Dugout_3B", -1)):
    s0, s1 = DUG_S; o0, o1 = DUG_O; rot = -side*math.pi/4; fl = DUG_FLOOR; ln = s1-s0
    def P(s, o): return dug_xy(s, o, side)
    def BX(mb_, s_lo, s_hi, o_lo, o_hi, y0, y1):
        cx, cz = P((s_lo+s_hi)/2, (o_lo+o_hi)/2); mb_.box(cx, cz, o_hi-o_lo, s_hi-s_lo, y0, y1, rot=rot)
    conc, pad, wood, rail, dark = MB(nm), MB(nm+"_Padding"), MB(nm+"_Bench"), MB(nm+"_Rail"), MB(nm+"_Interior")
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
    bp = MB(nm); m0 = along(62, 8, side); p0 = along(80.4, 8, side)
    bp.poly(circle(*m0, 2.0, 32), Y_CUT); bp.poly(circle(*p0, 1.6, 32), Y_CUT)
    bp.box(*m0, 0.6, 0.15, Y_CUT, Y_CUT+0.20)
    objs.append(bp.build(M_DIRT))
    bpl = MB(nm+"_Plate"); bpl.poly(pl if False else [(p0[0]+x, p0[1]+z) for x, z in pl], Y_CUT+0.012); objs.append(bpl.build(M_PLATE))
# ---------------- layout metadata for engine / sim / stadium
FX = lambda p: [-p[0], p[1]]
layout = {"units": "meters", "axes": "Y up, +Z center field, +X THIRD base (first base at -X), origin home plate apex",
          "bases": {"home": [0, 0], "first": FX(b1), "second": FX(b2), "third": FX(b3)},
          "mound_center": FX(C_MOUND), "rubber_front_z": 60.5*FT, "mound_height": H,
          "foul_poles": {"left": FX(POLE_L), "right": FX(POLE_R)}, "warning_track_width": 15*FT,
          "fence": [[round(-x, 3), round(z, 3)] for x, z in fence_pts(91)],
          "ground_outline": [[round(-x, 3), round(z, 3)] for x, z in outline], "backstop_z": BACKSTOP_Z}
json.dump(layout, open(ROOT+"/field_layout.json", "w"), indent=1)
export(objs, ROOT+"/field.glb", mirror=True, jpg=True, export_vertex_color='ACTIVE', export_active_vertex_color_when_no_material=True)
result = {"objs": [o.name for o in objs], "tris": sum(len(o.data.polygons) for o in objs)}

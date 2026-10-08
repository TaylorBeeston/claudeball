# Pose authoring by targets (torso lean/yaw, hand & foot world targets) -> FK/2-bone IK -> pose-bone keyframes.
# Blender axes: character faces -Y, left = +X, up = +Z. Requires player_rig.py exec'd (PFX, JOINTS, ORDER).
import bpy, math
from mathutils import Vector, Quaternion, Matrix
FPS = 30
UP = Vector((0, 0, 1))
def Rz(deg): return Matrix.Rotation(math.radians(deg), 3, 'Z')
def lean_dir(lean, side=0.0):
    l, s = math.radians(lean), math.radians(side)
    return Vector((math.sin(s), -math.sin(l), math.cos(l)*math.cos(s))).normalized()
def hand_frame(side):
    sx = 1 if side == "Left" else -1; z = REST_DIR_[side+"Hand"]; x = Vector((-sx, 0, 0)); y = z.cross(x).normalized(); x = y.cross(z).normalized(); return x, y, z
REST_DIR_ = {n: (JOINTS[n][2]-JOINTS[n][1]).normalized() for n in ORDER}
LEN = {n: (JOINTS[n][2]-JOINTS[n][1]).length for n in ORDER}
REST_DIR = {n: (JOINTS[n][2]-JOINTS[n][1]).normalized() for n in ORDER}
REST_HEAD = {n: JOINTS[n][1].copy() for n in ORDER}

NECK_YAW_SHARE = 0.5
CLAMPS = []
def ik2(root, target, l1, l2, pole):
    dv = target-root; dist = dv.length
    if dist > l1+l2+1e-3: CLAMPS.append(round(dist-(l1+l2), 3))
    d = max(abs(l1-l2)+1e-3, min(dist, l1+l2-1e-3)); dn = dv.normalized()
    a = (l1*l1-l2*l2+d*d)/(2*d); h = math.sqrt(max(l1*l1-a*a, 0.0))
    pv = pole - dn*pole.dot(dn)
    pv = pv.normalized() if pv.length > 1e-6 else Vector((0, -1, 0))
    elbow = root + dn*a + pv*h; tip = root + dn*d
    return (elbow-root).normalized(), (tip-elbow).normalized()

# ---------------------------------------------------------------- arm chain with a real elbow hinge
# The upper arm, forearm and hand used to be turned each by the shortest arc from its rest direction to its new one: their rolls had nothing to do with
# each other, so the elbow bent sideways off its hinge, the forearm twisted up to 180 deg and the wrist took the rest ("body horror": a batter's wrists
# bent 150-175 deg in batting_stance / ondeck_swing / batter_step_out, glove meshes collapsing). Now the upper arm is rolled so the elbow's hinge axis is
# the normal of the arm's plane, the forearm is that hinge rotation plus a pronation share (<= PRON_MAX) of the hand's remaining twist, and the hand keeps
# exactly the world orientation it had (grips, ball, glove pocket and bat are where they were). Joint positions are unchanged.
PRON_SHARE, PRON_MAX = .5, 90.0                                    # a big twist is split evenly between the elbow end and the wrist end of the forearm skin
FRONT = Vector((0, -1, 0))
def _hinge_basis(y, a):
    y = y.normalized(); a = (a - y*a.dot(y)).normalized(); return Matrix((a, y, a.cross(y))).transposed()
def hinge_rest(sd):
    """The elbow's hinge axis at rest (world): the forearm flexes toward the front of the body."""
    return REST_DIR[sd+"Arm"].cross(FRONT).normalized()
def arm_chain(sd, d1, d2, pole, qh):
    a = d1.cross(d2)
    if a.length < 1e-4:                                                         # straight arm: the elbow points to the pole, the hinge is perpendicular to both
        pv = pole - d1*pole.dot(d1); a = pv.cross(d1) if pv.length > 1e-6 else hinge_rest(sd)
    a.normalize()
    h0 = hinge_rest(sd)
    qa = (_hinge_basis(d1, a) @ _hinge_basis(REST_DIR[sd+"Arm"], h0).transposed()).to_quaternion()
    qf0 = (_hinge_basis(d2, a) @ _hinge_basis(REST_DIR[sd+"ForeArm"], h0).transposed()).to_quaternion()
    # the hand's twist about the forearm axis that the wrist would have to make on its own; the forearm pronates part of it
    r = qf0.inverted() @ qh; ax = REST_DIR[sd+"ForeArm"]
    tw = 2*math.atan2(Vector((r.x, r.y, r.z)).dot(ax), r.w); tw = (tw + math.pi) % (2*math.pi) - math.pi
    p = max(-math.radians(PRON_MAX), min(math.radians(PRON_MAX), PRON_SHARE*tw))
    qf = Quaternion(d2, p) @ qf0
    return qa, qf

# the wrist never goes into the head: an ellipsoid around head + helmet (+ the big-head morphs) with a 1.5 cm margin, in the head bone's frame; a wrist target
# inside it (a bat path whose follow-through ran the hands through the face: on-deck / practice swings) is pushed out to its surface
HEAD_SAFE_C = Vector((0, -.065, 1.735)); HEAD_SAFE_AX = Vector((.098 + .015, .125 + .015, .135 + .015))
def clear_of_head(p, head_joint, q_head):
    c = head_joint + q_head @ (HEAD_SAFE_C - REST_HEAD['Head']); d = q_head.inverted() @ (p - c)
    n = math.sqrt((d.x/HEAD_SAFE_AX.x)**2 + (d.y/HEAD_SAFE_AX.y)**2 + (d.z/HEAD_SAFE_AX.z)**2)
    if n >= 1.0 or n < 1e-6: return p
    return c + q_head @ (d/n)

DEFAULT = dict(hips=(0, 0, 0), hyaw=0, yaw=0, lean=0, side=0, head_yaw=None, head_pitch=0, neck_yaw=None,
               lfoot=(.13, 0, .08), rfoot=(-.13, 0, .08), lknee=(0, -1, 0), rknee=(0, -1, 0), lfoot_o=(0, 0), rfoot_o=(0, 0),
               lhand=(.27, -.06, .90), rhand=(-.27, -.06, .90), lpole=(.5, .9, 0), rpole=(-.5, .9, 0), lhand_dir=None, rhand_dir=None, lhand_twist=0, rhand_twist=0, bat=None, lhand_rel=None, rhand_rel=None, lhand_face=None, rhand_face=None)   # *_rel: wrist target as an offset from that shoulder; *_face: world direction the palm / glove pocket should face

def solve(spec):
    """Return {bone: (M_arm matrix 4x4)} for a pose spec."""
    P = dict(DEFAULT); P.update(spec)
    hips = Vector((0, 0, .95)) + Vector(P['hips'])
    delta = {}; head = {}; d_out = {}; tw = {}
    def setb(n, d, twist=0.0):
        d = Vector(d).normalized(); q = REST_DIR[n].rotation_difference(d)
        if twist: q = Quaternion(d, math.radians(twist)) @ q
        delta[n] = q; d_out[n] = d
    def place(n):
        p = JOINTS[n][0]
        head[n] = hips.copy() if p is None else head[p] + delta[p] @ (REST_HEAD[n]-REST_HEAD[p])
    yaw, lean, side = P['yaw'], P['lean'], P['side']
    place('Hips'); setb('Hips', Rz(P['hyaw']) @ UP, P['hyaw'])
    for n, w in (('Spine', .3), ('Spine1', .65), ('Spine2', 1.0)):
        place(n); setb(n, Rz(yaw*w) @ lean_dir(lean*w, side*w), yaw*w)
    hy = P['head_yaw'] if P['head_yaw'] is not None else yaw
    ny = P['neck_yaw'] if P['neck_yaw'] is not None else yaw + NECK_YAW_SHARE*(hy - yaw)   # neck turns only part of the way from the torso to the head (no candy-wrapper twist at the collar)
    place('Neck'); setb('Neck', Rz(ny) @ lean_dir(P['head_pitch']*.5), ny)
    place('Head'); setb('Head', Rz(hy) @ lean_dir(P['head_pitch']), hy)
    for sd, sx in (("Left", 1), ("Right", -1)):
        k = sd[0].lower()
        for n in (sd+"Shoulder", sd+"Arm"):
            place(n)
            if n == sd+"Shoulder": delta[n] = delta['Spine2']; d_out[n] = delta[n] @ REST_DIR[n]
        # arm IK (optionally driven by a bat grip)
        hd_dir = P[k+'hand_dir']; hd_tw = P[k+'hand_twist']; wr_target = Vector(P[k+'hand'])
        if P['bat']:
            knob, B = Vector(P['bat'][0]), Vector(P['bat'][1]).normalized()
            grip = knob + B*(.035 if sd == "Left" else .135)
            ref = Vector((1, 0, 0)) if abs(B.dot(Vector((1, 0, 0)))) < .9 else Vector((0, 0, -1))
            # the hand wraps the handle: its axis (wrist -> knuckles) is perpendicular to the bat and as close as it can be to the arm's own line
            # (shoulder -> grip); a fixed ref x bat direction pointed the hand back along the forearm for some bat angles (wrist bent 150-170 deg)
            arm_line = grip - head[sd+"Arm"]
            def grip_frame(line):
                line = line - B*line.dot(B)
                dd = (line.normalized() if line.length > .02 else ref.cross(B).normalized()) if hd_dir is None else Vector(hd_dir).normalized()
                xr, yr, zr = hand_frame(sd); q = REST_DIR[sd+"Hand"].rotation_difference(dd); ya = q @ yr
                tgt = (B - dd*B.dot(dd)).normalized()*(1 if sd == "Right" else -1); ya_p = (ya - dd*ya.dot(dd)).normalized()
                ang = math.atan2(dd.dot(ya_p.cross(tgt)), ya_p.dot(tgt)); tw_ = math.degrees(ang) + (P['bat'][2] if len(P['bat']) > 2 else 0)
                qt = Quaternion(dd, math.radians(tw_)) @ q; N = qt @ xr
                return dd, tw_, grip - dd*.06 - N*.03
            dd, hd_tw, wr_target = grip_frame(arm_line)
            # second pass: the forearm (elbow -> wrist) of that solution is the line the hand should continue
            _d1, _d2 = ik2(head[sd+"Arm"], wr_target, LEN[sd+"Arm"], LEN[sd+"ForeArm"], Vector(P[k+'pole']))
            dd, hd_tw, wr_target = grip_frame(_d2)
            hd_dir = dd
        if P[k+'hand_rel'] is not None: wr_target = head[sd+"Arm"] + Vector(P[k+'hand_rel'])
        wr_target = clear_of_head(wr_target, head['Head'], delta['Head'])
        d1, d2 = ik2(head[sd+"Arm"], wr_target, LEN[sd+"Arm"], LEN[sd+"ForeArm"], Vector(P[k+'pole']))
        dd_ = Vector(hd_dir).normalized() if hd_dir is not None else d2
        if P[k+'hand_face'] is not None:                                            # twist about the hand axis so that the palm (pocket) faces the requested direction
            xr_, yr_, zr_ = hand_frame(sd); pn = REST_DIR[sd+"Hand"].rotation_difference(dd_) @ xr_; tg = Vector(P[k+'hand_face']); tg = tg - dd_*tg.dot(dd_)
            if tg.length > 1e-4: tg.normalize(); hd_tw = math.degrees(math.atan2(dd_.dot(pn.cross(tg)), pn.dot(tg)))
        qh = Quaternion(dd_, math.radians(hd_tw)) @ REST_DIR[sd+"Hand"].rotation_difference(dd_) if hd_tw else REST_DIR[sd+"Hand"].rotation_difference(dd_)
        qa, qf = arm_chain(sd, d1, d2, Vector(P[k+'pole']), qh)
        delta[sd+"Arm"] = qa; d_out[sd+"Arm"] = d1; place(sd+"ForeArm")
        delta[sd+"ForeArm"] = qf; d_out[sd+"ForeArm"] = d2
        place(sd+"Hand"); delta[sd+"Hand"] = qh; d_out[sd+"Hand"] = dd_
        # leg IK
        place(sd+"UpLeg"); l1, l2 = LEN[sd+"UpLeg"], LEN[sd+"Leg"]
        d1, d2 = ik2(head[sd+"UpLeg"], Vector(P[k+'foot']), l1, l2, Vector(P[k+'knee']))
        setb(sd+"UpLeg", d1); place(sd+"Leg"); setb(sd+"Leg", d2); place(sd+"Foot")
        fy, fp = P[k+'foot_o']; base = Vector(REST_DIR[sd+"Foot"]); base = Matrix.Rotation(math.radians(fp), 3, Rz(fy) @ Vector((1, 0, 0))) @ (Rz(fy) @ base)
        setb(sd+"Foot", base); place(sd+"ToeBase"); delta[sd+"ToeBase"] = delta[sd+"Foot"]
    # matrices
    rest = {n: bpy.data.objects["Armature"].data.bones[PFX+n].matrix_local for n in ORDER}
    M = {}
    for n in ORDER:
        Rr = rest[n].to_3x3()
        M[n] = Matrix.Translation(head[n]) @ (delta[n].to_matrix() @ Rr).to_4x4()
    return M, rest

def key_pose(arm, spec, frame):
    M, rest = solve(spec)
    for n in ORDER:
        p = JOINTS[n][0]; pb = arm.pose.bones[PFX+n]
        if p is None: basis = rest[n].inverted() @ M[n]
        else: basis = (rest[p].inverted() @ rest[n]).inverted() @ M[p].inverted() @ M[n]
        loc, rot, _ = basis.decompose(); pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = rot; pb.location = loc
        pb.keyframe_insert('rotation_quaternion', frame=frame)
        if p is None or (loc.length > 1e-5): pb.keyframe_insert('location', frame=frame)

def new_action(arm, name):
    if arm.animation_data is None: arm.animation_data_create()
    act = bpy.data.actions.new(name); act.use_fake_user = True; arm.animation_data.action = act; return act

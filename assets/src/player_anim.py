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
LEN = {n: (JOINTS[n][2]-JOINTS[n][1]).length for n in ORDER}
REST_DIR = {n: (JOINTS[n][2]-JOINTS[n][1]).normalized() for n in ORDER}
REST_HEAD = {n: JOINTS[n][1].copy() for n in ORDER}

def ik2(root, target, l1, l2, pole):
    dv = target-root; dist = dv.length; d = max(abs(l1-l2)+1e-3, min(dist, l1+l2-1e-3)); dn = dv.normalized()
    a = (l1*l1-l2*l2+d*d)/(2*d); h = math.sqrt(max(l1*l1-a*a, 0.0))
    pv = pole - dn*pole.dot(dn)
    pv = pv.normalized() if pv.length > 1e-6 else Vector((0, -1, 0))
    elbow = root + dn*a + pv*h; tip = root + dn*d
    return (elbow-root).normalized(), (tip-elbow).normalized()

DEFAULT = dict(hips=(0, 0, 0), hyaw=0, yaw=0, lean=0, side=0, head_yaw=None, head_pitch=0,
               lfoot=(.13, 0, .08), rfoot=(-.13, 0, .08), lknee=(0, -1, 0), rknee=(0, -1, 0), lfoot_o=(0, 0), rfoot_o=(0, 0),
               lhand=(.27, -.06, .90), rhand=(-.27, -.06, .90), lpole=(.5, .9, 0), rpole=(-.5, .9, 0), lhand_dir=None, rhand_dir=None)

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
    place('Neck'); setb('Neck', Rz(hy) @ lean_dir(P['head_pitch']*.5), hy)
    place('Head'); setb('Head', Rz(hy) @ lean_dir(P['head_pitch']), hy)
    for sd, sx in (("Left", 1), ("Right", -1)):
        k = sd[0].lower()
        for n in (sd+"Shoulder", sd+"Arm"):
            place(n)
            if n == sd+"Shoulder": delta[n] = delta['Spine2']; d_out[n] = delta[n] @ REST_DIR[n]
        # arm IK
        d1, d2 = ik2(head[sd+"Arm"], Vector(P[k+'hand']), LEN[sd+"Arm"], LEN[sd+"ForeArm"], Vector(P[k+'pole']))
        setb(sd+"Arm", d1); place(sd+"ForeArm"); setb(sd+"ForeArm", d2); place(sd+"Hand")
        setb(sd+"Hand", P[k+'hand_dir'] if P[k+'hand_dir'] else d2)
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

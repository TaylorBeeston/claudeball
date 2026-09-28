# Shared ballpark geometry, in GAME coordinates (meters): origin = home plate apex (back tip),
# +Y up, +Z toward center field, +X toward first base. Blender is built as (x, -z, y) so that
# glTF export (Y-up) yields exactly these coordinates.
import math
FT = 0.3048
IN = 0.0254
def B(x, y, z): return (x, -z, y)                 # game -> blender
def fence_dist(a):                                # a = angle from CF line in radians, |a| <= 45 deg
    return (330 + 70*math.cos(2*a))*FT            # 330 ft at lines, 400 ft to center
def fence_pts(n=181, off=0.0):
    out = []
    for i in range(n):
        a = math.radians(45 - 90*i/(n-1)); d = fence_dist(a) - off
        out.append((d*math.sin(a), d*math.cos(a)))
    return out                                    # RF line -> LF line
POLE_R = (330*FT*math.sqrt(.5), 330*FT*math.sqrt(.5))
POLE_L = (-POLE_R[0], POLE_R[1])
BACKSTOP_Z = -60*FT
_R = [(66, 53), (54, 32), (38, 8), (24, BACKSTOP_Z)]      # foul-territory boundary (right side)
FOUL_R = [POLE_R] + _R
FOUL_L = [(-x, z) for x, z in FOUL_R]
def ground_outline():
    pts = [(-24.0, BACKSTOP_Z), (24.0, BACKSTOP_Z)]
    pts += _R[-2::-1] + [POLE_R]                    # right chain, backstop -> pole
    pts += fence_pts()[1:-1]                        # RF -> LF along the fence
    pts += [POLE_L] + [(-x, z) for x, z in _R[:-1]] # left chain, pole -> backstop
    return pts
CF = 400*FT
C_MOUND = (0.0, 59*FT)
def base_center(which):
    if which == 2: return (0.0, 127.281*FT)
    d = 90*FT; h = 7.5*IN; s = math.sqrt(.5)
    x, z = (d-h)*s, (d-h)*s
    x, z = x - h*s, z + h*s                          # move inward (toward center of the diamond)
    return (x if which == 1 else -x, z)

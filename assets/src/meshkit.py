# Tiny mesh builder working in game coordinates. Requires common.py + geom.py already exec'd.
import bpy, bmesh, math
from mathutils import Vector, geometry

class MB:
    def __init__(self, name, uv_scale=4.0):
        self.name = name; self.v = []; self.f = []; self.uvs = []; self.cols = []; self.uv_scale = uv_scale
    def vert(self, x, y, z, uv=None, col=(1, 1, 1, 1)):
        self.v.append(B(x, y, z)); self.uvs.append(uv if uv else (x/self.uv_scale, z/self.uv_scale)); self.cols.append(col)
        return len(self.v)-1
    def tri(self, a, b, c, up=True):
        va, vb, vc = self.v[a], self.v[b], self.v[c]
        n = (Vector(vb)-Vector(va)).cross(Vector(vc)-Vector(va))
        if up and n.z < 0: b, c = c, b
        self.f.append((a, b, c))
    def quad(self, a, b, c, d):
        self.f.append((a, b, c)); self.f.append((a, c, d))
    def poly(self, pts, y, col=(1, 1, 1, 1), holes=()):
        """Flat horizontal polygon (list of (x,z)) at height y, facing +Y."""
        loops = [pts] + list(holes)
        base = len(self.v)
        vv = [Vector((x, z, 0)) for l in loops for (x, z) in l]
        for l in loops:
            for (x, z) in l: self.vert(x, y, z, col=col)
        idx = geometry.tessellate_polygon([[Vector((x, z, 0)) for (x, z) in l] for l in loops])
        for t in idx: self.tri(base+t[0], base+t[1], base+t[2])
    def strip(self, pts, width, y, col=(1, 1, 1, 1), closed=False):
        """Ribbon of given width centred on a polyline (x,z) at height y."""
        n = len(pts); L, R = [], []
        for i, (x, z) in enumerate(pts):
            p0 = pts[(i-1) % n] if (closed or i > 0) else pts[i]; p1 = pts[(i+1) % n] if (closed or i < n-1) else pts[i]
            dx, dz = p1[0]-p0[0], p1[1]-p0[1]; l = math.hypot(dx, dz) or 1
            nx, nz = -dz/l, dx/l
            L.append(self.vert(x+nx*width/2, y, z+nz*width/2, col=col)); R.append(self.vert(x-nx*width/2, y, z-nz*width/2, col=col))
        for i in range(n-1 + (1 if closed else 0)):
            j = (i+1) % n
            self.tri(L[i], R[i], R[j]); self.tri(L[i], R[j], L[j])
    def box(self, cx, cz, sx, sz, y0, y1, rot=0.0, col=(1, 1, 1, 1), top_uv=None):
        c, s = math.cos(rot), math.sin(rot)
        def P(lx, lz): return (cx+lx*c-lz*s, cz+lx*s+lz*c)
        cs = [P(-sx/2, -sz/2), P(sx/2, -sz/2), P(sx/2, sz/2), P(-sx/2, sz/2)]
        b = [self.vert(x, y0, z, col=col) for x, z in cs]; t = [self.vert(x, y1, z, col=col) for x, z in cs]
        for i in range(4):
            j = (i+1) % 4; self.quad_out(b[i], b[j], t[j], t[i], (cx, (y0+y1)/2, cz))
        self.quad_out(t[0], t[1], t[2], t[3], (cx, y1+1, cz))
    def quad_out(self, a, b, c, d, away_from):
        """Quad wound so its normal points away from a reference (game coords) point."""
        va = Vector(self.v[a]); vb = Vector(self.v[b]); vc = Vector(self.v[c])
        n = (vb-va).cross(vc-va); ctr = (va+vc)/2
        ref = Vector(B(*away_from))
        if n.dot(ctr-ref) < 0: b, d = d, b
        self.f.append((a, b, c)); self.f.append((a, c, d))
    def build(self, mat=None, smooth=False, coll=None):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.v, [], self.f); me.update()
        uv = me.uv_layers.new(name="UVMap")
        for lp in me.loops: uv.data[lp.index].uv = self.uvs[lp.vertex_index]
        ca = me.color_attributes.new("Color", 'FLOAT_COLOR', 'POINT')
        for i, c in enumerate(self.cols): ca.data[i].color = c
        for p in me.polygons: p.use_smooth = smooth
        if mat: me.materials.append(mat)
        o = bpy.data.objects.new(self.name, me); (coll or bpy.context.collection).objects.link(o)
        return o

def clip_poly(poly, nx, nz, d):
    """Sutherland-Hodgman: keep the half-plane nx*x+nz*z >= d."""
    out = []
    for i, p in enumerate(poly):
        q = poly[(i+1) % len(poly)]
        dp = nx*p[0]+nz*p[1]-d; dq = nx*q[0]+nz*q[1]-d
        if dp >= 0: out.append(p)
        if (dp >= 0) != (dq >= 0):
            t = dp/(dp-dq); out.append((p[0]+(q[0]-p[0])*t, p[1]+(q[1]-p[1])*t))
    return out

def bands(poly, ang, width, lo, hi):
    """Yield (index, polygon) slabs of `poly` cut into parallel bands. Band normal at angle ang."""
    nx, nz = math.cos(ang), math.sin(ang); k = 0; d = lo
    while d < hi:
        p = clip_poly(poly, nx, nz, d); p = clip_poly(p, -nx, -nz, -(d+width))
        if len(p) >= 3: yield k, p
        k += 1; d += width

"""Inspect a player GLB without Blender/three.js: clip names + durations, and rest-pose world axes of nodes.
usage: python3 src/glbclips.py players/player_batter.glb [NodeName ...]      (works on plain GLBs; meshopt files need decompressing first)
Prints, per node, the node's local +X/+Y/+Z axes expressed in glTF world space (Y-up, +Z toward center field) at rest, and the head position."""
import json, struct, sys
import numpy as np

def load(path):
    b = open(path, "rb").read()
    jl, _ = struct.unpack_from("<II", b, 12); js = json.loads(b[20:20+jl]); off = 20+jl+8
    return js, b[off:]

def accessor(js, bin_, i):
    a = js["accessors"][i]; bv = js["bufferViews"][a["bufferView"]]
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
    dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5120: np.int8, 5121: np.uint8}[a["componentType"]]
    o = bv.get("byteOffset", 0)+a.get("byteOffset", 0)
    return np.frombuffer(bin_, dt, a["count"]*n, o).reshape(a["count"], n)

def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])

def world_rest(js):
    nodes = js["nodes"]; parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []): parent[c] = i
    cache = {}
    def W(i):
        if i in cache: return cache[i]
        n = nodes[i]; M = np.eye(4)
        if "matrix" in n: M = np.array(n["matrix"]).reshape(4, 4).T
        else:
            M[:3, :3] = quat_to_mat(n.get("rotation", [0, 0, 0, 1])) @ np.diag(n.get("scale", [1, 1, 1])); M[:3, 3] = n.get("translation", [0, 0, 0])
        cache[i] = (W(parent[i]) if i in parent else np.eye(4)) @ M; return cache[i]
    return {n.get("name"): W(i) for i, n in enumerate(nodes)}

def clips(js, bin_):
    out = {}
    for a in js.get("animations", []):
        t = max(float(accessor(js, bin_, s["input"]).max()) for s in a["samplers"]); out[a["name"]] = (t, len(a["channels"]))
    return out

if __name__ == "__main__":
    js, bin_ = load(sys.argv[1])
    for k, (t, nch) in sorted(clips(js, bin_).items()): print(f"{k:16s} {t:6.3f} s  {round(t*24):3d} frames @24  {nch} channels")
    if len(sys.argv) > 2:
        Wm = world_rest(js)
        for nm in sys.argv[2:]:
            M = Wm[nm]; print(nm, "pos", np.round(M[:3, 3], 3), "X", np.round(M[:3, 0], 2), "Y", np.round(M[:3, 1], 2), "Z", np.round(M[:3, 2], 2))

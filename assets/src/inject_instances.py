# Adds EXT_mesh_gpu_instancing to nodes of an existing GLB. usage: inject(glb_path, {node_name: (positions[n,3], yaw[n])})
import json, struct, numpy as np
def inject(path, inst):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20+jl]); off = 20+jl
    bl = struct.unpack('<I', b[off:off+4])[0]; binc = bytearray(b[off+8:off+8+bl])
    def add(arr, typ):
        while len(binc) % 4: binc.append(0)
        o = len(binc); binc.extend(np.ascontiguousarray(arr, np.float32).tobytes())
        j['bufferViews'].append({'buffer': 0, 'byteOffset': o, 'byteLength': arr.size*4})
        j['accessors'].append({'bufferView': len(j['bufferViews'])-1, 'componentType': 5126, 'count': len(arr), 'type': typ})
        return len(j['accessors'])-1
    for node in j['nodes']:
        nm = node.get('name')
        if nm in inst and 'mesh' in node:
            pos, yaw = inst[nm]
            if len(pos) == 0: continue
            q = np.stack([np.zeros_like(yaw), np.sin(yaw/2), np.zeros_like(yaw), np.cos(yaw/2)], 1)
            node.setdefault('extensions', {})['EXT_mesh_gpu_instancing'] = {'attributes': {'TRANSLATION': add(pos, 'VEC3'), 'ROTATION': add(q, 'VEC4')}}
    ext = j.setdefault('extensionsUsed', [])
    if 'EXT_mesh_gpu_instancing' not in ext: ext.append('EXT_mesh_gpu_instancing')
    while len(binc) % 4: binc.append(0)
    j['buffers'][0]['byteLength'] = len(binc)
    js = json.dumps(j, separators=(',', ':')).encode()
    while len(js) % 4: js += b' '
    out = struct.pack('<III', 0x46546C67, 2, 12+8+len(js)+8+len(binc)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binc), 0x004E4942) + bytes(binc)
    open(path, 'wb').write(out)

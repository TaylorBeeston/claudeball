# usage: python3 make_lods.py <stadium.glb> <out.glb>  -- drops instanced seat nodes, light lamp banks and net posts for a far LOD
import json, struct, sys
b = open(sys.argv[1], 'rb').read(); n = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20+n]); rest = b[20+n:]
drop = {i for i, nd in enumerate(j['nodes']) if nd.get('name', '').startswith(('Seats_T', 'NetPosts'))}
for sc in j['scenes']: sc['nodes'] = [i for i in sc['nodes'] if i not in drop]
js = json.dumps(j, separators=(',', ':')).encode(); js += b' '*(-len(js) % 4)
open(sys.argv[2], 'wb').write(struct.pack('<III', 0x46546C67, 2, 20+len(js)+len(rest)) + struct.pack('<II', len(js), 0x4E4F534A) + js + rest)

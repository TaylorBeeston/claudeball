# test helper: copy a GLB without occlusionTexture so Blender's importer (which trips on our minimal "glTF Material Output" group) can load it
import json, struct, sys
b = open(sys.argv[1], 'rb').read(); n = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20+n]); rest = b[20+n:]
for m in j.get('materials', []): m.pop('occlusionTexture', None)
js = json.dumps(j, separators=(',', ':')).encode(); js += b' '*(-len(js) % 4)
open(sys.argv[2], 'wb').write(struct.pack('<III', 0x46546C67, 2, 20+len(js)+len(rest)) + struct.pack('<II', len(js), 0x4E4F534A) + js + rest)

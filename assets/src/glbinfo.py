import json, struct, sys
def info(p):
    b = open(p, 'rb').read(); n = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20+n])
    bb = lambda a: (a['min'], a['max'])
    print(p, len(b)//1024, 'KB', 'meshes', len(j.get('meshes', [])), 'mats', len(j.get('materials', [])), 'images', [(i.get('mimeType'), i.get('bufferView')) for i in j.get('images', [])])
    attrs = set(k for m in j['meshes'] for pr in m['primitives'] for k in pr['attributes']); print(' attrs', attrs)
    tris = 0
    for m in j['meshes']:
        for pr in m['primitives']: tris += j['accessors'][pr['indices']]['count']//3
    print(' tris', tris, 'extensions', j.get('extensionsUsed'), 'anims', [a['name'] for a in j.get('animations', [])])
    return j
if __name__ == '__main__':
    for p in sys.argv[1:]: info(p)

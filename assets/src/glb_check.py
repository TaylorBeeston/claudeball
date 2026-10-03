import json,struct,sys,numpy as np
def load(path):
    b=open(path,'rb').read(); n=struct.unpack('<I',b[12:16])[0]; j=json.loads(b[20:20+n]); off=20+n+8
    bin_=b[off:]
    return j,bin_
def positions(j,bin_,node_name):
    for nd in j['nodes']:
        if nd.get('name')==node_name and 'mesh' in nd:
            m=j['meshes'][nd['mesh']]; out=[]
            for p in m['primitives']:
                a=j['accessors'][p['attributes']['POSITION']]; bv=j['bufferViews'][a['bufferView']]
                o=bv.get('byteOffset',0)+a.get('byteOffset',0); cnt=a['count']; stride=bv.get('byteStride',12)
                arr=np.frombuffer(bin_,dtype=np.uint8,count=cnt*stride,offset=o).reshape(cnt,stride)[:,:12].copy().view('<f4').reshape(cnt,3); out.append(arr)
            return np.concatenate(out)
    return None
if __name__=="__main__":
    j,bn=load(sys.argv[1])
    E=positions(j,bn,'Eyes'); C=positions(j,bn,'Eyes_Cornea'); H=positions(j,bn,'Head')
    for nm,P in (('Eyes',E),('Cornea',C)):
        L=P[P[:,0]>0]; print(nm,'bbox',L.min(0).round(4),L.max(0).round(4))
    # face surface at eye: head verts near x=.032,y(up)=1.724 -> max z (front)
    m=(abs(H[:,0]-.032)<.012)&(abs(H[:,1]-1.724)<.02); print('head front z near eye (max):',H[m][:,2].max().round(4) if m.any() else None, 'n',m.sum())
    m=(abs(H[:,0]-.032)<.03)&(abs(H[:,1]-1.724)<.03); print('head z range around eye:',H[m][:,2].min().round(4),H[m][:,2].max().round(4))

def tris(j,bin_,node_name):
    for nd in j['nodes']:
        if nd.get('name')==node_name and 'mesh' in nd:
            m=j['meshes'][nd['mesh']]; P=[];T=[];base=0
            for p in m['primitives']:
                a=j['accessors'][p['attributes']['POSITION']]; bv=j['bufferViews'][a['bufferView']]
                o=bv.get('byteOffset',0)+a.get('byteOffset',0); cnt=a['count']; stride=bv.get('byteStride',12)
                arr=np.frombuffer(bin_,dtype=np.uint8,count=cnt*stride,offset=o).reshape(cnt,stride)[:,:12].copy().view('<f4').reshape(cnt,3)
                ia=j['accessors'][p['indices']]; ibv=j['bufferViews'][ia['bufferView']]; io=ibv.get('byteOffset',0)+ia.get('byteOffset',0)
                dt={5123:'<u2',5125:'<u4',5121:'u1'}[ia['componentType']]; idx=np.frombuffer(bin_,dtype=dt,count=ia['count'],offset=io).astype(np.int64).reshape(-1,3)+base
                P.append(arr); T.append(idx); base+=cnt
            return np.concatenate(P),np.concatenate(T)
    return None,None
def first_hit_z(P,T,xs,ys,z0=1.0):
    """ray along -z from z0 at each (x,y): max z of intersection (front-most)"""
    A=P[T[:,0]];B=P[T[:,1]];C=P[T[:,2]]; out=np.full(len(xs),-9.0)
    for k,(x,y) in enumerate(zip(xs,ys)):
        # barycentric test in xy
        d=(B[:,1]-C[:,1])*(A[:,0]-C[:,0])+(C[:,0]-B[:,0])*(A[:,1]-C[:,1]); ok=abs(d)>1e-12
        l1=((B[:,1]-C[:,1])*(x-C[:,0])+(C[:,0]-B[:,0])*(y-C[:,1]))/np.where(ok,d,1); l2=((C[:,1]-A[:,1])*(x-C[:,0])+(A[:,0]-C[:,0])*(y-C[:,1]))/np.where(ok,d,1); l3=1-l1-l2
        m=ok&(l1>=0)&(l2>=0)&(l3>=0)
        if m.any(): z=l1[m]*A[m,2]+l2[m]*B[m,2]+l3[m]*C[m,2]; out[k]=z.max()
    return out
def eye_visibility(path):
    j,bn=load(path); res={}
    PH,TH=tris(j,bn,'Head'); PE,TE=tris(j,bn,'Eyes'); PC,TC=tris(j,bn,'Eyes_Cornea')
    gx,gy=np.meshgrid(np.linspace(-.006,.006,5),np.linspace(-.006,.006,5)); xs=(.032+gx).ravel(); ys=(1.732+gy).ravel()
    zh=first_hit_z(PH,TH,xs,ys); ze=first_hit_z(PE,TE,xs,ys); zc=first_hit_z(PC,TC,xs,ys)
    vis=np.maximum(ze,zc)>zh
    return dict(head_z=np.round([zh.min(),zh.max()],4).tolist(),eye_z=np.round([ze.min(),ze.max()],4).tolist(),cornea_z=np.round([zc.min(),zc.max()],4).tolist(),iris_points_visible=f"{int(vis.sum())}/{len(vis)}")

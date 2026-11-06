import {BufferGeometry,BufferAttribute,Vector3,Triangle,Ray,DoubleSide} from 'three';
import {MeshBVH,CENTER} from 'three-mesh-bvh';
import {valueAt} from './bake-packed.js';
export const PROJECTION_CHUNK_TRIANGLES=65536;
const read3=(a,i,v)=>v.set(valueAt(a,i*3),valueAt(a,i*3+1),valueAt(a,i*3+2));
// Raster samples are small and fixed by the selected map size. Only ONE donor
// chunk is expanded / indexed in a BVH at a time. Winner selection spans all chunks.
export function chunkedBakeHits(source,target,{size,distance,epsilon,onProgress=()=>{}}){
 const count=size*size,points=new Float32Array(count*3),normals=new Float32Array(count*3),active=new Uint32Array(count),mask=new Uint8Array(count);
 let activeCount=0;const targetFace=new Int32Array(count);
 function raster(visit){for(let t=0;t<target.indices.length;t+=3){
  const ids=[target.indices[t],target.indices[t+1],target.indices[t+2]],u=ids.map(i=>target.uv[i*2]*size),v=ids.map(i=>target.uv[i*2+1]*size);
  const den=(v[1]-v[2])*(u[0]-u[2])+(u[2]-u[1])*(v[0]-v[2]);if(Math.abs(den)<1e-12)continue;
  const minX=Math.max(0,Math.ceil(Math.min(...u)-.5)),maxX=Math.min(size-1,Math.floor(Math.max(...u)-.5)),minY=Math.max(0,Math.ceil(Math.min(...v)-.5)),maxY=Math.min(size-1,Math.floor(Math.max(...v)-.5));
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
   const a=((v[1]-v[2])*(x+.5-u[2])+(u[2]-u[1])*(y+.5-v[2]))/den,b=((v[2]-v[0])*(x+.5-u[2])+(u[0]-u[2])*(y+.5-v[2]))/den,c=1-a-b;
   if(Math.min(a,b,c)<-1e-7)continue;visit(y*size+x,ids,a,b,c,t/3);
  }
 }}
 function sample(ids,a,b,c,p,n){const cage=target.projectionNormals||target.normals;for(let k=0;k<3;k++){p[k]=target.positions[ids[0]*3+k]*a+target.positions[ids[1]*3+k]*b+target.positions[ids[2]*3+k]*c;n[k]=cage[ids[0]*3+k]*a+cage[ids[1]*3+k]*b+cage[ids[2]*3+k]*c}}
 raster((p,ids,a,b,c,tri)=>{if(mask[p])return;mask[p]=1;active[activeCount++]=p;targetFace[p]=tri;sample(ids,a,b,c,points.subarray(p*3,p*3+3),normals.subarray(p*3,p*3+3))});
 const faces=new Int32Array(count);faces.fill(-1);const hitPoints=new Float32Array(count*3),bestDistance=new Float64Array(count);bestDistance.fill(Infinity);const rank=new Uint8Array(count);
 const chunkSize=Math.min(PROJECTION_CHUNK_TRIANGLES,source.indices.length/3),positions=new Float32Array(chunkSize*9),indices=Uint32Array.from({length:chunkSize*3},(_,i)=>i);
 const geometry=new BufferGeometry().setAttribute('position',new BufferAttribute(positions,3)).setIndex(new BufferAttribute(indices,1));
 const point=new Vector3(),normal=new Vector3(),highN=new Vector3(),a=new Vector3(),b=new Vector3(),c=new Vector3(),w=new Vector3(),ray=new Ray(new Vector3(),new Vector3()),closest={point:new Vector3()};
 function aligned(face,p){
  const ids=[source.indices[face*3],source.indices[face*3+1],source.indices[face*3+2]];
  read3(source.positions,ids[0],a);read3(source.positions,ids[1],b);read3(source.positions,ids[2],c);Triangle.getBarycoord(p,a,b,c,w);
  highN.set(0,0,0);for(let j=0;j<3;j++)for(let k=0;k<3;k++)highN.setComponent(k,highN.getComponent(k)+valueAt(source.normals,ids[j]*3+k)*w.getComponent(j));
  return highN.normalize().dot(normal)>.05;
 }
 function save(p,face,hit,kind,tri){const d=hit.distanceToSquared(point);if(kind<rank[p]||!rank[p]||kind===rank[p]&&d<bestDistance[p]){rank[p]=kind;bestDistance[p]=d;faces[p]=face;targetFace[p]=tri;hitPoints.set([hit.x,hit.y,hit.z],p*3)}}
 const total=source.indices.length/3;
 function visitChunks(alternatives=null){
  for(let start=0;start<total;start+=chunkSize){
   const triangles=Math.min(chunkSize,total-start),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
   for(let i=0;i<triangles*3;i++)for(let k=0;k<3;k++){const x=valueAt(source.positions,source.indices[start*3+i]*3+k);positions[i*3+k]=x;min[k]=Math.min(min[k],x);max[k]=Math.max(max[k],x)}
   geometry.setDrawRange(0,triangles*3);const bvh=new MeshBVH(geometry,{strategy:CENTER,targetLeafSize:16,indirect:true});
   for(let i=0;i<(alternatives?alternatives.length:activeCount);i++){
    const s=alternatives?.[i],p=s?s.pixel:active[i],tri=s?s.tri:targetFace[p];if(s){point.fromArray(s.point);normal.fromArray(s.normal).normalize()}else{read3(points,p,point);read3(normals,p,normal).normalize()}
    if([0,1,2].some(k=>point.getComponent(k)<min[k]-distance||point.getComponent(k)>max[k]+distance))continue;
    for(const direction of [-1,1]){
     ray.direction.copy(normal).multiplyScalar(direction);ray.origin.copy(point).addScaledVector(ray.direction,-epsilon);
     const hit=bvh.raycastFirst(ray,DoubleSide,0,distance+epsilon);
     if(hit&&aligned(start+hit.faceIndex,hit.point))save(p,start+hit.faceIndex,hit.point,1,tri);
    }
    if(rank[p]!==1){const hit=bvh.closestPointToPoint(point,closest,0,distance);if(hit&&hit.distance<=distance&&aligned(start+hit.faceIndex,hit.point))save(p,start+hit.faceIndex,hit.point,2,tri)}
   }
   onProgress(Math.min(1,(start+triangles)/total));
  }
 }
 try{
  visitChunks();const missing=new Set();for(let i=0;i<activeCount;i++)if(faces[active[i]]<0)missing.add(active[i]);
  // A shared UV edge may be covered by two target faces with different normal
  // frames. Retry actual projections for the other face, never fill by colour.
  if(missing.size&&missing.size<=Math.max(1,Math.ceil(activeCount*.005))){
   const alternatives=[];raster((pixel,ids,a,b,c,tri)=>{if(!missing.has(pixel)||tri===targetFace[pixel])return;if(alternatives.length>=8192)throw Error('Слишком много перекрытий UV для экономного переноса');const point=new Float32Array(3),normal=new Float32Array(3);sample(ids,a,b,c,point,normal);alternatives.push({pixel,tri,point,normal})});
   if(alternatives.length)visitChunks(alternatives);
  }
 }finally{geometry.dispose()}
 const hitPoint=new Vector3();return {maxChunkTriangles:chunkSize,matches:(p,tri)=>faces[p]<0||targetFace[p]===tri,hit:p=>faces[p]<0?null:{faceIndex:faces[p],point:read3(hitPoints,p,hitPoint)}};
}

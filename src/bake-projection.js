import {Vector3,Ray,DoubleSide} from 'three';
import {valueAt} from './bake-packed.js';

const read3=(values,i,out)=>out.set(valueAt(values,i*3),valueAt(values,i*3+1),valueAt(values,i*3+2));

export function sampleBakeTarget(target,ids,y,z,point,normal){
 const p=target.positions,n=target.projectionNormals||target.normals,x=1-y-z;
 for(let k=0;k<3;k++){
  const a=p[ids[0]*3+k];point.setComponent(k,a+(p[ids[1]*3+k]-a)*y+(p[ids[2]*3+k]-a)*z);
  normal.setComponent(k,n[ids[0]*3+k]*x+n[ids[1]*3+k]*y+n[ids[2]*3+k]*z);
 }
 if(normal.lengthSq()<1e-20){
  const a=ids[0]*3,b=ids[1]*3,c=ids[2]*3,ux=p[b]-p[a],uy=p[b+1]-p[a+1],uz=p[b+2]-p[a+2],vx=p[c]-p[a],vy=p[c+1]-p[a+1],vz=p[c+2]-p[a+2];
  normal.set(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx);
 }
 normal.normalize();
}

// Dot-product barycentrics subtract nearly equal squared lengths on needle
// faces. Project onto the dominant geometric-normal plane instead, using
// translated edge determinants. This also works with packed donor attributes.
export function surfaceBarycentric(p,a,b,c,out){
 const ab=[b.x-a.x,b.y-a.y,b.z-a.z],ac=[c.x-a.x,c.y-a.y,c.z-a.z],ap=[p.x-a.x,p.y-a.y,p.z-a.z];
 const cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
 let axis=0;for(let k=1;k<3;k++)if(Math.abs(cross[k])>Math.abs(cross[axis]))axis=k;
 const u=(axis+1)%3,v=(axis+2)%3,den=ab[u]*ac[v]-ab[v]*ac[u];
 if(!Number.isFinite(den)||den===0)return false;
 const y=(ap[u]*ac[v]-ap[v]*ac[u])/den,z=(ab[u]*ap[v]-ab[v]*ap[u])/den;
 out.set(1-y-z,y,z);return Number.isFinite(out.x)&&Number.isFinite(out.y)&&Number.isFinite(out.z);
}

// Fast first-hit queries handle ordinary samples. A rejected first face must
// not hide a farther compatible face in the same BVH. Filtered traversals keep
// the original distance and normal limits, with fixed scratch storage.
export function createBakeProjector(source,bvh,{offset=0,distance,epsilon}){
 const a=new Vector3(),b=new Vector3(),c=new Vector3(),weights=new Vector3(),highN=new Vector3();
 const candidate=new Vector3(),boxPoint=new Vector3(),ray=new Ray(new Vector3(),new Vector3()),closest={point:new Vector3()};
 const result={faceIndex:-1,point:new Vector3(),barycentric:new Vector3(),distanceSquared:Infinity,kind:0};
 const limit=distance*distance;
 function aligned(face,p,normal){
  const ids=[source.indices[face*3],source.indices[face*3+1],source.indices[face*3+2]];
  read3(source.positions,ids[0],a);read3(source.positions,ids[1],b);read3(source.positions,ids[2],c);
  if(!surfaceBarycentric(p,a,b,c,weights))return false;
  highN.set(0,0,0);
  for(let j=0;j<3;j++)for(let k=0;k<3;k++)highN.setComponent(k,highN.getComponent(k)+valueAt(source.normals,ids[j]*3+k)*weights.getComponent(j));
  return highN.normalize().dot(normal)>.05;
 }
 function save(face,p,point,kind){
  const d=p.distanceToSquared(point);
  if(d<=limit&&(!result.kind||kind<result.kind||kind===result.kind&&d<result.distanceSquared)){
   result.faceIndex=face;result.point.copy(p);result.barycentric.copy(weights);result.distanceSquared=d;result.kind=kind;
  }
 }
 return {project(point,normal){
  result.kind=0;result.faceIndex=-1;result.distanceSquared=Infinity;
  if(normal.lengthSq()<1e-20)return null;
  for(const direction of [-1,1]){
   ray.direction.copy(normal).multiplyScalar(direction);ray.origin.copy(point).addScaledVector(ray.direction,-epsilon);
   const hit=bvh.raycastFirst(ray,DoubleSide,0,distance+epsilon);
   if(hit&&aligned(offset+hit.faceIndex,hit.point,normal)){save(offset+hit.faceIndex,hit.point,point,1);continue}
   if(!hit)continue;
   bvh.shapecast({
    boundsTraverseOrder:box=>boxPoint.copy(point).clamp(box.min,box.max).distanceToSquared(point),
    intersectsBounds:(box,_leaf,score)=>score<=Math.min(limit,result.distanceSquared)&&ray.intersectsBox(box),
    intersectsTriangle:(tri,index)=>{
     const p=ray.intersectTriangle(tri.a,tri.b,tri.c,false,candidate);
     if(p&&aligned(offset+index,p,normal))save(offset+index,p,point,1);return false;
    }
   });
  }
  if(result.kind)return result;
  const nearest=bvh.closestPointToPoint(point,closest,0,distance);
  if(nearest&&aligned(offset+nearest.faceIndex,nearest.point,normal)){save(offset+nearest.faceIndex,nearest.point,point,2);if(result.kind)return result}
  // Searching only the geometric nearest point repeats the same first-face
  // rejection. Find the nearest point among compatible faces inside the cage.
  bvh.shapecast({
   boundsTraverseOrder:box=>boxPoint.copy(point).clamp(box.min,box.max).distanceToSquared(point),
   intersectsBounds:(_box,_leaf,score)=>score<=Math.min(limit,result.distanceSquared),
   intersectsTriangle:(tri,index)=>{
    tri.closestPointToPoint(point,candidate);
    if(candidate.distanceToSquared(point)<=Math.min(limit,result.distanceSquared)&&aligned(offset+index,candidate,normal))save(offset+index,candidate,point,2);
    return false;
   }
  });
  return result.kind?result:null;
 }};
}

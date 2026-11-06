import {Accessor} from '@gltf-transform/core';
import {weldPrimitive,compactPrimitive} from '@gltf-transform/functions';
import {MeshoptSimplifier} from 'meshoptimizer';
import {packedValues,valueAt,positionBounds} from './bake-packed.js';

export const BAKE_CHUNK_TRIANGLES=131072;
// Spatial median partition: only one Uint32 per original triangle, no centroid table.
export function triangleChunks(indices,positions,{maxTriangles=BAKE_CHUNK_TRIANGLES}={}){
 if(!Number.isInteger(maxTriangles)||maxTriangles<32||maxTriangles>BAKE_CHUNK_TRIANGLES)throw Error('Неверный размер части');
 const order=Uint32Array.from({length:indices.length/3},(_,i)=>i),bounds=positionBounds(positions),chunks=[];
 const center=(t,k)=>(valueAt(positions,indices[t*3]*3+k)+valueAt(positions,indices[t*3+1]*3+k)+valueAt(positions,indices[t*3+2]*3+k))/3;
 function split(start,end,min,max){
  if(end-start<=maxTriangles){chunks.push({start,end});return}
  const axis=max.map((v,k)=>v-min[k]).reduce((best,v,k,a)=>v>a[best]?k:best,0),middle=(start+end)>>>1;
  let lo=start,hi=end;
  while(hi-lo>1){
   const pivot=center(order[(lo+hi)>>>1],axis);let a=lo,b=lo,c=hi;
   while(b<c){const v=center(order[b],axis);if(v<pivot){const t=order[a];order[a++]=order[b];order[b++]=t}else if(v>pivot){const t=order[--c];order[c]=order[b];order[b]=t}else b++}
   if(middle<a)hi=a;else if(middle>=c)lo=c;else break;
  }
  const cut=center(order[middle],axis),left=max.slice(),right=min.slice();left[axis]=cut;right[axis]=cut;
  split(start,middle,min,left);split(middle,end,right,max);
 }
 split(0,order.length,bounds.min,bounds.max);return {order,chunks,bounds,maxTriangles};
}

export async function simplifyBakeChunks(document,prim,{ratio,error,regularize=false,maxTriangles=BAKE_CHUNK_TRIANGLES,onProgress=()=>{}}){
 await MeshoptSimplifier.ready;
 const positions=packedValues(prim.getAttribute('POSITION')),indices=prim.getIndices()?.getArray()||Uint32Array.from({length:positions.length/3},(_,i)=>i);
 const partition=triangleChunks(indices,positions,{maxTriangles}),remap=new Uint32Array(positions.length/3),parts=[];
 const buffer=document.getRoot().listBuffers()[0]||document.createBuffer();let totalTriangles=0,totalVertices=0;
 for(let part=0;part<partition.chunks.length;part++){
  const {start,end}=partition.chunks[part],capacity=(end-start)*3,local=new Uint32Array(capacity),touched=new Uint32Array(capacity),coords=new Float32Array(capacity*3);let count=0;
  for(let i=start;i<end;i++)for(let c=0;c<3;c++){
   const old=indices[partition.order[i]*3+c];if(old>=remap.length)throw Error('Индекс вне сетки');let next=remap[old];
   if(!next){next=++count;remap[old]=next;touched[next-1]=old;for(let k=0;k<3;k++)coords[(next-1)*3+k]=valueAt(positions,old*3+k)}
   local[(i-start)*3+c]=next-1;
  }
  const temp=document.createPrimitive().setAttribute('POSITION',document.createAccessor().setBuffer(buffer).setType(Accessor.Type.VEC3).setArray(coords.subarray(0,count*3)))
   .setIndices(document.createAccessor().setBuffer(buffer).setType(Accessor.Type.SCALAR).setArray(local));
  try{
   weldPrimitive(temp);const p=temp.getAttribute('POSITION'),idx=temp.getIndices(),input=idx.getArray(),scale=positionBounds(p.getArray()).extent;
   const localError=scale>0?Math.min(1,error*partition.bounds.extent/scale):error,target=Math.max(3,Math.floor(input.length*ratio/3)*3);
   const [out,actual]=MeshoptSimplifier.simplify(input instanceof Uint32Array?input:new Uint32Array(input),p.getArray(),3,target,localError,regularize?['LockBorder','Regularize']:['LockBorder']);
   if(!out.length||!Number.isFinite(actual)||actual*scale>error*partition.bounds.extent+1e-6)throw Error('Не соблюдена погрешность части');
   idx.setArray(out);compactPrimitive(temp);
   const xyz=temp.getAttribute('POSITION').getArray(),ix=temp.getIndices().getArray();totalTriangles+=ix.length/3;totalVertices+=xyz.length/3;
   if(totalTriangles>200000)throw Error('Для переноса остаётся больше 200 тысяч треугольников. Выбери большее допустимое упрощение.');
   parts.push({positions:xyz,indices:ix});
  }finally{
   const attrs=temp.listAttributes(),idx=temp.getIndices();temp.dispose();for(const a of [...attrs,idx])if(a&&a.listParents().length===1)a.dispose();
   for(let i=0;i<count;i++)remap[touched[i]]=0;
  }
  onProgress((part+1)/partition.chunks.length,{chunks:partition.chunks.length,maxTriangles});
 }
 const xyz=new Float32Array(totalVertices*3),ix=new Uint32Array(totalTriangles*3);let v=0,t=0;
 for(const part of parts){xyz.set(part.positions,v*3);for(const i of part.indices)ix[t++]=i+v;v+=part.positions.length/3}
 for(const semantic of prim.listSemantics())prim.setAttribute(semantic,null);
 prim.setAttribute('POSITION',document.createAccessor().setBuffer(buffer).setType(Accessor.Type.VEC3).setArray(xyz))
  .setIndices(document.createAccessor().setBuffer(buffer).setType(Accessor.Type.SCALAR).setArray(ix));
 // Reunite unchanged patch boundaries before computing smooth normals / UV.
 weldPrimitive(prim);return {chunks:partition.chunks.length,maxTriangles};
}

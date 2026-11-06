import {readBakeGlb,bakePrimitives} from './bake-common.js';
import {unwrapBakePrimitive,finishBakePrimitive} from './bake-geometry.js';
import {countTriangles} from './glb-optimize.js';
import {prune} from '@gltf-transform/functions';
import {PropertyType} from '@gltf-transform/core';
import {checkBakeMemory} from './bake-memory.js';
import {unwrapBakeChunks,BAKE_UV_CHUNK_TRIANGLES} from './bake-uv-chunks.js';
export function unwrapMemoryBytes(prepared){
 const triangles=prepared.optimizedTriangles;
 // Include corner attributes, the UV-only global packer and allocator slack.
 // Only the 3D chart solver is bounded to a 16K patch. The remaining work and
 // its guard still grow with total output size; this is not a fixed RAM promise.
 return prepared.bytes.byteLength*2+(prepared.geometryOnly&&triangles>BAKE_UV_CHUNK_TRIANGLES
  ?160*1048576+triangles*800+BAKE_UV_CHUNK_TRIANGLES*1800
  :96*1048576+triangles*1800);
}
// The original mesh and the simplifier's grown WASM heap are absent here.
export async function unwrapPreparedBake(prepared,options={}){
 if(options.memoryBudgetMiB!==undefined){
  try{checkBakeMemory({geometryBytes:unwrapMemoryBytes(prepared),memoryBudgetMiB:options.memoryBudgetMiB})}
  catch(e){e.message='UV-развёртка: '+e.message;throw e}
 }
 const {io,document}=await readBakeGlb(prepared.bytes),parts=bakePrimitives(document),progress=options.onProgress||(()=>{});
 for(let i=0;i<parts.length;i++){
  const unwrap=prepared.geometryOnly&&parts[i].getIndices().getCount()/3>BAKE_UV_CHUNK_TRIANGLES?unwrapBakeChunks:unwrapBakePrimitive;
  await unwrap(document,parts[i],prepared.resolution,(_category,p)=>progress(5+85*(i+p/100)/parts.length,'UV-развёртка части '+(i+1)+'/'+parts.length+': '+Math.round(p)+'%'));
  finishBakePrimitive(parts[i],unwrap===unwrapBakeChunks);
 }
 if(countTriangles(document)!==prepared.optimizedTriangles)throw Error('UV-развёртка изменила число треугольников');
 await document.transform(prune({propertyTypes:[PropertyType.ACCESSOR],keepAttributes:true,keepExtras:true}));
 return {...prepared,bytes:await io.writeBinary(document),geometryOnly:false};
}

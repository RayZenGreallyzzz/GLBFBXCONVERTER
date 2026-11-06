import {readBakeGlb,bakePrimitives} from './bake-common.js';
import {unwrapBakePrimitive,finishBakePrimitive} from './bake-geometry.js';
import {countTriangles} from './glb-optimize.js';
import {prune} from '@gltf-transform/functions';
import {PropertyType} from '@gltf-transform/core';
import {checkBakeMemory} from './bake-memory.js';
// The original mesh and the simplifier's grown WASM heap are absent here.
export async function unwrapPreparedBake(prepared,options={}){
 if(options.memoryBudgetMiB!==undefined)checkBakeMemory({geometryBytes:prepared.bytes.byteLength*2+prepared.optimizedTriangles*1800+96*1048576,memoryBudgetMiB:options.memoryBudgetMiB});
 const {io,document}=await readBakeGlb(prepared.bytes),parts=bakePrimitives(document),progress=options.onProgress||(()=>{});
 for(let i=0;i<parts.length;i++){
  await unwrapBakePrimitive(document,parts[i],prepared.resolution,(_category,p)=>progress(5+85*(i+p/100)/parts.length,'UV-развёртка части '+(i+1)+'/'+parts.length+': '+p+'%'));
  finishBakePrimitive(parts[i]);
 }
 if(countTriangles(document)!==prepared.optimizedTriangles)throw Error('UV-развёртка изменила число треугольников');
 await document.transform(prune({propertyTypes:[PropertyType.ACCESSOR],keepAttributes:true,keepExtras:true}));
 return {...prepared,bytes:await io.writeBinary(document),geometryOnly:false};
}

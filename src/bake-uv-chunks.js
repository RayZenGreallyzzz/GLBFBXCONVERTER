import {triangleChunks} from './bake-chunks.js';
import {primitiveGeometry,getBakeAtlasModule,writeBakeAtlas} from './bake-geometry.js';

export const BAKE_UV_CHUNK_TRIANGLES=16384;
function uvError(message){return Object.assign(new Error(message),{code:'BAKE_UV'})}
function checkAtlas(atlas){
 if(atlas.atlasCount!==1||!atlas.width||!atlas.height)throw uvError('Сетка не помещается в одну текстуру');
}

// Solve 3D charts only for small spatial patches. Repack their UV charts into
// one atlas, with the same world-space texel density across every patch.
export async function unwrapBakeChunks(document,prim,resolution,onProgress=()=>{}){
 const data=primitiveGeometry(prim),geo=data.geometry,module=await getBakeAtlasModule(),combined=module.createAtlas();
 try{
  geo.computeVertexNormals();const normals=geo.attributes.normal.array;
  const plan=triangleChunks(data.indices,data.positions,{maxTriangles:BAKE_UV_CHUNK_TRIANGLES}),{bounds}=plan;
  // Power-of-two scaling preserves Float32 significands. An arbitrary factor
  // rounded valid near-collinear simplifier faces into zero-area triangles.
  const center=bounds.min.map((v,k)=>(v+bounds.max[k])/2),scale=2**Math.round(Math.log2(1000/bounds.extent));
  const remap=new Uint32Array(data.positions.length/3),references=[];
  for(let part=0;part<plan.chunks.length;part++){
   const {start,end}=plan.chunks[part],capacity=(end-start)*3,indices=new Uint32Array(capacity),touched=new Uint32Array(capacity),positions=new Float32Array(capacity*3),n=new Float32Array(capacity*3);let count=0;
   for(let i=start;i<end;i++)for(let c=0;c<3;c++){
    const old=data.indices[plan.order[i]*3+c];let next=remap[old];
    if(!next){next=++count;remap[old]=next;touched[next-1]=old;for(let k=0;k<3;k++){positions[(next-1)*3+k]=(data.positions[old*3+k]-center[k])*scale;n[(next-1)*3+k]=normals[old*3+k]}}
    indices[(i-start)*3+c]=next-1;
   }
   const local=module.createAtlas();
   try{
    const error=local.addMesh({positions:positions.subarray(0,count*3),normals:n.subarray(0,count*3),indices});
    if(error)throw uvError('Ошибка UV-развёртки: '+module.addMeshErrorString(error));
    local.generate({maxIterations:1},{resolution:1024,padding:1,bilinear:true});checkAtlas(local);
    const mesh=local.getMesh(0),density=local.texelsPerUnit;
    if(mesh.indices.length!==capacity||!(density>0))throw uvError('UV-развёртка потеряла часть поверхности');
    const uvs=new Float32Array(mesh.vertexCount*2),xref=new Uint32Array(mesh.vertexCount),materials=new Uint32Array(capacity/3),origins=new Map();
    for(let i=0;i<mesh.vertices.length;i++){
     const v=mesh.vertices[i];
     if(v.atlasIndex!==0||v.chartIndex<0||v.xref>=count)throw uvError('Не удалось развернуть часть поверхности');
     // A translation per chart removes irrelevant local packing offsets and
     // improves Float32 precision before the global UV-only repack.
     if(!origins.has(v.chartIndex))origins.set(v.chartIndex,v.uv);
     const origin=origins.get(v.chartIndex);
     uvs[i*2]=(v.uv[0]-origin[0])/density;uvs[i*2+1]=(v.uv[1]-origin[1])/density;xref[i]=touched[v.xref];
    }
    for(let i=0;i<capacity;i+=3){
     const chart=mesh.vertices[mesh.indices[i]].chartIndex;
     if(mesh.vertices[mesh.indices[i+1]].chartIndex!==chart||mesh.vertices[mesh.indices[i+2]].chartIndex!==chart)throw uvError('Грань пересекает UV-шов');
     materials[i/3]=chart;
    }
    const repackError=combined.addUvMesh({uvs,indices:mesh.indices,faceMaterialData:materials});
    if(repackError)throw uvError('Ошибка упаковки UV: '+module.addMeshErrorString(repackError));
    references.push(xref);
   }finally{local.destroy();for(let i=0;i<count;i++)remap[touched[i]]=0}
   onProgress(0,70*(part+1)/plan.chunks.length);
  }
  const margin=Math.max(4,Math.round(resolution/128));
  let packedProgress=70;
  combined.setProgressCallback((_category,p)=>{packedProgress=Math.max(packedProgress,70+p*.25);onProgress(0,packedProgress);return true});
  combined.generate({maxIterations:1},{resolution,padding:margin*2,bilinear:true,blockAlign:true});checkAtlas(combined);
  if(combined.meshCount!==references.length)throw uvError('Неполная упаковка UV');
  const oldVertices=new Uint32Array(data.indices.length),uv=new Float32Array(data.indices.length*2),uvScale=1-2*margin/resolution;let corner=0;
  for(let part=0;part<references.length;part++){
   const mesh=combined.getMesh(part),xref=references[part];
   for(const index of mesh.indices){
    const v=mesh.vertices[index];if(corner>=oldVertices.length||v.atlasIndex!==0||v.xref>=xref.length)throw uvError('Повреждена карта упаковки UV');
    oldVertices[corner]=xref[v.xref];uv[corner*2]=margin/resolution+v.uv[0]/combined.width*uvScale;uv[corner*2+1]=margin/resolution+v.uv[1]/combined.height*uvScale;corner++;
   }
  }
  if(corner!==oldVertices.length)throw uvError('UV-развёртка изменила число треугольников');
  // Free chart-solver/packer allocations before expanding corner attributes.
  combined.destroy();
  const result=await writeBakeAtlas(document,prim,resolution,data,normals,oldVertices,uv);onProgress(0,100);return result;
 }finally{combined.destroy();geo.dispose()}
}

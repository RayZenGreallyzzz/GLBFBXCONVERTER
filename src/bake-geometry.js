import {BufferGeometry,BufferAttribute} from 'three';
import {Accessor} from '@gltf-transform/core';
import {weldPrimitive,compactPrimitive} from '@gltf-transform/functions';
import {MeshoptSimplifier} from 'meshoptimizer';
import createXAtlas from 'xatlas-wasm';
import * as Mikk from 'three/examples/jsm/libs/mikktspace.module.js';
import {attributeValues} from './static-simplify.js';
let atlasModule;
const finite=a=>{for(const x of a)if(!Number.isFinite(x))throw Error('В сетке есть нечисловые значения');return a};
export function primitiveGeometry(prim){
 const p=prim.getAttribute('POSITION');
 if(!p||p.getType()!=='VEC3'||prim.getMode()!==4||prim.listTargets().length)
  throw Error('Перенос поддерживает треугольные сетки без Morph Targets');
 const positions=finite(attributeValues(p));
 const indices=prim.getIndices()?.getArray()||Uint32Array.from({length:p.getCount()},(_,i)=>i);
 if(!indices.length||indices.length%3)throw Error('Неверные индексы сетки');
 for(const i of indices)if(i>=p.getCount())throw Error('Индекс вершины вне сетки');
 const geo=new BufferGeometry().setAttribute('position',new BufferAttribute(positions,3));geo.setIndex(new BufferAttribute(indices,1));
 let normals=prim.getAttribute('NORMAL')?attributeValues(prim.getAttribute('NORMAL')):null;
 if(!normals){geo.computeVertexNormals();normals=geo.attributes.normal.array;}
 if(normals.length!==positions.length)throw Error('Неверные нормали сетки');
 const uv={};for(const name of prim.listSemantics())if(/^TEXCOORD_\d+$/.test(name))uv[Number(name.slice(9))]=finite(attributeValues(prim.getAttribute(name)));
 return {geometry:geo,positions,normals:finite(normals),indices,uv,
  tangents:prim.getAttribute('TANGENT')?attributeValues(prim.getAttribute('TANGENT')):null,
  colors:prim.getAttribute('COLOR_0')?attributeValues(prim.getAttribute('COLOR_0')):null,colorSize:prim.getAttribute('COLOR_0')?.getElementSize()||0};
}
export async function simplifyBakeStatic(document,prim,{ratio,error,regularize=false}){
 await MeshoptSimplifier.ready;
 const buffer=document.getRoot().listBuffers()[0]||document.createBuffer();
 const temp=document.createPrimitive().setAttribute('POSITION',document.createAccessor().setBuffer(buffer).setType(Accessor.Type.VEC3).setArray(attributeValues(prim.getAttribute('POSITION'))));
 if(prim.getIndices())temp.setIndices(prim.getIndices().clone());weldPrimitive(temp);
 const p=temp.getAttribute('POSITION'),idx=temp.getIndices(),source=idx.getArray();
 const target=Math.max(3,Math.floor(source.length*ratio/3)*3);let result=source;
 if(target<source.length){
  const [reduced,actualError]=MeshoptSimplifier.simplify(new Uint32Array(source),p.getArray(),3,target,error,regularize?['LockBorder','Regularize']:['LockBorder']);
  if(!reduced.length||reduced.length%3||!Number.isFinite(actualError)||actualError>error+1e-6)throw Error('Не удалось соблюсти погрешность формы');result=reduced;
 }
 temp.setIndices(idx.clone().setArray(result));compactPrimitive(temp);
 for(const semantic of prim.listSemantics())prim.setAttribute(semantic,null);
 prim.setAttribute('POSITION',temp.getAttribute('POSITION')).setIndices(temp.getIndices());temp.dispose();
}
export function removeBakeDegenerates(prim){
 const p=attributeValues(prim.getAttribute('POSITION')),source=prim.getIndices().getArray(),out=[];
 for(let i=0;i<source.length;i+=3){
  const a=source[i]*3,b=source[i+1]*3,c=source[i+2]*3;
  const ux=p[b]-p[a],uy=p[b+1]-p[a+1],uz=p[b+2]-p[a+2],vx=p[c]-p[a],vy=p[c+1]-p[a+1],vz=p[c+2]-p[a+2];
  const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;
  if(x*x+y*y+z*z>0)out.push(source[i],source[i+1],source[i+2]);
 }
 if(!out.length)throw Error('После очистки вырожденных треугольников не осталось поверхности');
 if(out.length<source.length){prim.setIndices(prim.getIndices().clone().setArray(new Uint32Array(out)));compactPrimitive(prim);}
 return (source.length-out.length)/3;
}
export async function unwrapBakePrimitive(document,prim,resolution,onProgress=()=>{}){
 atlasModule ||= createXAtlas();const module=await atlasModule,atlas=module.createAtlas();
 const buffer=document.getRoot().listBuffers()[0]||document.createBuffer(),data=primitiveGeometry(prim);
 const normalGeo=data.geometry;normalGeo.computeVertexNormals();const normals=normalGeo.attributes.normal.array;
 normalGeo.computeBoundingBox();const bounds=normalGeo.boundingBox,extent=Math.max(bounds.max.x-bounds.min.x,bounds.max.y-bounds.min.y,bounds.max.z-bounds.min.z);
 const center=[(bounds.min.x+bounds.max.x)/2,(bounds.min.y+bounds.max.y)/2,(bounds.min.z+bounds.max.z)/2];
 const atlasPositions=Float32Array.from(data.positions,(v,i)=>(v-center[i%3])/extent);
 const attributes=prim.listSemantics().filter(s=>!['NORMAL','TANGENT','COLOR_0'].includes(s)&&!s.startsWith('TEXCOORD_')).map(s=>({semantic:s,accessor:prim.getAttribute(s),size:prim.getAttribute(s).getElementSize()}));
 const margin=Math.max(4,Math.round(resolution/128));
 try{
  atlas.setProgressCallback((category,percent)=>{onProgress(category,percent);return true});
  const err=atlas.addMesh({positions:atlasPositions,normals,indices:new Uint32Array(data.indices)});
  if(err)throw Error('Ошибка UV-развёртки: '+module.addMeshErrorString(err));
  atlas.generate({maxIterations:1},{resolution,padding:margin*2,bilinear:true,blockAlign:true});
  if(atlas.atlasCount!==1||!atlas.width||!atlas.height)throw Error('Сетка не помещается в одну текстуру');
  const mesh=atlas.getMesh(0),count=mesh.indices.length;if(!count||count%3)throw Error('UV-развёртка вернула пустую сетку');
  const uv=new Float32Array(count*2),n=new Float32Array(count*3),position=new Float32Array(count*3),oldVertices=new Uint32Array(count),scale=1-2*margin/resolution;
  for(let c=0;c<count;c++){
   const v=mesh.vertices[mesh.indices[c]],old=v.xref;
   if(v.atlasIndex!==0){const e=new Error('Не удалось развернуть часть поверхности. Выбери более точное сохранение формы.');e.code='BAKE_UV';throw e;}
   if(old>=data.positions.length/3)throw Error('Повреждена карта соответствия UV');oldVertices[c]=old;
   for(let k=0;k<3;k++){position[c*3+k]=data.positions[old*3+k];n[c*3+k]=normals[old*3+k];}
   uv[c*2]=margin/resolution+v.uv[0]/atlas.width*scale;uv[c*2+1]=margin/resolution+v.uv[1]/atlas.height*scale;
  }
  for(let i=0;i<count;i+=3){
   const a=i*2,b=a+2,c=a+4,area=(uv[b]-uv[a])*(uv[c+1]-uv[a+1])-(uv[b+1]-uv[a+1])*(uv[c]-uv[a]);
   if(!Number.isFinite(area)||Math.abs(area)<1e-16){const e=new Error('В UV-развёртке есть треугольник нулевой площади. Выбери более точное сохранение формы.');e.code='BAKE_UV';throw e;}
  }
  await Mikk.ready;const tangents=Mikk.generateTangents(position,n,uv);
  for(let i=0;i<count;i++){
   tangents[i*4+3]*=-1;
   const values=tangents.subarray(i*4,i*4+4),length=Math.hypot(values[0],values[1],values[2]);
   if(!values.every(Number.isFinite)||Math.abs(length-1)>1e-4||Math.abs(values[3])!==1){
    const e=new Error('Не удалось построить корректные касательные. Выбери более точное сохранение формы.');e.code='BAKE_FRAME';throw e;
   }
  }
  const result={positions:position,normals:n,uv,tangents,indices:Uint32Array.from({length:count},(_,i)=>i),margin};
  for(const name of prim.listSemantics())prim.setAttribute(name,null);
  const set=(name,array,type)=>prim.setAttribute(name,document.createAccessor().setBuffer(buffer).setType(type).setArray(array));
  set('POSITION',position,Accessor.Type.VEC3);set('NORMAL',n,Accessor.Type.VEC3);set('TEXCOORD_0',uv,Accessor.Type.VEC2);set('TANGENT',tangents,Accessor.Type.VEC4);
  for(const {semantic,accessor,size}of attributes){
   if(semantic==='POSITION')continue;const source=accessor.getArray(),array=new source.constructor(count*size);
   for(let i=0;i<count;i++)for(let k=0;k<size;k++)array[i*size+k]=source[oldVertices[i]*size+k];prim.setAttribute(semantic,accessor.clone().setArray(array));
  }
  prim.setIndices(document.createAccessor().setBuffer(buffer).setType(Accessor.Type.SCALAR).setArray(result.indices));return result;
 }finally{atlas.destroy();normalGeo.dispose()}
}
export function finishBakePrimitive(prim){weldPrimitive(prim);compactPrimitive(prim)}

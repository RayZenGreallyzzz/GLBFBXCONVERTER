// Attribute-aware simplification. Original vertex tuples remain unchanged;
// normals, UV scale and tangent discontinuities also influence collapse cost.
import {compactPrimitive,weldPrimitive} from '@gltf-transform/functions';
import {MeshoptSimplifier} from 'meshoptimizer';
import {morphLocks} from './morph-policy.js';

export function attributeValues(accessor){
 if(!accessor)return null;
 const data=accessor.getArray();if(!data)return null;
 if(data instanceof Float32Array)return data;
 if(!accessor.getNormalized())return Float32Array.from(data);
 const max={5120:127,5121:255,5122:32767,5123:65535,5125:4294967295}[accessor.getComponentType()];
 if(!max)throw Error('Неподдерживаемый формат атрибута');
 return Float32Array.from(data,x=>Math.max(-1,x/max));
}
export function uvScales(material,texCoord=0){
 const scales=[1,1];
 for(const name of ['BaseColor','Normal','MetallicRoughness','Occlusion','Emissive']){
  const info=material?.['get'+name+'TextureInfo']?.();
  if(!info)continue;
  const transform=info.getExtension('KHR_texture_transform');
  const coord=transform?.getTexCoord()??info.getTexCoord();
  if(coord!==texCoord)continue;
  const scale=transform?.getScale()||[1,1];
  for(let i=0;i<2;i++)scales[i]=Math.max(scales[i],Math.abs(scale[i]));
 }
 return scales;
}
export async function simplifyStaticMeshes(document,{ratio,error=.003,onlyPrimitive=null}={}){
 await MeshoptSimplifier.ready;
 const skinned=new Set(document.getRoot().listNodes().filter(n=>n.getSkin()).map(n=>n.getMesh()));
 const stats={reduced:0,skipped:0,error:0};
 for(const mesh of document.getRoot().listMeshes()){
  if(skinned.has(mesh))continue;
  for(const prim of mesh.listPrimitives()){
   if(onlyPrimitive&&prim!==onlyPrimitive)continue;
   if(prim.getMode()!==4){stats.skipped++;continue;}
   weldPrimitive(prim);
   const pos=prim.getAttribute('POSITION'),count=pos?.getCount();
   if(!count||!prim.getIndices())throw Error('Нет индексированной геометрии для упрощения');
   const source=prim.getIndices().getArray();
   if(source.length%3)throw Error('Повреждены индексы треугольников');
   const target=Math.max(3,Math.floor(source.length*ratio/3)*3);
   if(target>=source.length)continue;
   const channels=[];
   for(const semantic of prim.listSemantics()){
    if(!['NORMAL','TANGENT','COLOR_0'].includes(semantic)&&!/^TEXCOORD_\d+$/.test(semantic))continue;
    const a=prim.getAttribute(semantic),size=a.getElementSize();
    if(a.getCount()!==count)throw Error('Не совпадает количество вершин и атрибутов');
    const weights=new Array(size).fill(semantic==='NORMAL'?1.25:semantic==='TANGENT'?1.5:1);
    if(semantic.startsWith('TEXCOORD_')){
     const scale=uvScales(prim.getMaterial(),Number(semantic.split('_')[1]));
     for(let k=0;k<size;k++)weights[k]=2*scale[k];
    }
    channels.push({values:attributeValues(a),size,weights});
   }
   let stride=channels.reduce((n,c)=>n+c.size,0),weights=channels.flatMap(c=>c.weights);
   const locks=prim.listTargets().length?morphLocks(prim):new Uint8Array(count);
   if(!stride&&prim.listTargets().length){stride=1;weights=[0]}
   const attrs=new Float32Array(count*stride);
   for(let i=0;i<count;i++){
    let offset=i*stride;
    for(const c of channels)for(let k=0;k<c.size;k++)attrs[offset++]=c.values[i*c.size+k];
   }
   const positions=attributeValues(pos);
   if(positions.some(x=>!Number.isFinite(x)))throw Error('Некорректные координаты вершин');
   const indices=source instanceof Uint32Array?source:new Uint32Array(source);
   const [result,actualError]=stride?MeshoptSimplifier.simplifyWithAttributes(
    indices,positions,3,attrs,stride,weights,locks,target,error,['LockBorder'])
    :MeshoptSimplifier.simplify(indices,positions,3,target,error,['LockBorder']);
   if(!result.length||result.length%3||result.length>source.length||
    !Number.isFinite(actualError)||actualError>error+1e-6)
    throw Error('Результат не прошёл проверку погрешности сетки');
   for(const index of result)if(index>=count)throw Error('Индекс вне границ сетки');
   stats.error=Math.max(stats.error,actualError);
   if(result.length<source.length){
    prim.setIndices(prim.getIndices().clone().setArray(result));
    compactPrimitive(prim);stats.reduced++;
   }
  }
 }
 return stats;
}

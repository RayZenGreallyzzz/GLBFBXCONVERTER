import {Accessor} from '@gltf-transform/core';
import {resample} from '@gltf-transform/functions';
export const MORPH_ID='_PHOENIX_MORPH_ID';
export const MAX_MORPH_TARGETS=64,MAX_MORPH_BYTES=96*1048576;
const allowed=new Set(['POSITION','NORMAL','TANGENT']);
const equal=(a,b,label)=>{if(a.length!==b.length||a.some((v,i)=>v!==b[i]))throw Error('Изменились '+label)};
const maximum={5120:127,5121:255,5122:32767,5123:65535};
export function morphValue(a,i){const v=a.getArray()[i];return a.getNormalized()?Math.max(-1,v/maximum[a.getComponentType()]):v}
// Sparse accessors still expand to their declared count in IO and the renderer.
export function inspectMorphJson(json){
 let bytes=0,targets=0,maxStride=0,triangles=0,animationBytes=0;
 for(const m of json.meshes||[]){
  const count=m.primitives?.[0]?.targets?.length||0;
  if(count>MAX_MORPH_TARGETS)throw Error('Поддерживается до 64 Blend Shapes на меш');
  if(m.weights&&(m.weights.length!==count||m.weights.some(v=>!Number.isFinite(v))))throw Error('Повреждены начальные веса Blend Shapes');
  if(m.extras?.targetNames&&(!Array.isArray(m.extras.targetNames)||m.extras.targetNames.length!==count||m.extras.targetNames.some(n=>typeof n!=='string')))throw Error('Повреждены названия Blend Shapes');
  for(const p of m.primitives||[]){
   if((p.targets?.length||0)!==count)throw Error('Части меша имеют разное число Blend Shapes');
   const vertices=json.accessors?.[p.attributes?.POSITION]?.count||0;let stride=0;
   if(count)triangles+=(p.indices===undefined?vertices:json.accessors?.[p.indices]?.count||0)/3;
   for(const t of p.targets||[])for(const [semantic,index]of Object.entries(t)){
    const a=json.accessors?.[index];
    if(!allowed.has(semantic))throw Error('Этот канал Blend Shapes пока не поддерживается: '+semantic);
    if(!a||a.type!=='VEC3'||a.count!==vertices||p.attributes?.[semantic]===undefined||!Number.isSafeInteger(a.count)||a.count<1)throw Error('Повреждён атрибут Blend Shapes: '+semantic);
    bytes+=a.count*12;stride+=12;
   }
   maxStride=Math.max(maxStride,stride);
  }targets+=count;
 }
 for(const n of json.nodes||[])if(n.weights&&(n.weights.length!==(json.meshes?.[n.mesh]?.primitives?.[0]?.targets?.length||0)||n.weights.some(v=>!Number.isFinite(v))))throw Error('Повреждены индивидуальные веса Blend Shapes');
 for(const a of json.animations||[])for(const c of a.channels||[])if(c.target?.path==='weights'){
  const s=a.samplers?.[c.sampler],input=json.accessors?.[s?.input],output=json.accessors?.[s?.output],n=json.nodes?.[c.target.node],count=json.meshes?.[n?.mesh]?.primitives?.[0]?.targets?.length||0;
  if(!count||!input||!output||input.type!=='SCALAR'||input.componentType!==5126||output.componentType!==5126||input.normalized||output.normalized||!['LINEAR','STEP','CUBICSPLINE'].includes(s.interpolation||'LINEAR')||output.type!=='SCALAR'||output.count!==input.count*count*(s.interpolation==='CUBICSPLINE'?3:1))throw Error('Повреждена анимация Blend Shapes');
  animationBytes+=(input.count+output.count)*4;
 }
 if(bytes>MAX_MORPH_BYTES||animationBytes>32*1048576)throw Error('Blend Shapes требуют больше 96 МиБ данных форм или 32 МиБ анимаций. Для Android нужен более лёгкий исходник.');
 return {targets,bytes,maxStride,triangles};
}
export function morphLocks(prim){
 const count=prim.getAttribute('POSITION').getCount(),direct=new Uint8Array(count),locks=new Uint8Array(count);
 if(prim.listTargets().length>MAX_MORPH_TARGETS)throw Error('Поддерживается до 64 Blend Shapes на меш');
 for(const t of prim.listTargets())for(const semantic of t.listSemantics()){
  const a=t.getAttribute(semantic),values=a.getArray();
  if(!allowed.has(semantic)||a.getType()!=='VEC3'||a.getCount()!==count)throw Error('Повреждён канал Blend Shapes: '+semantic);
  for(let i=0;i<values.length;i++){if(!Number.isFinite(values[i]))throw Error('Нечисловое смещение Blend Shapes');if(values[i]!==0)direct[Math.floor(i/3)]=1}
 }
 locks.set(direct);const ix=prim.getIndices()?.getArray();
 if(ix)for(let i=0;i<ix.length;i+=3){if(direct[ix[i]]||direct[ix[i+1]]||direct[ix[i+2]])for(let k=0;k<3;k++)locks[ix[i+k]]=1}
 else for(let i=0;i<count;i+=3)if(direct[i]||direct[i+1]||direct[i+2])for(let k=0;k<3;k++)locks[i+k]=1;
 return locks;
}
export function captureMorphs(document,{ids=false}={}){
 const root=document.getRoot(),nodes=root.listNodes(),meshes=root.listMeshes(),parts=[];
 const data=a=>({array:a.getArray(),normalized:a.getNormalized(),component:a.getComponentType()});
 for(let mi=0;mi<meshes.length;mi++)for(let pi=0;pi<meshes[mi].listPrimitives().length;pi++){
  const prim=meshes[mi].listPrimitives()[pi];if(!prim.listTargets().length)continue;
  const count=prim.getAttribute('POSITION').getCount();if(ids&&prim.getAttribute(MORPH_ID))throw Error('Исходник содержит служебный атрибут Forge');
  const locks=morphLocks(prim),used=new Uint8Array(count),ix=prim.getIndices()?.getArray();if(ix)for(const i of ix)used[i]=1;else used.fill(1);
  parts.push({mi,pi,count,position:data(prim.getAttribute('POSITION')),locks,used,targets:prim.listTargets().map(t=>({name:t.getName(),attributes:t.listSemantics().map(s=>({semantic:s,...data(t.getAttribute(s))}))}))});
  if(ids)prim.setAttribute(MORPH_ID,document.createAccessor().setBuffer(root.listBuffers()[0]||document.createBuffer()).setType(Accessor.Type.SCALAR).setArray(Float32Array.from({length:count},(_,i)=>i)));
 }
 const meshState=meshes.map(m=>({weights:m.getWeights().slice(),names:m.listPrimitives().map(p=>p.listTargets().map(t=>t.getName()))})),nodeState=nodes.map(n=>n.getWeights().slice());
 const channels=root.listAnimations().flatMap((a,ai)=>a.listChannels().filter(c=>c.getTargetPath()==='weights').map(c=>{
  const s=c.getSampler(),input=s.getInput().getArray(),output=s.getOutput().getArray();
  for(let i=0;i<input.length;i++)if(!Number.isFinite(input[i])||input[i]<0||i&&input[i]<=input[i-1])throw Error('Некорректное время анимации мимики');
  for(const value of output)if(!Number.isFinite(value))throw Error('Нечисловое значение анимации мимики');
  return {ai,node:nodes.indexOf(c.getTargetNode()),interpolation:s.getInterpolation(),input,output};
 }));
 return {parts,meshState,nodeState,channels};
}
export function assertMorphMetadata(saved,document){
 const root=document.getRoot(),meshes=root.listMeshes(),nodes=root.listNodes();
 if(meshes.length!==saved.meshState.length||nodes.length!==saved.nodeState.length)throw Error('Изменились узлы Blend Shapes');
 for(let mi=0;mi<meshes.length;mi++){
  equal(saved.meshState[mi].weights,meshes[mi].getWeights(),'начальные веса Blend Shapes');
  if(JSON.stringify(meshes[mi].listPrimitives().map(p=>p.listTargets().map(t=>t.getName())))!==JSON.stringify(saved.meshState[mi].names))throw Error('Изменились имена или порядок Blend Shapes');
 }
 for(let i=0;i<nodes.length;i++)equal(saved.nodeState[i],nodes[i].getWeights(),'индивидуальные веса Blend Shapes');
 const actual=root.listAnimations().flatMap((a,ai)=>a.listChannels().filter(c=>c.getTargetPath()==='weights').map(c=>({ai,c})));
 if(actual.length!==saved.channels.length)throw Error('Потеряна анимация Blend Shapes');
 for(let i=0;i<actual.length;i++){
  const {ai,c}=actual[i],old=saved.channels[i],s=c.getSampler();
  if(ai!==old.ai||nodes.indexOf(c.getTargetNode())!==old.node||s.getInterpolation()!==old.interpolation)throw Error('Изменилась привязка анимации Blend Shapes');
  equal(old.input,s.getInput().getArray(),'времена мимики');equal(old.output,s.getOutput().getArray(),'значения мимики');
 }
}
const value=(a,i,float)=>{let v=a.array[i];if(a.normalized)v=Math.max(-1,v/maximum[a.component]);return float?Math.fround(v):a.array[i]};
export function morphMaps(document,{remove=false}={}){
 const maps=[];for(const mesh of document.getRoot().listMeshes())for(const prim of mesh.listPrimitives())if(prim.listTargets().length){const a=prim.getAttribute(MORPH_ID);if(!a)throw Error('Потеряна карта вершин Blend Shapes');maps.push(a.getArray());if(remove)prim.setAttribute(MORPH_ID,null)}return maps;
}
export function assertMorphRows(saved,document,{maps=morphMaps(document),baked=false}={}){
 const meshes=document.getRoot().listMeshes();
 for(let part=0;part<saved.parts.length;part++){
  const old=saved.parts[part],prim=meshes[old.mi]?.listPrimitives()[old.pi],ids=maps[part],count=prim?.getAttribute('POSITION')?.getCount(),seen=new Uint8Array(old.count);
  if(!ids||ids.length!==count||prim.listTargets().length!==old.targets.length)throw Error('Повреждена сетка Blend Shapes');
  for(let i=0;i<count;i++){
   const id=ids[i];if(!Number.isInteger(id)||id<0||id>=old.count)throw Error('Повреждена карта Blend Shapes');seen[id]=1;
   for(let k=0;k<3;k++)if(prim.getAttribute('POSITION').getArray()[i*3+k]!==value(old.position,id*3+k,baked))throw Error('Изменились координаты основы Blend Shapes');
  }
  for(let i=0;i<old.count;i++)if(old.used[i]&&old.locks[i]&&!seen[i])throw Error('Потеряна защищённая вершина мимики');
  for(let t=0;t<old.targets.length;t++)for(const a of old.targets[t].attributes){
   const out=prim.listTargets()[t].getAttribute(a.semantic);if(!out||out.getCount()!==count)throw Error('Потерян канал Blend Shapes');
   for(let i=0;i<count;i++)for(let k=0;k<3;k++){const v=out.getArray()[i*3+k];if(!Number.isFinite(v)||((!baked||a.semantic!=='TANGENT')&&v!==value(a,ids[i]*3+k,baked)))throw Error('Изменились смещения Blend Shapes')}
  }
 }assertMorphMetadata(saved,document);
}
export async function resampleWithMorphs(document){
 const samplers=new Set(document.getRoot().listAnimations().flatMap(a=>a.listChannels().filter(c=>c.getTargetPath()==='weights').map(c=>c.getSampler()))),saved=Array.from(samplers,s=>({s,input:s.getInput().clone(),output:s.getOutput().clone()}));
 if(!samplers.size){await document.transform(resample());return}
 try{await document.transform(resample({cleanup:false}))}finally{for(const {s,input,output}of saved)s.setInput(input).setOutput(output)}
}

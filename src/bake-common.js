import {createCodecIO,removeGeometryCompression} from './codec-io.js';
import {countTriangles} from './glb-optimize.js';
import {geometryPlan,geometryHistory} from './geometry-policy.js';
import {inspectGlb} from './format.js';
import {checkBakeMemory,boundedGeometryMemory} from './bake-memory.js';
import {inspectMorphJson} from './morph-policy.js';
export function morphBakeMemory(info){return info.targets?info.bytes*3+Math.min(info.triangles,200000)*3*info.maxStride*2:0}
function selectedAccessorBytes(json,geometryOnly){
 const used=new Set();for(const m of json.meshes||[])for(const p of m.primitives||[]){if(p.indices!==undefined)used.add(p.indices);for(const [s,i]of Object.entries(p.attributes||{}))if(!geometryOnly||s==='POSITION')used.add(i)}
 const sizes={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16},bytes={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
 return (json.accessors||[]).reduce((n,a,i)=>n+(!geometryOnly||used.has(i)?a.count*sizes[a.type]*bytes[a.componentType]:0),0);
}
export async function readBakeGlb(bytes,{memoryBudgetMiB,lowMemory=false,geometryOnly=false}={}){
 const j=inspectGlb(bytes).json,morph=inspectMorphJson(j);let triangles=0,vertices=0;
 // Reject optional unknown metadata too, before the IO reader can ignore it.
 const allowed=['KHR_mesh_quantization','KHR_texture_transform','EXT_texture_webp','KHR_texture_basisu','KHR_draco_mesh_compression','EXT_meshopt_compression'];
 const unsupported=(j.extensionsUsed||[]).filter(n=>!allowed.includes(n));
 if(unsupported.length)throw Error('Перенос деталей пока не поддерживает расширения: '+unsupported.join(', '));
 for(const m of j.meshes||[])for(const p of m.primitives||[]){
  const n=j.accessors?.[p.attributes?.POSITION]?.count||0;vertices+=n;
  triangles+=Math.floor((p.indices===undefined?n:j.accessors?.[p.indices]?.count||0)/3);
 }
 if(triangles>6000000||vertices>3500000||(j.buffers||[]).reduce((n,b)=>n+b.byteLength,0)>512*1048576)
  throw Error('Исходник слишком большой для переноса деталей на Android');
 // Reject geometry that cannot fit before allocating decoded accessors/WASM.
 if(lowMemory&&(j.skins?.length||j.animations?.length))throw Error('Экономный перенос пока поддерживает статические модели без скелета и анимаций');
 if(lowMemory&&morph.targets)throw Error('Blend Shapes используют путь с сохранением мимики. Экономный статический перенос для них недоступен.');
 if(lowMemory&&(j.images||[]).some(i=>i.mimeType==='image/ktx2'))throw Error('Экономный перенос пока требует исходные текстуры PNG, JPEG или WebP. KTX2 доступен после переноса.');
 if(lowMemory&&(j.extensionsUsed||[]).some(n=>['KHR_draco_mesh_compression','EXT_meshopt_compression'].includes(n)))throw Error('Экономный перенос пока требует исходный GLB без Meshopt/Draco. Сжатие готового результата доступно после переноса.');
 if(memoryBudgetMiB!==undefined)checkBakeMemory({geometryBytes:(lowMemory?boundedGeometryMemory(bytes.byteLength,selectedAccessorBytes(j,geometryOnly),triangles,vertices):bytes.byteLength*2+vertices*40+triangles*38)+morphBakeMemory(morph),memoryBudgetMiB});
 const io=await createCodecIO(bytes);let document;
 if(lowMemory&&geometryOnly){
  const data=await io.binaryToJSON(bytes),used=new Set();
  for(const m of data.json.meshes||[])for(const p of m.primitives||[]){
   if(p.targets?.length||p.mode!==undefined&&p.mode!==4)throw Error('Перенос деталей: Morph Targets и нетреугольные примитивы пока не поддерживаются');
   used.add(p.attributes.POSITION);if(p.indices!==undefined)used.add(p.indices);p.attributes={POSITION:p.attributes.POSITION};
  }
  const remap=new Map(),accessors=[];for(let i=0;i<(data.json.accessors||[]).length;i++)if(used.has(i)){remap.set(i,accessors.length);accessors.push(data.json.accessors[i])}
  for(const m of data.json.meshes||[])for(const p of m.primitives||[]){p.attributes.POSITION=remap.get(p.attributes.POSITION);if(p.indices!==undefined)p.indices=remap.get(p.indices)}
  data.json.accessors=accessors;document=await io.readJSON(data);
 }else document=await io.readBinary(bytes);
 removeGeometryCompression(document);return {io,document};
}
export const bakePrimitives=d=>d.getRoot().listMeshes().flatMap(m=>m.listPrimitives());
export function bakePlan(document,bytes,{targetTriangles=50000,ratio=.5,error=.003,resolution=1024,memoryBudgetMiB=768,lowMemory=false}={}){
 if(!Number.isInteger(resolution)||resolution<32||resolution>2048||(resolution&(resolution-1)))
  throw Error('Для переноса деталей выбери текстуры 512, 1024 или 2048 px');
 if(!Number.isFinite(memoryBudgetMiB)||memoryBudgetMiB<64||memoryBudgetMiB>768)throw Error('Неверный предел памяти');
 const root=document.getRoot(),sourceTriangles=countTriangles(document);
 const goal=geometryPlan({sourceTriangles,targetTriangles,ratio,error,history:geometryHistory(root.getExtras())});
 const primitives=bakePrimitives(document);
 if(goal.ratio>=1)return {...goal,resolution,sourceTriangles,unchanged:true};
 if(sourceTriangles>6000000||goal.targetTriangles>200000||primitives.length>8)
  throw Error('Перенос деталей: до 6 млн исходных и 200 тысяч целевых треугольников, не более 8 частей.');
 const unsupported=root.listExtensionsUsed().map(e=>e.extensionName).filter(n=>
  !['KHR_mesh_quantization','KHR_texture_transform','EXT_texture_webp','KHR_texture_basisu'].includes(n));
 if(unsupported.length)throw Error('Перенос деталей пока не поддерживает расширения: '+unsupported.join(', '));
 for(const p of primitives){
  if(p.getMode()!==4)throw Error('Перенос деталей: нетреугольные примитивы пока не поддерживаются');
  if(!p.getAttribute('POSITION'))throw Error('Отсутствуют координаты вершин');
 }
 const vertices=primitives.reduce((n,p)=>n+p.getAttribute('POSITION').getCount(),0);
 let decode=0,decoderPeak=0;
 for(const t of root.listTextures()){
  const s=t.getSize();if(!s)throw Error('Не удалось определить размер текстуры');
  const factor=Math.min(1,(lowMemory?Math.max(1024,resolution):2048)/Math.max(...s));
  decode+=Math.ceil(s[0]*factor)*Math.ceil(s[1]*factor)*4;decoderPeak=Math.max(decoderPeak,s[0]*s[1]*4);
 }
 // Peak estimate is a guard, not a guarantee of available device RAM.
 const accessors=root.listAccessors().reduce((n,a)=>n+(a.getArray()?.byteLength||0),0),images=root.listTextures().reduce((n,t)=>n+(t.getImage()?.byteLength||0),0);
 const morphBytes=primitives.reduce((n,p)=>n+p.listTargets().reduce((s,t)=>s+t.listAttributes().reduce((v,a)=>v+a.getCount()*12,0),0),0),morphStride=Math.max(0,...primitives.map(p=>p.listTargets().reduce((s,t)=>s+t.listAttributes().length*12,0))),morphExtra=morphBakeMemory({targets:morphBytes>0,bytes:morphBytes,triangles:sourceTriangles,maxStride:morphStride});
 const estimatedMiB=checkBakeMemory({geometryBytes:(lowMemory?boundedGeometryMemory(bytes,accessors,sourceTriangles,vertices):bytes*2+vertices*40+sourceTriangles*38)+morphExtra,
  projectionBytes:(lowMemory?bytes+accessors+images*2+decode+decoderPeak+200000*250+32*1048576:bytes*2+vertices*40+sourceTriangles*22+decode+decoderPeak+goal.targetTriangles*250)+morphExtra,
  mapBytesPerPixel:(lowMemory?86:32)+16*primitives.length,resolution,memoryBudgetMiB});
 return {...goal,resolution,sourceTriangles,estimatedMiB,unchanged:false};
}
function equalArray(a,b,label){
 if(!a||!b||a.length!==b.length)throw Error('Изменились '+label);
 for(let i=0;i<a.length;i++)if(a[i]!==b[i])throw Error('Изменились '+label);
}
export function assertBakeRigPreserved(source,result,{animationKeys=false}={}){
 const a=source.getRoot(),b=result.getRoot(),an=a.listNodes(),bn=b.listNodes();
 if(an.length!==bn.length||a.listSkins().length!==b.listSkins().length||a.listAnimations().length!==b.listAnimations().length)
  throw Error('Изменилось число костей, узлов, скелетов или анимаций');
 for(let i=0;i<an.length;i++){
  if(an[i].getName()!==bn[i].getName())throw Error('Изменилось имя узла/кости');
  equalArray(an[i].getMatrix(),bn[i].getMatrix(),'исходные трансформации костей');
  equalArray(an[i].listChildren().map(n=>an.indexOf(n)),bn[i].listChildren().map(n=>bn.indexOf(n)),'связи костей');
 }
 const as=a.listSkins(),bs=b.listSkins();
 for(let i=0;i<as.length;i++){
  equalArray(as[i].listJoints().map(n=>an.indexOf(n)),bs[i].listJoints().map(n=>bn.indexOf(n)),'порядок суставов');
  const x=as[i].getInverseBindMatrices(),y=bs[i].getInverseBindMatrices();
  if(!!x!==!!y)throw Error('Потеряны матрицы привязки');
  if(x)equalArray(x.getArray(),y.getArray(),'матрицы привязки');
 }
 for(let i=0;i<a.listAnimations().length;i++){
  const x=a.listAnimations()[i],y=b.listAnimations()[i];
  if(x.getName()!==y.getName())throw Error('Изменилось имя анимации');
  const xc=x.listChannels(),yc=y.listChannels();
  if(xc.length!==yc.length)throw Error('Потеряны каналы анимации');
  for(let k=0;k<xc.length;k++){
   if(xc[k].getTargetPath()!==yc[k].getTargetPath()||an.indexOf(xc[k].getTargetNode())!==bn.indexOf(yc[k].getTargetNode()))
    throw Error('Изменилась привязка анимации к кости');
   if(!animationKeys){
    const p=xc[k].getSampler(),q=yc[k].getSampler();
    if((p.getInterpolation()||'LINEAR')!==(q.getInterpolation()||'LINEAR'))throw Error('Изменилась интерполяция анимации');
    equalArray(p.getInput().getArray(),q.getInput().getArray(),'времена анимации');
    equalArray(p.getOutput().getArray(),q.getOutput().getArray(),'значения анимации');
   }
  }
 }
}

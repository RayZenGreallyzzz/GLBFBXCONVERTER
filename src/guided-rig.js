import {Accessor,PropertyType} from '@gltf-transform/core';
import {prune} from '@gltf-transform/functions';
import {Matrix4,Matrix3,Vector3} from 'three';
import {inspectGlb} from './format.js';
import {createCodecIO,removeGeometryCompression} from './codec-io.js';
import {attributeValues} from './static-simplify.js';
import {rigBoneSpec} from './rig-guides.js';
import {computeSkinWeights} from './vendor/voxel-skinner/index.js';
import {localizeArmWeights} from './arm-weights.js';

export function rigPreflight(bytes,{memoryBudgetMiB=384,resolution=48}={}){
 const j=inspectGlb(bytes).json;
 if((j.skins||[]).length||(j.animations||[]).length)throw Error('Для создания нового скелета нужен исходный GLB без скелета и анимаций');
 if((j.meshes||[]).some(m=>(m.primitives||[]).some(p=>p.targets?.length)))throw Error('Новый скелет с Blend Shapes пока не поддерживается. Сохрани формы и используй существующий скелет.');
 if((j.scenes||[]).length!==1||j.cameras?.length)throw Error('Создание скелета: нужна одна сцена без камер');
 if((j.images||[]).some(image=>image.uri))throw Error('Для офлайн-риггинга нужны изображения, встроенные в GLB, без внешних ссылок');
 if((j.nodes||[]).some(n=>n.extensions?.KHR_lights_punctual||n.extensions?.EXT_mesh_gpu_instancing))throw Error('Для нового скелета нужна сцена без источников света и GPU-инстансов');
 const active=new Set(),visit=i=>{if(active.has(i))return;const n=j.nodes?.[i];if(!n)throw Error('Отсутствует узел сцены');active.add(i);for(const child of n.children||[])visit(child)};
 for(const i of j.scenes[0].nodes||[])visit(i);
 if((j.nodes||[]).some((n,i)=>n.mesh!==undefined&&!active.has(i)))throw Error('В файле есть меши вне активной сцены. Подготовь одну сцену персонажа.');
 if(![32,48,64].includes(resolution))throw Error('Неверная точность весов');
 let vertices=0,triangles=0;
 for(const node of j.nodes||[])if(node.mesh!==undefined){const m=j.meshes?.[node.mesh];if(!m)throw Error('Отсутствует меш');for(const p of m.primitives||[]){const a=j.accessors?.[p.attributes?.POSITION],n=a?.count;if(p.mode!==undefined&&p.mode!==4||!Number.isSafeInteger(n)||n<3)throw Error('Для скелета нужна треугольная геометрия');vertices+=n;triangles+=(p.indices===undefined?n:j.accessors?.[p.indices]?.count||0)/3}}
 if(!vertices||vertices>650000||triangles>1000000)throw Error('Для нового скелета: до 650 тысяч вершин и 1 млн треугольников. Сначала подготовь сетку в оптимизации.');
 let decodedBytes=0;
 const components={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4},widths={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
 for(const a of j.accessors||[]){const size=components[a.componentType]*widths[a.type]*a.count;if(!Number.isSafeInteger(a.count)||a.count<0||!Number.isSafeInteger(size))throw Error('Некорректный размер данных модели');decodedBytes+=size}
 for(const v of j.bufferViews||[]){if(!Number.isSafeInteger(v.byteLength)||v.byteLength<0)throw Error('Некорректный размер буфера');decodedBytes+=v.byteLength}
 const estimatedMiB=Math.ceil((bytes.byteLength*3+decodedBytes*2+vertices*120+triangles*16+(resolution+2)**3*22*16+32*1048576)/1048576);
 if(!Number.isFinite(memoryBudgetMiB)||memoryBudgetMiB<64||memoryBudgetMiB>768||estimatedMiB>memoryBudgetMiB)throw Error('Скелет: расчётная память '+estimatedMiB+' МиБ, доступный предел '+memoryBudgetMiB+' МиБ. Нужен более лёгкий исходник.');
 return {vertices,triangles,estimatedMiB,resolution};
}

export async function buildGuidedRig(input,{guides,resolution=48,memoryBudgetMiB=384,onProgress=()=>{}}={}){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input),plan=rigPreflight(bytes,{resolution,memoryBudgetMiB});
 onProgress(2,'Читаем исходный GLB…');const io=await createCodecIO(bytes),document=await io.readBinary(bytes);removeGeometryCompression(document);
 const root=document.getRoot(),buffer=root.listBuffers()[0],originalImages=root.listTextures().map(t=>t.getImage()),records=[];let count=0,faceCount=0;
 // Snapshot world transforms before resetting any node. Each instance receives
 // its own vertex arrays; original shared tuples are never overwritten in place.
 for(const [nodeIndex,node]of root.listNodes().entries())if(node.getMesh()){
  const mesh=node.getMesh(),matrix=new Matrix4().fromArray(node.getWorldMatrix()),normal=new Matrix3().getNormalMatrix(matrix),linear=new Matrix3().setFromMatrix4(matrix),parts=[];
  if(!Number.isFinite(matrix.determinant())||matrix.determinant()===0)throw Error('Невырожденный масштаб модели обязателен');
  for(const [primitiveIndex,prim]of mesh.listPrimitives().entries()){
   const p=attributeValues(prim.getAttribute('POSITION')),n=prim.getAttribute('NORMAL'),t=prim.getAttribute('TANGENT'),out=new Float32Array(p.length),nv=n?new Float32Array(p.length):null,tv=t?new Float32Array(t.getCount()*4):null,v=new Vector3();
   const normals=n?attributeValues(n):null,tangents=t?attributeValues(t):null;
   for(let i=0;i<p.length;i+=3){v.fromArray(p,i).applyMatrix4(matrix);if(![v.x,v.y,v.z].every(Number.isFinite))throw Error('Некорректные координаты');v.toArray(out,i);if(nv)v.fromArray(normals,i).applyMatrix3(normal).normalize().toArray(nv,i)}
   if(tv)for(let i=0;i<t.getCount();i++){v.fromArray(tangents,i*4).applyMatrix3(linear).normalize().toArray(tv,i*4);tv[i*4+3]=tangents[i*4+3]*(matrix.determinant()<0?-1:1)}
   const indices=prim.getIndices()?new Uint32Array(prim.getIndices().getArray()):Uint32Array.from({length:p.length/3},(_,i)=>i);
   for(const index of indices)if(index>=p.length/3)throw Error('Индекс вне сетки');
   if(matrix.determinant()<0)for(let i=0;i<indices.length;i+=3){const a=indices[i+1];indices[i+1]=indices[i+2];indices[i+2]=a}
   parts.push({prim,primitiveIndex,positions:out,normals:nv,tangents:tv,indices,start:count});count+=out.length/3;faceCount+=indices.length/3;
  }records.push({node,nodeIndex,mesh,parts});
 }
 const positions=new Float32Array(count*3),indices=new Uint32Array(faceCount*3);let k=0;
 for(const r of records)for(const p of r.parts){positions.set(p.positions,p.start*3);for(const index of p.indices)indices[k++]=index+p.start}
 const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};for(let i=0;i<positions.length;i++) {const a=i%3;bounds.min[a]=Math.min(bounds.min[a],positions[i]);bounds.max[a]=Math.max(bounds.max[a],positions[i])}
 const spec=rigBoneSpec(guides,bounds),deform=spec.map((b,i)=>({b,i})).filter(x=>x.b.deform),h=bounds.max[1]-bounds.min[1],scale=2/h;
 if(root.listNodes().some(n=>spec.some(b=>b.name===n.getName())))throw Error('В модели уже есть узлы со стандартными именами скелета. Для нового рига нужна чистая исходная сетка.');
 const normalized=Float32Array.from(positions,x=>x*scale),segments=deform.map(({b})=>({head:b.position.toArray().map(x=>x*scale),tail:b.tail.toArray().map(x=>x*scale)}));
 onProgress(8,'Считаем веса внутри объёма модели…');
 const result=computeSkinWeights(normalized,indices,segments,{resolution,maxInfluences:4,threshold:.01,onProgress:(stage,detail)=>onProgress(stage==='voxelize'?10:stage==='extract'?86:15+Math.round((detail.boneIndex+1)/detail.totalBones*68),'Веса: '+(stage==='geodesic'?'кость '+(detail.boneIndex+1)+'/'+detail.totalBones:stage==='extract'?'проверка вершин':'объёмная сетка'))});
 for(let i=0;i<deform.length;i++)if(!result.distanceFields[i].some(Number.isFinite))throw Error('Кость не попала внутрь объёма: '+deform[i].b.name+'. Исправь точки спереди и сбоку.');
 const {skinIndices,skinWeights}=result;let unweighted=0;
 for(let v=0;v<count;v++) {let sum=0;const seen=new Set();for(let c=0;c<4;c++){const at=v*4+c,w=skinWeights[at],index=skinIndices[at];if(!Number.isFinite(w)||w<0||index>=deform.length||w>0&&seen.has(index))throw Error('Некорректные веса скелета');if(w>0)seen.add(index);sum+=w;skinIndices[at]=deform[index]?.i||0}if(sum<.9999||sum>1.0001)unweighted++}
 if(unweighted)throw Error('Без надёжных весов осталось вершин: '+unweighted+'. Проверь точки, замкнутость сетки и точность. Экспорт отменён.');
 const localized=localizeArmWeights(positions,skinIndices,skinWeights,spec.map(b=>({name:b.name,position:b.position.toArray()})));skinIndices.set(localized.skinIndices);skinWeights.set(localized.skinWeights);
 onProgress(90,'Создаём скелет и проверяем привязку…');
 const nodes=spec.map(b=>document.createNode(b.name).setTranslation(b.translation.toArray()).setRotation(b.rotation.toArray())),names=new Map(spec.map((b,i)=>[b.name,i]));
 for(let i=0;i<spec.length;i++)if(spec[i].parent)nodes[names.get(spec[i].parent)].addChild(nodes[i]);
 root.listScenes()[0].addChild(nodes[0]);
 const skin=document.createSkin('Phoenix Humanoid').setSkeleton(nodes[0]);for(const node of nodes)skin.addJoint(node);
 skin.setInverseBindMatrices(document.createAccessor('Rig inverse bind').setBuffer(buffer).setType(Accessor.Type.MAT4).setArray(new Float32Array(spec.flatMap(b=>b.inverseBind))));
 const accessor=(type,array)=>document.createAccessor().setBuffer(buffer).setType(type).setArray(array);
 // Reset only original nodes: generated joints must retain their local bind pose.
 for(const node of root.listNodes())if(!nodes.includes(node))node.setTranslation([0,0,0]).setRotation([0,0,0,1]).setScale([1,1,1]);
 for(const record of records){
  const mesh=document.createMesh(record.mesh.getName()).setExtras(record.mesh.getExtras());
  for(const p of record.parts){const prim=p.prim.clone();prim.setAttribute('POSITION',accessor(Accessor.Type.VEC3,p.positions));if(p.normals)prim.setAttribute('NORMAL',accessor(Accessor.Type.VEC3,p.normals));if(p.tangents)prim.setAttribute('TANGENT',accessor(Accessor.Type.VEC4,p.tangents));prim.setIndices(accessor(Accessor.Type.SCALAR,p.indices));
   p.skinIndices=skinIndices.slice(p.start*4,(p.start+p.positions.length/3)*4);p.skinWeights=skinWeights.slice(p.start*4,(p.start+p.positions.length/3)*4);
   prim.setAttribute('JOINTS_0',accessor(Accessor.Type.VEC4,p.skinIndices)).setAttribute('WEIGHTS_0',accessor(Accessor.Type.VEC4,p.skinWeights));mesh.addPrimitive(prim)
  }record.node.setMesh(mesh).setSkin(skin);record.node.getParentNode()?.removeChild(record.node);root.listScenes()[0].addChild(record.node);
 }
 const used=new Set(root.listNodes().map(n=>n.getMesh()).filter(Boolean));for(const mesh of root.listMeshes())if(!used.has(mesh)){for(const p of mesh.listPrimitives())p.dispose();mesh.dispose()}
 for(const ext of root.listExtensionsUsed())if(ext.extensionName==='KHR_mesh_quantization')ext.dispose();
 root.setExtras({...root.getExtras(),phoenixRig:{version:3,profile:'humanoid-body',method:'voxel-geodesic',weightSampling:'connected-trilinear-localized-arms',armLocalWeights:1,resolution,joints:nodes.length,requiresMotionReview:true}});
 await document.transform(prune({propertyTypes:[PropertyType.ACCESSOR],keepAttributes:true,keepExtras:true}));
 const output=await io.writeBinary(document),verify=await io.readBinary(output);
 if(verify.getRoot().listSkins()[0]?.listJoints().length!==nodes.length||verify.getRoot().listTextures().length!==originalImages.length)throw Error('Проверка GLB обнаружила потерю данных');
 for(let i=0;i<originalImages.length;i++){const a=originalImages[i],b=verify.getRoot().listTextures()[i].getImage();if(a.length!==b.length||a.some((v,k)=>v!==b[k]))throw Error('Изменилась исходная текстура')}
 const checkedSkin=verify.getRoot().listSkins()[0],inverse=checkedSkin.getInverseBindMatrices().getArray();
 for(let i=0;i<checkedSkin.listJoints().length;i++){
  const rest=new Matrix4().fromArray(checkedSkin.listJoints()[i].getWorldMatrix()).multiply(new Matrix4().fromArray(inverse,i*16));
  for(let k=0;k<16;k++)if(Math.abs(rest.elements[k]-(k%5===0?1:0))>(k>=12?Math.max(1,h)*2e-5:2e-5))throw Error('Не совпала исходная поза скелета после записи GLB');
 }
 onProgress(100,'Скелет готов. Проверь плечи, локти, таз и колени в движении.');
 const preview={bones:spec.map(b=>({name:b.name,parent:b.parent,translation:b.translation.toArray(),rotation:b.rotation.toArray()})),parts:records.flatMap(r=>r.parts.map(p=>({node:r.nodeIndex,primitive:p.primitiveIndex,positions:p.positions,normals:p.normals,tangents:p.tangents,indices:p.indices,skinIndices:p.skinIndices,skinWeights:p.skinWeights})))};
 return {bytes:output,preview,kind:'rig',beforeBytes:bytes.byteLength,afterBytes:output.byteLength,sourceTriangles:plan.triangles,optimizedTriangles:faceCount,vertices:count,bones:nodes.length,estimatedMiB:plan.estimatedMiB,stats:result.stats,note:'Создан гуманоидный скелет тела; до 4 влияний на вершину. Сетка и исходные изображения сохранены. Пальцы, уши и хвост требуют отдельного риггинга. Проверь деформации перед игрой.'};
}

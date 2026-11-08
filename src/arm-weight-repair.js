import {Matrix4,Vector3,Quaternion} from 'three';
import {asBytes} from './binary.js';
import {inspectGlb} from './format.js';
import {localizeArmWeights} from './arm-weights.js';
export function armRepairEligibility(input){
 try{const j=inspectGlb(input).json,r=j.extras?.phoenixRig;if(r?.profile!=='humanoid-body'||j.skins?.length!==1||j.skins[0].joints?.length!==27)return {eligible:false,reason:'Открой GLB со скелетом тела Forge (27 костей).'};
  if(r.armLocalWeights===1)return {eligible:false,reason:'Веса рук этой модели уже обновлены.'};return {eligible:true,reason:''};
 }catch{return {eligible:false,reason:'Для исправления весов нужен GLB.'}}
}
export function repairArmWeights(input,{memoryBudgetMiB=384,onProgress=()=>{}}={}){
 const bytes=asBytes(input),eligibility=armRepairEligibility(bytes);if(!eligibility.eligible)throw Error(eligibility.reason);
 const j=structuredClone(inspectGlb(bytes).json),chunks=[];let bin;
 for(let at=12;at+8<=bytes.length;){const v=new DataView(bytes.buffer,bytes.byteOffset+at),size=v.getUint32(0,true),type=v.getUint32(4,true);if(at+8+size>bytes.length)throw Error('Повреждён GLB');const data=bytes.slice(at+8,at+8+size);chunks.push({type,data});if(type===0x004e4942)bin=data;at+=8+size}
 if(!bin||chunks.filter(c=>c.type===0x004e4942).length!==1||j.buffers?.length!==1||j.buffers[0].uri)throw Error('Нужен GLB со встроенным буфером');
 const widths={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16},sizes={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4},reads={5120:'getInt8',5121:'getUint8',5122:'getInt16',5123:'getUint16',5125:'getUint32',5126:'getFloat32'},view=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);
 const layout=index=>{const a=j.accessors?.[index],b=j.bufferViews?.[a?.bufferView],size=sizes[a?.componentType],width=widths[a?.type];if(!a||!b||a.sparse||b.buffer!==0||b.extensions?.EXT_meshopt_compression||!size||!width)throw Error('Нужны обычные атрибуты GLB без сжатия и разреженных весов');const offset=(b.byteOffset||0)+(a.byteOffset||0),stride=b.byteStride||size*width;if(!Number.isSafeInteger(a.count)||a.count<1||stride<width*size||offset+(a.count-1)*stride+width*size>bin.length)throw Error('Повреждён атрибут GLB');return {a,offset,stride,size,width}};
 const read=index=>{const l=layout(index),out=new Float64Array(l.a.count*l.width),max={5120:127,5121:255,5122:32767,5123:65535,5125:4294967295}[l.a.componentType];for(let i=0;i<l.a.count;i++)for(let k=0;k<l.width;k++){let x=view[reads[l.a.componentType]](l.offset+i*l.stride+k*l.size,true);if(l.a.normalized)x=Math.max(-1,x/max);if(!Number.isFinite(x))throw Error('Неконечные значения атрибута');out[i*l.width+k]=x}return out};
 const parent=new Int32Array(j.nodes.length).fill(-1);j.nodes.forEach((n,i)=>(n.children||[]).forEach(c=>parent[c]=i));const world=new Map(),active=new Set();
 const matrix=i=>{if(world.has(i))return world.get(i);if(active.has(i))throw Error('Цикл в скелете');active.add(i);const n=j.nodes[i];if(!n)throw Error('Отсутствует узел');let m;if(n.matrix)m=new Matrix4().fromArray(n.matrix);else{m=new Matrix4().compose(new Vector3().fromArray(n.translation||[0,0,0]),new Quaternion().fromArray(n.rotation||[0,0,0,1]),new Vector3().fromArray(n.scale||[1,1,1]))}if(parent[i]>=0)m.premultiply(matrix(parent[i]));active.delete(i);world.set(i,m);return m};
 const skin=j.skins[0],joints=skin.joints.map(i=>({name:j.nodes[i].name,position:new Vector3().setFromMatrixPosition(matrix(i)).toArray()})),records=[],seen=new Map();let vertices=0,triangles=0;
 j.nodes.forEach((node,nodeIndex)=>{if(node.skin!==0||node.mesh===undefined)return;for(const [primitive,p]of j.meshes[node.mesh].primitives.entries()){
  if(p.extensions?.KHR_draco_mesh_compression||p.attributes.JOINTS_1!==undefined||p.attributes.WEIGHTS_1!==undefined)throw Error('Для исправления нужны четыре обычных влияния на вершину');
  const key=p.attributes.JOINTS_0+':'+p.attributes.WEIGHTS_0,transform=matrix(nodeIndex).elements.join(',');if(seen.has(key)){if(seen.get(key).transform!==transform)throw Error('Общая сетка с разными преобразованиями пока не поддерживается');records.push({...seen.get(key),node:nodeIndex,primitive,duplicate:true});continue}
  const position=layout(p.attributes.POSITION),indices=layout(p.attributes.JOINTS_0),weights=layout(p.attributes.WEIGHTS_0);if(position.width!==3||indices.width!==4||weights.width!==4||position.a.count!==indices.a.count||indices.a.count!==weights.a.count||![5121,5123].includes(indices.a.componentType)||indices.a.normalized||!(weights.a.componentType===5126||weights.a.normalized&&[5121,5123].includes(weights.a.componentType)))throw Error('Неподдерживаемые атрибуты весов');
  const record={node:nodeIndex,primitive,p,transform,position,indices,weights};seen.set(key,record);records.push(record);vertices+=position.a.count;triangles+=(p.indices===undefined?position.a.count:layout(p.indices).a.count)/3;
 }});
 const estimatedMiB=Math.ceil((bytes.length*3+vertices*80+32*1048576)/1048576);if(!vertices||vertices>650000||!Number.isFinite(memoryBudgetMiB)||estimatedMiB>memoryBudgetMiB)throw Error('Исправление весов: нужно примерно '+estimatedMiB+' МиБ, до 650 тысяч вершин');
 let changedVertices=0,maxDiscardedWeight=0;const parts=[];onProgress(5,'Проверяем исходные веса рук…');
 for(const [recordIndex,r]of records.entries()){
  if(r.duplicate){const original=parts.find(p=>p.node===seen.get(r.p.attributes.JOINTS_0+':'+r.p.attributes.WEIGHTS_0).node&&p.primitive===seen.get(r.p.attributes.JOINTS_0+':'+r.p.attributes.WEIGHTS_0).primitive);parts.push({...original,node:r.node,primitive:r.primitive});continue}
  const positions=read(r.p.attributes.POSITION),m=matrix(r.node),v=new Vector3();for(let i=0;i<positions.length;i+=3)v.fromArray(positions,i).applyMatrix4(m).toArray(positions,i);
  const oldIndices=read(r.p.attributes.JOINTS_0),oldWeights=read(r.p.attributes.WEIGHTS_0);for(let i=0;i<oldIndices.length;i++)if(!Number.isSafeInteger(oldIndices[i])||oldIndices[i]<0||oldIndices[i]>=joints.length||oldWeights[i]<0)throw Error('Повреждены веса');
  for(let i=0;i<oldWeights.length;i+=4)if(Math.abs(oldWeights[i]+oldWeights[i+1]+oldWeights[i+2]+oldWeights[i+3]-1)>1e-4)throw Error('Исходные веса не нормализованы');
  const result=localizeArmWeights(positions,oldIndices,oldWeights,joints);changedVertices+=result.changedVertices;maxDiscardedWeight=Math.max(maxDiscardedWeight,result.maxDiscardedWeight);
  for(let i=0;i<r.indices.a.count;i++){
   const q=Array.from(result.skinWeights.subarray(i*4,i*4+4)),limit=r.weights.a.componentType===5121?255:65535;let encoded=q;
   if(r.weights.a.componentType!==5126){encoded=q.map(w=>Math.floor(w*limit));let remaining=limit-encoded.reduce((s,v)=>s+v,0);const order=[0,1,2,3].sort((a,b)=>(q[b]*limit-encoded[b])-(q[a]*limit-encoded[a]));for(let k=0;k<remaining;k++)encoded[order[k%4]]++}
   for(let k=0;k<4;k++){const at=i*4+k;view[r.indices.a.componentType===5121?'setUint8':'setUint16'](r.indices.offset+i*r.indices.stride+k*r.indices.size,result.skinIndices[at],true);view[r.weights.a.componentType===5126?'setFloat32':r.weights.a.componentType===5121?'setUint8':'setUint16'](r.weights.offset+i*r.weights.stride+k*r.weights.size,encoded[k],true);if(r.weights.a.componentType!==5126)result.skinWeights[at]=encoded[k]/limit}
  }
  parts.push({node:r.node,primitive:r.primitive,skinIndices:result.skinIndices,skinWeights:result.skinWeights});onProgress(10+Math.round((recordIndex+1)/records.length*80),'Локализуем влияние костей рук…');
 }
 j.extras.phoenixRig={...j.extras.phoenixRig,armLocalWeights:1};const text=new TextEncoder().encode(JSON.stringify(j)),jsonSize=(text.length+3)&~3;let total=12;
 for(const c of chunks)total+=8+(c.type===0x4e4f534a?jsonSize:c.data.length);const output=new Uint8Array(total),header=new DataView(output.buffer);header.setUint32(0,0x46546c67,true);header.setUint32(4,2,true);header.setUint32(8,total,true);let at=12;
 for(const c of chunks){const size=c.type===0x4e4f534a?jsonSize:c.data.length;header.setUint32(at,size,true);header.setUint32(at+4,c.type,true);if(c.type===0x4e4f534a){output.fill(32,at+8,at+8+size);output.set(text,at+8)}else output.set(c.data,at+8);at+=8+size}
 onProgress(100,'Веса рук исправлены. Сравни движения перед сохранением.');return {bytes:output,kind:'arm-weights',preview:{parts},changedVertices,maxDiscardedWeight,estimatedMiB,beforeBytes:bytes.length,afterBytes:output.length,sourceTriangles:triangles,optimizedTriangles:triangles,note:'Локализованы веса рук. Геометрия, текстуры, скелет и анимации сохранены.'};
}

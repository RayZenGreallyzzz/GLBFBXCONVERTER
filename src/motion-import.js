import * as THREE from 'three';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {parseBvhForRetarget,canonicalBone} from './animation-retarget.js';
import {createModelLoader} from './gltf-codecs.js';
import {inspectFbx,inspectGlb} from './format.js';

const MiB=1048576;
function binding(root,track){const p=THREE.PropertyBinding.parseTrackName(track.name);let node=THREE.PropertyBinding.findNode(root,p.nodeName);if(p.objectName==='bones')node=node?.skeleton?.bones.find(b=>b.name===p.objectIndex)||root.getObjectByName(p.objectIndex);else if(p.objectName)return null;return node&&p.propertyIndex===undefined?{node,property:p.propertyName}:null}
export function skeletonMotionSource(root,animations,kind){
 const nodes=[],actual=[];root.traverse(n=>{nodes.push(n);if(n.isBone)actual.push(n)});
 if(!animations?.length)throw Error('В файле нет анимаций');
 if(!actual.length&&!nodes.some(n=>canonicalBone(n.name)==='hips'))throw Error('В файле нет распознаваемого скелета');
 const needed=new Set();for(const node of actual.length?actual:nodes)for(let p=node;p;p=p.parent){needed.add(p);if(p===root)break}
 if(needed.size>200)throw Error('В источнике больше 200 узлов скелета');
 const graph=new THREE.Group(),copies=new Map(),names=new Set();
 for(const node of nodes)if(needed.has(node)){
  const b=new THREE.Bone();let name=THREE.PropertyBinding.sanitizeNodeName(node.name||'MotionNode'),suffix=1;while(names.has(name))name=THREE.PropertyBinding.sanitizeNodeName(node.name||'MotionNode')+'_'+suffix++;names.add(name);b.name=name;
  b.position.copy(node.position);b.quaternion.copy(node.quaternion);b.scale.copy(node.scale);
  if(![...b.position.toArray(),...b.quaternion.toArray(),...b.scale.toArray()].every(Number.isFinite)||b.scale.x<=0||Math.abs(b.scale.y-b.scale.x)>Math.max(1,b.scale.x)*1e-5||Math.abs(b.scale.z-b.scale.x)>Math.max(1,b.scale.x)*1e-5)throw Error('Для переноса нужен положительный равномерный масштаб скелета');
  (copies.get(node.parent)||graph).add(b);copies.set(node,b);
 }
 const warnings=[],clips=[];let skipped=0;
 for(const original of animations){
  const tracks=[];let rotations=0,invalid=false;
  for(const track of original.tracks){
   const target=binding(root,track),copy=target&&copies.get(target.node);if(!copy||!['quaternion','position','scale'].includes(target.property)){skipped++;continue}
   if(track.times.length>18000||!track.times.length||!track.values.every(Number.isFinite)||track.times.some((v,i)=>!Number.isFinite(v)||v<0||i&&v<=track.times[i-1])){invalid=true;break}
   if(target.property==='scale'){
    if(track.createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline||track.values.some((v,i)=>Math.abs(v-target.node.scale.getComponent(i%3))>1e-5)){invalid=true;break}continue;
   }
   const clone=track.clone();clone.name=copy.name+'.'+target.property;tracks.push(clone);if(target.property==='quaternion')rotations++;
  }
  if(invalid||!rotations||!Number.isFinite(original.duration)||original.duration<=0){warnings.push('Пропущено движение «'+(original.name||'без названия')+'»: нет поддерживаемых вращений, меняется масштаб или повреждены ключи.');continue}
  const name=String(original.name||'Motion').replace(/[^\p{L}\p{N}_ -]/gu,'_').slice(0,60)||'Motion';
  const clip=new THREE.AnimationClip(name,original.duration,tracks);clips.push(clip);
 }
 if(!clips.length)throw Error(warnings[0]||'В файле нет поддерживаемых анимаций костей');
 if(clips.length>100)throw Error('В одном файле допускается до 100 движений');
 if(skipped)warnings.push('Нескелетные каналы (например, мимика и материалы) не переносятся: '+skipped+'.');
 warnings.push('Переносятся повороты костей и, по выбору, движение таза. Скелет и веса персонажа сохраняются.');
 graph.updateMatrixWorld(true);const bones=[...copies.values()];return {kind,root:graph,skeleton:new THREE.Skeleton(bones),clips,clip:clips[0],warnings};
}
function dispose(root){const textures=new Set();root?.traverse(n=>{n.geometry?.dispose();for(const m of Array.isArray(n.material)?n.material:[n.material])if(m){for(const t of Object.values(m))if(t?.isTexture)textures.add(t);m.dispose()}});for(const t of textures)t.dispose()}
async function gltfMotion(bytes,entry){
 let json,bin;
 if(entry.format==='glb'){
  json=inspectGlb(bytes).json;const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);for(let at=12;at+8<=bytes.length;){const n=view.getUint32(at,true);if(at+8+n>bytes.length)throw Error('Повреждён блок GLB');if(view.getUint32(at+4,true)===0x004e4942)bin=bytes.subarray(at+8,at+8+n);at+=8+n}
 }else{try{json=JSON.parse(new TextDecoder().decode(bytes))}catch{throw Error('Некорректный JSON glTF')}if(json.asset?.version!=='2.0')throw Error('Требуется glTF 2.0')}
 const usedBuffers=new Set(),addView=index=>{if(index===undefined)return;const v=json.bufferViews?.[index];if(!v)throw Error('Отсутствует буфер анимации');usedBuffers.add(v.extensions?.EXT_meshopt_compression?.buffer??v.buffer)};
 for(const a of json.animations||[]){a.channels=a.channels.filter(c=>c.target?.node!==undefined&&['rotation','translation','scale'].includes(c.target.path));for(const c of a.channels){const s=a.samplers[c.sampler];for(const index of [s?.input,s?.output]){const acc=json.accessors?.[index];if(!acc)throw Error('Отсутствуют ключи анимации');addView(acc.bufferView);addView(acc.sparse?.indices.bufferView);addView(acc.sparse?.values.bufferView)}}}
 if(!(json.animations||[]).some(a=>a.channels.length))throw Error('В GLB/glTF нет анимации костей');
 for(const n of json.nodes||[]){delete n.mesh;delete n.skin;delete n.camera;delete n.weights;delete n.extensions}
 for(const skin of json.skins||[])delete skin.inverseBindMatrices;
 for(const key of ['meshes','materials','textures','images','cameras'])json[key]=[];
 json.extensionsUsed=(json.extensionsUsed||[]).filter(n=>n==='EXT_meshopt_compression');json.extensionsRequired=(json.extensionsRequired||[]).filter(n=>n==='EXT_meshopt_compression');delete json.extensions;
 let total=0;const urls=[];
 try{
  for(const index of usedBuffers){const buffer=json.buffers?.[index];if(!buffer||!Number.isSafeInteger(buffer.byteLength)||buffer.byteLength<0||buffer.byteLength>64*MiB)throw Error('Буфер анимации больше 64 МиБ');total+=buffer.byteLength;if(total>64*MiB)throw Error('Буферы выбранной анимации превышают 64 МиБ');
   if(buffer.uri?.startsWith('data:'))continue;
   const data=index===0&&!buffer.uri&&bin?bin:await entry.resource(buffer.uri||'');if(data.length<buffer.byteLength)throw Error('BIN короче заявленного размера');
   const url=URL.createObjectURL(new Blob([data]));urls.push(url);buffer.uri=url;
  }
  const manager=new THREE.LoadingManager();manager.setURLModifier(url=>{if(url.startsWith('blob:')||url.startsWith('data:'))return url;throw Error('Внешняя загрузка запрещена: '+url)});
  const loader=createModelLoader(manager);try{const loaded=await loader.parseAsync(JSON.stringify(json),'');return skeletonMotionSource(loaded.scene,loaded.animations,entry.format)}finally{loader.disposeCodecs?.()}
 }finally{for(const url of urls)URL.revokeObjectURL(url)}
}
export async function loadMotionSource(entry,{memoryBudgetMiB=384}={}){
 const estimate=Math.ceil(entry.size*(entry.format==='fbx'?8:4)/MiB+32);if(entry.size>64*MiB||!Number.isFinite(memoryBudgetMiB)||memoryBudgetMiB<64||estimate>memoryBudgetMiB)throw Error('Источник анимации требует примерно '+estimate+' МиБ. Выбери облегчённый файл со скелетом.');
 const bytes=await entry.read();if(bytes.length!==entry.size)throw Error('Размер файла анимации не совпал');
 if(entry.format==='bvh'){const result=parseBvhForRetarget(new TextDecoder().decode(bytes),entry.path.replace(/^.*\//,'').replace(/\.bvh$/i,''));return {...result,kind:'bvh',clips:[result.clip],warnings:[]}}
 if(['glb','gltf'].includes(entry.format))return gltfMotion(bytes,entry);
 if(entry.format!=='fbx')throw Error('Неподдерживаемый источник анимации');
 inspectFbx(bytes);const manager=new THREE.LoadingManager(),urls=new Set();manager.setURLModifier(url=>{if(url.startsWith('blob:'))urls.add(url);return 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='});
 let root;try{root=new FBXLoader(manager).parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');return skeletonMotionSource(root,root.animations,'fbx')}finally{dispose(root);for(const url of urls)URL.revokeObjectURL(url)}
}

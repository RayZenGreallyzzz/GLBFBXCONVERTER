import * as THREE from 'three';
import {parseBvhForRetarget} from './animation-retarget.js';
import {createModelLoader} from './gltf-codecs.js';
import {inspectFbx,inspectGlb} from './format.js';

const MiB=1048576;
function checkSignal(signal){if(signal?.aborted)throw Object.assign(Error('Просмотр отменён'),{name:'AbortError'})}
import {skeletonMotionSource} from './motion-skeleton.js';
export {skeletonMotionSource} from './motion-skeleton.js';
import {importFbxMotion} from './fbx-motion-client.js';
async function gltfMotion(bytes,entry,signal){
 checkSignal(signal);
 let json,bin;
 if(entry.format==='glb'){
  json=inspectGlb(bytes).json;const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);for(let at=12;at+8<=bytes.length;){const n=view.getUint32(at,true);if(at+8+n>bytes.length)throw Error('Повреждён блок GLB');if(view.getUint32(at+4,true)===0x004e4942)bin=bytes.subarray(at+8,at+8+n);at+=8+n}
 }else{try{json=JSON.parse(new TextDecoder().decode(bytes))}catch{throw Error('Некорректный JSON glTF')}if(json.asset?.version!=='2.0')throw Error('Требуется glTF 2.0')}
 if((json.nodes||[]).length>500||(json.animations||[]).length>100)throw Error('Источник анимаций слишком сложный: до 500 узлов и 100 движений');
 const usedBuffers=new Set(),addView=index=>{if(index===undefined)return;const v=json.bufferViews?.[index];if(!v)throw Error('Отсутствует буфер анимации');usedBuffers.add(v.extensions?.EXT_meshopt_compression?.buffer??v.buffer)};
 const expanded=new Set();let expandedBytes=0;
 for(const a of json.animations||[]){a.channels=(a.channels||[]).filter(c=>c.target?.node!==undefined&&['rotation','translation','scale'].includes(c.target.path));if(a.channels.length>1000)throw Error('Слишком много каналов движения');for(const c of a.channels){const s=a.samplers[c.sampler];for(const [role,index]of [s?.input,s?.output].entries()){const acc=json.accessors?.[index],width={SCALAR:1,VEC3:3,VEC4:4}[acc?.type];if(!acc||!width||acc.componentType!==5126||!Number.isSafeInteger(acc.count)||acc.count<1||acc.count>(role===0?18000:54000)||role===0&&acc.type!=='SCALAR')throw Error('Неподдерживаемый размер ключей анимации');if(!expanded.has(index)){expanded.add(index);expandedBytes+=acc.count*width*4;if(expandedBytes>64*MiB)throw Error('Ключи анимации превышают 64 МиБ')}addView(acc.bufferView);addView(acc.sparse?.indices.bufferView);addView(acc.sparse?.values.bufferView)}}}
 if(!(json.animations||[]).some(a=>a.channels.length))throw Error('В GLB/glTF нет анимации костей');
 for(const n of json.nodes||[]){delete n.mesh;delete n.skin;delete n.camera;delete n.weights;delete n.extensions}
 for(const skin of json.skins||[])delete skin.inverseBindMatrices;
 for(const key of ['meshes','materials','textures','images','cameras'])json[key]=[];
 json.extensionsUsed=(json.extensionsUsed||[]).filter(n=>n==='EXT_meshopt_compression');json.extensionsRequired=(json.extensionsRequired||[]).filter(n=>n==='EXT_meshopt_compression');delete json.extensions;
 let total=0;const urls=[];
 try{
  for(const index of usedBuffers){const buffer=json.buffers?.[index];if(!buffer||!Number.isSafeInteger(buffer.byteLength)||buffer.byteLength<0||buffer.byteLength>64*MiB)throw Error('Буфер анимации больше 64 МиБ');total+=buffer.byteLength;if(total>64*MiB)throw Error('Буферы выбранной анимации превышают 64 МиБ');
   checkSignal(signal);
   if(buffer.uri?.startsWith('data:'))continue;
   const data=index===0&&!buffer.uri&&bin?bin:await entry.resource(buffer.uri||'');checkSignal(signal);if(data.length<buffer.byteLength)throw Error('BIN короче заявленного размера');
   const url=URL.createObjectURL(new Blob([data]));urls.push(url);buffer.uri=url;
  }
  const manager=new THREE.LoadingManager();manager.setURLModifier(url=>{if(url.startsWith('blob:')||url.startsWith('data:'))return url;throw Error('Внешняя загрузка запрещена: '+url)});
  const loader=createModelLoader(manager);try{const loaded=await loader.parseAsync(JSON.stringify(json),'');checkSignal(signal);return skeletonMotionSource(loaded.scene,loaded.animations,entry.format)}finally{loader.disposeCodecs?.()}
 }finally{for(const url of urls)URL.revokeObjectURL(url)}
}
export async function loadMotionSource(entry,{memoryBudgetMiB=384,signal}={}){
 checkSignal(signal);
 const estimate=Math.ceil(entry.size*(entry.format==='fbx'?8:4)/MiB+32);if(entry.size>64*MiB||!Number.isFinite(memoryBudgetMiB)||memoryBudgetMiB<64||estimate>memoryBudgetMiB)throw Error('Источник анимации требует примерно '+estimate+' МиБ. Выбери облегчённый файл со скелетом.');
 const bytes=await entry.read({signal});checkSignal(signal);if(bytes.length!==entry.size)throw Error('Размер файла анимации не совпал');
 if(entry.format==='bvh'){const result=parseBvhForRetarget(new TextDecoder().decode(bytes),entry.path.replace(/^.*\//,'').replace(/\.bvh$/i,''));if(result.skeleton.bones.filter(b=>b.name!=='ENDSITE').length>200)throw Error('BVH содержит больше 200 костей');return {...result,kind:'bvh',clips:[result.clip],warnings:[]}}
 if(['glb','gltf'].includes(entry.format)){const source=await gltfMotion(bytes,entry,signal);if(entry.embedded&&entry.title)source.clip.name=entry.title;return source}
 if(entry.format!=='fbx')throw Error('Неподдерживаемый источник анимации');
 inspectFbx(bytes);return importFbxMotion(bytes,{signal});
}

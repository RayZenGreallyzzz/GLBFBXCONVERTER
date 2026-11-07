import * as THREE from 'three';
function unpack(data){const root=new THREE.Group(),bones=data.bones.map(b=>{const n=new THREE.Bone();n.name=b.name;n.position.fromArray(b.position);n.quaternion.fromArray(b.quaternion);n.scale.fromArray(b.scale);return n});data.bones.forEach((b,i)=>(b.parent<0?root:bones[b.parent]).add(bones[i]));root.updateMatrixWorld(true);
 const clips=data.clips.map(c=>new THREE.AnimationClip(c.name,c.duration,c.tracks.map(t=>new (t.type==='quaternion'?THREE.QuaternionKeyframeTrack:THREE.VectorKeyframeTrack)(t.name,t.times,t.values,t.interpolation))));return {kind:'fbx',root,skeleton:new THREE.Skeleton(bones),clips,clip:clips[0],warnings:data.warnings};
}
export async function importFbxMotion(bytes,{signal}={}){
 const abort=()=>Object.assign(Error('Просмотр FBX отменён'),{name:'AbortError'});if(signal?.aborted)throw abort();
 if(typeof Worker==='undefined'){const {parseFbxMotion}=await import('./fbx-motion-core.js');if(signal?.aborted)throw abort();return unpack(parseFbxMotion(bytes))}
 return new Promise((resolve,reject)=>{let worker,timer,done=false;const onAbort=()=>finish(abort()),finish=(error,data)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);worker?.terminate();if(error)reject(error);else try{resolve(unpack(data))}catch(e){reject(e)}};
  try{worker=new Worker(new URL('./fbx-motion-worker.js',import.meta.url),{type:'module'});worker.onmessage=({data})=>finish(data.error?Error(data.error):null,data.source);worker.onerror=e=>finish(Error('Ошибка обработчика FBX: '+(e.message||'')));signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted){onAbort();return}timer=setTimeout(()=>finish(Error('Импорт FBX занял больше 2 минут. Выбери облегчённый файл анимации.')),120000);worker.postMessage({bytes},[bytes.buffer])}catch(e){finish(e)}
 });
}

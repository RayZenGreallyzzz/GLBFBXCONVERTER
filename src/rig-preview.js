import * as THREE from 'three';

// Reuse source textures: decoding a second 8K set just for comparison would
// multiply the Android CPU/GPU peak. Prepared GLB bytes remain independent.
export function makeRigPreview(source,associations,payload){
 const lookup=new Map();
 source.traverse(obj=>{if(!obj.isMesh)return;const primitive=associations?.get(obj)?.primitives??0;let node=obj,nodeIndex;
  while(node&&nodeIndex===undefined){nodeIndex=associations?.get(node)?.nodes;node=node.parent}
  if(nodeIndex!==undefined){const key=nodeIndex+':'+primitive;if(lookup.has(key))throw Error('Неоднозначная часть просмотра скелета');lookup.set(key,obj)}
 });
 const root=new THREE.Group();root.name='Phoenix Rig';root.userData.phoenixSharedTextures=true;
 const bones=new Map(payload.bones.map(b=>{const node=new THREE.Bone();node.name=b.name;node.position.fromArray(b.translation);node.quaternion.fromArray(b.rotation);return [b.name,node]}));
 for(const b of payload.bones){const node=bones.get(b.name);if(b.parent)bones.get(b.parent).add(node);else root.add(node)}
 root.updateMatrixWorld(true);const skeleton=new THREE.Skeleton([...bones.values()]),materials=new Map();
 const cloneMaterial=m=>{if(!m)return m;if(!materials.has(m))materials.set(m,m.clone());return materials.get(m)};
 try{
  for(const part of payload.parts){
   const original=lookup.get(part.node+':'+part.primitive);if(!original||original.geometry.getAttribute('position').count!==part.positions.length/3)throw Error('Части исходника и скелета не совпали');
   const geometry=original.geometry.clone();geometry.setAttribute('position',new THREE.BufferAttribute(part.positions,3));geometry.setIndex(new THREE.BufferAttribute(part.indices,1));
   if(part.normals)geometry.setAttribute('normal',new THREE.BufferAttribute(part.normals,3));if(part.tangents)geometry.setAttribute('tangent',new THREE.BufferAttribute(part.tangents,4));
   geometry.setAttribute('skinIndex',new THREE.BufferAttribute(part.skinIndices,4));geometry.setAttribute('skinWeight',new THREE.BufferAttribute(part.skinWeights,4));geometry.computeBoundingBox();geometry.computeBoundingSphere();
   const material=Array.isArray(original.material)?original.material.map(cloneMaterial):cloneMaterial(original.material),mesh=new THREE.SkinnedMesh(geometry,material);mesh.name=original.name;mesh.frustumCulled=false;root.add(mesh);mesh.bind(skeleton,new THREE.Matrix4());
  }root.updateMatrixWorld(true);return root;
 }catch(e){root.traverse(n=>{if(n.isMesh)n.geometry.dispose()});for(const m of materials.values())m.dispose();skeleton.dispose();throw e}
}

export function rigBendTestClip(root){
 const tracks=[],times=new Float32Array([0,.5,1,1.5,2]);
 for(const [name,axis,angle]of [['LeftArm','z',.45],['RightArm','z',-.45],['LeftForeArm','z',.85],['RightForeArm','z',-.85],['LeftLeg','x',-.4],['RightLeg','x',-.4]]){
  const bone=root.getObjectByName('mixamorig'+name);if(!bone)continue;
  const values=[],v=new THREE.Vector3(axis==='x'?1:0,0,axis==='z'?1:0);for(const amount of [0,.5,1,.5,0])bone.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(v,angle*amount)).toArray(values,values.length);
  tracks.push(new THREE.QuaternionKeyframeTrack(bone.name+'.quaternion',times.slice(),new Float32Array(values)));
 }return new THREE.AnimationClip('Проверка сгибов',2,tracks);
}

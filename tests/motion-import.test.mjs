import test from 'node:test';import assert from 'node:assert/strict';import * as THREE from 'three';
import {WebIO} from '@gltf-transform/core';import {FBXExporter} from '@comfyorg/fbx-exporter-three';import {zipSync,strToU8} from 'fflate';
import {openMotionPack} from '../src/motion-pack.js';import {loadMotionSource,skeletonMotionSource} from '../src/motion-import.js';import {suggestBoneMappings} from '../src/animation-retarget.js';import {autoAdaptBvhClip} from '../src/bvh-auto-adapt.js';
import {motionFixture,motionBvh,namedBlob} from './helpers/motion-fixture.mjs';
globalThis.ProgressEvent??=class{constructor(type,values){this.type=type;Object.assign(this,values)}};
function target(){const root=new THREE.Group(),hips=new THREE.Bone(),arm=new THREE.Bone();hips.name='mixamorigHips';arm.name='mixamorigArm';arm.position.y=1;arm.rotation.z=.1;hips.add(arm);root.add(hips);const mesh=new THREE.SkinnedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());root.add(mesh);root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([hips,arm]));return {root,hips,arm}}
test('GLB and glTF+BIN import all skeletal clips without image requests; rest reference preserves the first posed frame',async()=>{
 const {doc,bytes}=await motionFixture(),json=await new WebIO().writeJSON(doc);json.json.images=[{uri:'https://example.invalid/huge.png'}];
 const archive=zipSync({'gltf/walk.gltf':strToU8(JSON.stringify(json.json)),...Object.fromEntries(Object.entries(json.resources).map(([name,b])=>['gltf/'+name,b]))});
 const pack=await openMotionPack([namedBlob('body.glb',bytes),namedBlob('pack.zip',archive)]);
 for(const entry of pack){const source=await loadMotionSource(entry);assert.deepEqual(source.clips.map(c=>c.name),['Idle','Walk']);let meshes=0;source.root.traverse(n=>{if(n.isMesh)meshes++});assert.equal(meshes,0);
  const rig=target(),before=source.skeleton.bones.map(b=>b.quaternion.toArray()),mapping=suggestBoneMappings(source.skeleton,rig.root),clip=autoAdaptBvhClip({targetRoot:rig.root,sourceSkeleton:source.skeleton,sourceClip:source.clip,mappings:mapping.mappings,referencePose:'rest',trimCalibration:true,alignAxes:false,name:'Первое движение'});
  assert.equal(clip.userData.calibrationFrameRemoved,false);const track=clip.tracks.find(t=>t.name===rig.arm.name+'.quaternion');const q=new THREE.Quaternion().fromArray(track.values);assert.ok(q.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),.6))<1e-5,'first source pose must survive');assert.equal(clip.name,'Первое движение');assert.deepEqual(source.skeleton.bones.map(b=>b.quaternion.toArray()),before);assert.ok(Math.abs(track.times.at(-1)-1)<1e-5);
 }
});
test('real FBX file with two takes imports as a mesh-free skeleton',async()=>{
 const {root,arm}=target();root.name='Source';const times=[0,1],q=a=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),a).toArray();const clips=['Idle','Run'].map((name,i)=>new THREE.AnimationClip(name,1,[new THREE.QuaternionKeyframeTrack(arm.uuid+'.quaternion',times,[...q(.1),...q(.4+i*.1)])]));
 // Give the FBX writer a valid one-joint vertex binding.
 root.traverse(n=>{if(n.isMesh){const count=n.geometry.attributes.position.count;n.geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(count*4),4));const weights=new Float32Array(count*4);for(let i=0;i<count;i++)weights[i*4]=1;n.geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4))}});
 const data=await new FBXExporter().parseAsync(root,{version:7400,preset:'threejs',animations:clips,embedTextures:false,fps:30});const [entry]=await openMotionPack([namedBlob('source.fbx',data)]);const source=await loadMotionSource(entry);assert.equal(source.kind,'fbx');assert.equal(source.clips.length,2);assert.ok(source.skeleton.bones.length>=2);source.root.traverse(n=>assert.ok(!n.isMesh));
});
test('model root motion includes a scaled animated armature; source and target remain in rest pose',()=>{
 const root=new THREE.Group();root.name='Armature';root.scale.setScalar(.01);const hips=new THREE.Bone();hips.name='Hips';const arm=new THREE.Bone();arm.name='Arm';arm.position.y=100;hips.add(arm);root.add(hips);
 const source=skeletonMotionSource(root,[new THREE.AnimationClip('Move',1,[new THREE.QuaternionKeyframeTrack('Arm.quaternion',[0,1],[0,0,0,1,0,0,0,1]),new THREE.VectorKeyframeTrack('Armature.position',[0,1],[0,0,0,2,0,0])])],'fbx'),rig=target(),mapping=suggestBoneMappings(source.skeleton,rig.root);
 const result=autoAdaptBvhClip({targetRoot:rig.root,sourceSkeleton:source.skeleton,sourceClip:source.clip,mappings:mapping.mappings,referencePose:'rest',rootMotion:true,autoScale:false,alignAxes:false});const position=result.tracks.find(t=>t.name==='mixamorigHips.position');assert.ok(Math.abs(position.values.at(-3)-2)<1e-5);assert.deepEqual(root.position.toArray(),[0,0,0]);assert.deepEqual(rig.hips.position.toArray(),[0,0,0]);
});
test('mixed pack keeps BVH usable and reports static, missing-resource and changing-scale sources',async()=>{
 const {doc}=await motionFixture();for(const a of doc.getRoot().listAnimations())a.dispose();const staticBytes=await new WebIO().writeBinary(doc),pack=await openMotionPack([namedBlob('Idle.bvh',motionBvh),namedBlob('static.glb',staticBytes)]);
 assert.equal((await loadMotionSource(pack[0])).kind,'bvh');await assert.rejects(loadMotionSource(pack[1]),/нет анимации/);
 const root=new THREE.Group(),hips=new THREE.Bone();hips.name='Hips';root.add(hips);assert.throws(()=>skeletonMotionSource(root,[new THREE.AnimationClip('Invalid',1,[new THREE.QuaternionKeyframeTrack('Hips.quaternion',[0,1],[0,0,0,1,0,0,0,1]),new THREE.VectorKeyframeTrack('Hips.scale',[0,1],[1,1,1,2,2,2])])],'glb'),/меняется масштаб/);
});

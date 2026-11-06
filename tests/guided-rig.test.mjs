import test from 'node:test';
import assert from 'node:assert/strict';
import {WebIO} from '@gltf-transform/core';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import validator from 'gltf-validator';
import {buildGuidedRig,rigPreflight} from '../src/guided-rig.js';
import {makeRigPreview,rigBendTestClip} from '../src/rig-preview.js';
import {rigFixture} from './helpers/rig-fixture.mjs';
import {compressionFixture} from './helpers/compression-fixtures.mjs';
import {startGuidedRig} from '../src/guided-rig-client.js';

async function runtime(bytes){const io=new WebIO(),d=await io.readBinary(bytes);for(const m of d.getRoot().listMaterials())m.dispose();for(const t of d.getRoot().listTextures())t.dispose();const copy=await io.writeBinary(d);return new GLTFLoader().parseAsync(copy.buffer.slice(copy.byteOffset,copy.byteOffset+copy.byteLength),'')}
for(const settings of [{scale:1},{scale:.01},{scale:100,mirror:true}])test('guided skeleton retains world rest geometry, images and valid skin; '+JSON.stringify(settings),async()=>{
 const texture=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
 const fixture=await rigFixture({...settings,texture}),source=fixture.bytes.slice(),result=await buildGuidedRig(source,{guides:fixture.guides,resolution:32});assert.deepEqual(source,fixture.bytes);assert.equal(result.bones,27);assert.equal(result.sourceTriangles,result.optimizedTriangles);
 const io=new WebIO(),before=await io.readBinary(source),after=await io.readBinary(result.bytes);assert.deepEqual(after.getRoot().listTextures()[0].getImage(),before.getRoot().listTextures()[0].getImage());assert.equal(after.getRoot().listMeshes().length,1);
 const report=await validator.validateBytes(result.bytes,{maxIssues:20});assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));assert.ok(!report.issues.messages.some(m=>m.code==='NODE_SKINNED_MESH_NON_ROOT'));
 const a=await runtime(source),b=await runtime(result.bytes);a.scene.updateMatrixWorld(true);b.scene.updateMatrixWorld(true);let old,mesh;a.scene.traverse(n=>{if(n.isMesh)old=n});b.scene.traverse(n=>{if(n.isSkinnedMesh)mesh=n});assert.equal(mesh.skeleton.bones.length,27);mesh.skeleton.update();
 const p=old.geometry.attributes.position;for(let i=0;i<p.count;i+=7){const x=new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(old.matrixWorld),y=mesh.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);assert.ok(x.distanceTo(y)<Math.max(1,settings.scale)*1e-5,'bind pose changed')}
 const weights=mesh.geometry.attributes.skinWeight;for(let i=0;i<weights.count;i++){let sum=0;for(const get of ['getX','getY','getZ','getW']){const w=weights[get](i);assert.ok(Number.isFinite(w)&&w>=0);sum+=w}assert.ok(Math.abs(sum-1)<1e-5)}
 const originalLoaded=await runtime(source),preview=makeRigPreview(originalLoaded.scene,originalLoaded.parser.associations,result.preview);preview.updateMatrixWorld(true);let skinned;preview.traverse(n=>{if(n.isSkinnedMesh)skinned=n});const rest=skinned.getVertexPosition(0,new THREE.Vector3());const mixer=new THREE.AnimationMixer(preview),clip=rigBendTestClip(preview);mixer.clipAction(clip).play();mixer.setTime(1);preview.updateMatrixWorld(true);skinned.skeleton.update();assert.ok(skinned.geometry.attributes.position.array.every(Number.isFinite));mixer.stopAllAction();mixer.uncacheRoot(preview);preview.updateMatrixWorld(true);skinned.skeleton.update();assert.ok(skinned.getVertexPosition(0,new THREE.Vector3()).distanceTo(rest)<1e-5*Math.max(1,settings.scale));
});
test('moving a forearm deforms its hand without pulling the opposite ankle; preview shares textures',async()=>{
 const f=await rigFixture(),result=await buildGuidedRig(f.bytes,{guides:f.guides,resolution:32}),bytes=result.bytes.slice(),loaded=await runtime(f.bytes);
 let source;loaded.scene.traverse(n=>{if(n.isMesh)source=n});const texture=new THREE.Texture();source.material.map=texture;
 const root=makeRigPreview(loaded.scene,loaded.parser.associations,result.preview);let mesh;root.traverse(n=>{if(n.isSkinnedMesh)mesh=n});
 assert.notEqual(mesh.material,source.material);assert.equal(mesh.material.map,texture,'no second texture/image decode');
 root.updateMatrixWorld(true);mesh.skeleton.update();
 const nearest=point=>{let best=Infinity,index=0;for(let i=0;i<mesh.geometry.attributes.position.count;i++){const d=mesh.getVertexPosition(i,new THREE.Vector3()).distanceToSquared(new THREE.Vector3(...point));if(d<best){best=d;index=i}}return index};
 const hand=nearest(f.guides.leftWrist),ankle=nearest(f.guides.rightAnkle),at=i=>mesh.getVertexPosition(i,new THREE.Vector3()),handRest=at(hand),ankleRest=at(ankle);
 const bone=root.getObjectByName('mixamorigLeftForeArm'),rest=bone.quaternion.clone();bone.rotateZ(.7);root.updateMatrixWorld(true);mesh.skeleton.update();
 assert.ok(at(hand).distanceTo(handRest)>.05,'forearm rotation must move the hand');assert.ok(at(ankle).distanceTo(ankleRest)<1e-5,'opposite leg must remain independent');
 bone.quaternion.copy(rest);root.updateMatrixWorld(true);mesh.skeleton.update();assert.ok(at(hand).distanceTo(handRest)<1e-5);assert.deepEqual(result.bytes,bytes,'motion review must not rewrite prepared GLB');
});
test('rig worker cancellation and errors terminate the worker and preserve the original buffer',async()=>{
 const previous=globalThis.Worker,workers=[],source=new Uint8Array([1,2,3,4]);
 globalThis.Worker=class{constructor(){workers.push(this)}postMessage(data,transfer){this.data=structuredClone(data,{transfer})}terminate(){this.terminated=true}};
 try{
  const job=startGuidedRig(source,{});assert.deepEqual(workers[0].data.bytes,source);job.cancel();await assert.rejects(job.promise,e=>e.name==='AbortError');assert.equal(workers[0].terminated,true);assert.deepEqual([...source],[1,2,3,4]);workers[0].onmessage({data:{result:{bytes:new Uint8Array([9])}}});
  const failed=startGuidedRig(source,{});workers[1].onerror({message:'test error'});await assert.rejects(failed.promise,/test error/);assert.equal(workers[1].terminated,true);assert.equal(source.byteLength,4);
  globalThis.Worker=class{postMessage(){throw Error('transfer failed')}terminate(){this.terminated=true;workers.push(this)}};
  await assert.rejects(startGuidedRig(source,{}).promise,/transfer failed/);assert.equal(workers[2].terminated,true);
 }finally{globalThis.Worker=previous}
});
test('rigging rejects existing skins, missing guides and insufficient memory without touching source',async()=>{
 const rigged=await compressionFixture(),copy=rigged.slice();assert.throws(()=>rigPreflight(rigged),/без скелета/);assert.deepEqual(rigged,copy);
 const f=await rigFixture();await assert.rejects(buildGuidedRig(f.bytes,{guides:{}}),/точку/);assert.throws(()=>rigPreflight(f.bytes,{memoryBudgetMiB:64,resolution:64}),/память/);
 const changed=structuredClone(f.guides);changed.leftWrist=[NaN,0,0];await assert.rejects(buildGuidedRig(f.bytes,{guides:changed}),/точку/);
});

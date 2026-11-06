import test from 'node:test';
import assert from 'node:assert/strict';
import {WebIO} from '@gltf-transform/core';
import {cloneDocument} from '@gltf-transform/functions';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import validator from 'gltf-validator';
import {buildGuidedRig,rigPreflight} from '../src/guided-rig.js';
import {makeRigPreview,rigBendTestClip} from '../src/rig-preview.js';
import {rigFixture} from './helpers/rig-fixture.mjs';
import {compressionFixture} from './helpers/compression-fixtures.mjs';

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
test('rigging rejects existing skins, missing guides and insufficient memory without touching source',async()=>{
 const rigged=await compressionFixture(),copy=rigged.slice();assert.throws(()=>rigPreflight(rigged),/без скелета/);assert.deepEqual(rigged,copy);
 const f=await rigFixture();await assert.rejects(buildGuidedRig(f.bytes,{guides:{}}),/точку/);assert.throws(()=>rigPreflight(f.bytes,{memoryBudgetMiB:64,resolution:64}),/память/);
 const changed=structuredClone(f.guides);changed.leftWrist=[NaN,0,0];await assert.rejects(buildGuidedRig(f.bytes,{guides:changed}),/точку/);
});

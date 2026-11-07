import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {WebIO,Accessor} from '@gltf-transform/core';
import {motionFixture,namedBlob} from './helpers/motion-fixture.mjs';
import {openMotionPack} from '../src/motion-pack.js';
import {loadMotionSource,skeletonMotionSource} from '../src/motion-import.js';
import {createMotionVisual} from '../src/motion-visual.js';
import {suggestBoneMappings} from '../src/animation-retarget.js';
import {autoAdaptBvhClip} from '../src/bvh-auto-adapt.js';
globalThis.ProgressEvent??=class{constructor(type,values){Object.assign(this,values)}};

function source(scale=[1,1,1]){
 const root=new THREE.Group();root.name='Armature';const hips=new THREE.Bone(),arm=new THREE.Bone();hips.name='Hips';arm.name='Arm';arm.position.y=1;arm.scale.fromArray(scale);hips.add(arm);root.add(hips);
 const clip=new THREE.AnimationClip('Move',1,[new THREE.QuaternionKeyframeTrack('Arm.quaternion',[0,1],[0,0,0,1,0,0,.5,Math.sqrt(.75)])]);return {root,hips,arm,clip};
}
test('Mixamo-sized rounding noise is normalized only in the private motion graph',()=>{
 const input=source([1.0000003576278687,.9999998807907104,1.0000154972076416]),before=input.arm.scale.toArray(),keys=input.clip.tracks[0].values.slice();
 const result=skeletonMotionSource(input.root,[input.clip],'glb'),copy=result.root.getObjectByName('Arm');assert.ok(Math.abs(copy.scale.x-1)<1e-5);assert.equal(copy.scale.x,copy.scale.y);assert.equal(copy.scale.x,copy.scale.z);assert.deepEqual(input.arm.scale.toArray(),before);assert.deepEqual(input.clip.tracks[0].values,keys);assert.ok(createMotionVisual(result).values.every(Number.isFinite));
});
test('rounding tolerance is relative to units and constant scale channels use the same policy',()=>{
 for(const unit of [1e-6,.01,1,100]){
  const input=source([unit,unit*(1-1e-5),unit*(1+1.6e-5)]),values=[...input.arm.scale,...input.arm.scale.clone().multiplyScalar(1+1e-6)];input.clip.tracks.push(new THREE.VectorKeyframeTrack('Arm.scale',[0,1],values));
  const result=skeletonMotionSource(input.root,[input.clip],'fbx'),copy=result.root.getObjectByName('Arm');assert.ok(Math.abs(copy.scale.x/unit-1)<1e-5);assert.equal(result.clip.tracks.length,1,'a constant scale track must not become animated scale');
 }
});
test('nonuniform, mirrored, zero and genuinely animated scales still fail with useful source details',()=>{
 for(const scale of [[1,1.01,1],[-1,1,1],[1,0,1],[1e-6,-1e-6,1e-6],[.01,.01001,.01],[NaN,1,1]]){
  const input=source(scale);assert.throws(()=>skeletonMotionSource(input.root,[input.clip],'glb'),e=>/положительный равномерный/.test(e.message)&&/Arm/.test(e.message));
 }
 const input=source();input.clip.tracks.push(new THREE.VectorKeyframeTrack('Arm.scale',[0,1],[1,1,1,1.001,1.001,1.001]));assert.throws(()=>skeletonMotionSource(input.root,[input.clip],'glb'),/меняется масштаб/);
});
test('noisy GLB with centimeter armature previews and retargets root motion in correct units',async()=>{
 const {doc}=await motionFixture(),group=doc.getRoot().listNodes().find(n=>n.getName()==='Armature'),arm=doc.getRoot().listNodes().find(n=>n.getName()==='Arm'),hips=doc.getRoot().listNodes().find(n=>n.getName()==='Hips');group.setScale([.01,.01,.01]);arm.setScale([1.0000003576278687,.9999998807907104,1.0000154972076416]);
 const buffer=doc.getRoot().listBuffers()[0],acc=(array,type)=>doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(array)),sampler=doc.createAnimationSampler().setInput(acc([0,1],Accessor.Type.SCALAR)).setOutput(acc([0,0,0,50,0,0],Accessor.Type.VEC3)),channel=doc.createAnimationChannel().setSampler(sampler).setTargetNode(hips).setTargetPath('translation');doc.getRoot().listAnimations()[0].addSampler(sampler).addChannel(channel);
 const bytes=await new WebIO().writeBinary(doc),original=bytes.slice(),[entry]=await openMotionPack([namedBlob('rounding.glb',bytes)]),loaded=await loadMotionSource(entry);assert.equal(loaded.clips.length,2);assert.ok(createMotionVisual(loaded).values.every(Number.isFinite));
 const target=new THREE.Group(),targetHips=new THREE.Bone(),targetArm=new THREE.Bone();targetHips.name='mixamorigHips';targetArm.name='mixamorigArm';targetArm.position.y=1;targetHips.add(targetArm);target.add(targetHips);
 const mesh=new THREE.SkinnedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());target.add(mesh);target.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([targetHips,targetArm]));
 const mapping=suggestBoneMappings(loaded.skeleton,target),clip=autoAdaptBvhClip({targetRoot:target,sourceSkeleton:loaded.skeleton,sourceClip:loaded.clip,mappings:mapping.mappings,referencePose:'rest',rootMotion:true,autoScale:false,alignAxes:false}),position=clip.tracks.find(t=>t.name==='mixamorigHips.position');assert.ok(Math.abs(position.values.at(-3)-.5)<1e-5);assert.ok(clip.tracks.every(t=>t.values.every(Number.isFinite)));assert.deepEqual(bytes,original);assert.deepEqual(targetHips.position.toArray(),[0,0,0]);
});

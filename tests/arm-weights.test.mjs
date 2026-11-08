import test from 'node:test';import assert from 'node:assert/strict';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';import * as THREE from 'three';import validator from 'gltf-validator';
import {localizeArmWeights} from '../src/arm-weights.js';import {repairArmWeights,armRepairEligibility} from '../src/arm-weight-repair.js';import {makeArmWeightsPreview} from '../src/rig-preview.js';import {inspectGlb} from '../src/format.js';import {armRepairFixture} from './helpers/arm-repair-fixture.mjs';
globalThis.ProgressEvent??=class{constructor(t,v){this.type=t;Object.assign(this,v)}};
const joints=[];for(const side of ['Left','Right'])for(const [part,x]of [['Shoulder',-.25],['Arm',0],['ForeArm',1],['Hand',2],['HandEnd',2.22]])joints.push({name:'mixamorig'+side+part,position:[side==='Left'?x:-x,0,0]});joints.push({name:'Hips',position:[0,-1,0]});
const weightsAt=(r,n,id)=>{let w=0;for(let k=0;k<4;k++)if(r.skinIndices[n*4+k]===id)w+=r.skinWeights[n*4+k];return w};
test('arm refinement isolates muscle bellies and distal hands while preserving other surfaces',()=>{
 const positions=new Float32Array([.5,.1,0,1.5,.1,0,2.5,.1,0,-2.5,.1,0,0,-1,0]),indices=new Uint16Array([1,2,3,0,1,2,3,0,1,2,3,0,6,7,8,5,10,0,0,0]),weights=new Float32Array([.4,.3,.2,.1,.4,.3,.2,.1,.4,.3,.2,.1,.4,.3,.2,.1,1,0,0,0]),before=weights.slice(),r=localizeArmWeights(positions,indices,weights,joints);
 for(const [n,id]of [[0,1],[1,2],[2,3],[3,8]])assert.ok(weightsAt(r,n,id)>.99999);
 assert.deepEqual(r.skinWeights.slice(16),weights.slice(16));assert.deepEqual(r.skinIndices.slice(16),indices.slice(16));assert.deepEqual(weights,before);
});
test('elbow/wrist transitions are continuous and invariant to character placement and scale',()=>{
 const n=1001,p=new Float64Array(n*3),I=new Uint16Array(n*4),W=new Float32Array(n*4);for(let i=0;i<n;i++){p[i*3]=.6+i*.0022;p[i*3+1]=.03;I.set([1,2,3,0],i*4);W.set([.4,.3,.2,.1],i*4)}const a=localizeArmWeights(p,I,W,joints);
 for(let i=1;i<n;i++)for(const id of [0,1,2,3])assert.ok(Math.abs(weightsAt(a,i,id)-weightsAt(a,i-1,id))<.03);
 for(const scale of [.01,100]){const transform=v=>[5-v[1]*scale,-2+v[0]*scale,v[2]*scale],j=joints.map(b=>({...b,position:transform(b.position)})),pp=new Float64Array(p.length);for(let i=0;i<n;i++)pp.set(transform(Array.from(p.slice(i*3,i*3+3))),i*3);const b=localizeArmWeights(pp,I,W,j);for(let i=0;i<n;i++)for(const id of [0,1,2,3])assert.ok(Math.abs(weightsAt(a,i,id)-weightsAt(b,i,id))<1e-5)}
});
let fixture;const source=()=>fixture??=(armRepairFixture());
function bin(bytes){let at=12;const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);while(at<bytes.length){const n=v.getUint32(at,true);if(v.getUint32(at+4,true)===0x004e4942)return bytes.slice(at+8,at+8+n);at+=8+n}}
test('legacy GLB repair changes only joint/weight bytes and its repair marker, preserving animation and geometry',async()=>{
 const {bytes}=await source(),copy=bytes.slice(),r=repairArmWeights(bytes),before=inspectGlb(bytes).json,after=inspectGlb(r.bytes).json;assert.ok(r.changedVertices>0);assert.deepEqual(bytes,copy);assert.equal(after.extras.phoenixRig.armLocalWeights,1);delete after.extras.phoenixRig.armLocalWeights;assert.deepEqual(after,before);
 const a=bin(bytes),b=bin(r.bytes),allowed=new Uint8Array(a.length);assert.equal(a.length,b.length);
 for(const mesh of before.meshes)for(const p of mesh.primitives)for(const semantic of ['JOINTS_0','WEIGHTS_0']){const acc=before.accessors[p.attributes[semantic]],v=before.bufferViews[acc.bufferView],size=acc.componentType===5126?4:acc.componentType===5123?2:1;for(let i=0;i<acc.count;i++)allowed.fill(1,(v.byteOffset||0)+(acc.byteOffset||0)+i*(v.byteStride||4*size),(v.byteOffset||0)+(acc.byteOffset||0)+i*(v.byteStride||4*size)+4*size)}
 for(let i=0;i<a.length;i++)if(!allowed[i])assert.equal(b[i],a[i],'unexpected changed byte '+i);
 const report=await validator.validateBytes(r.bytes,{maxIssues:20});assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));assert.equal(armRepairEligibility(r.bytes).eligible,false);assert.throws(()=>repairArmWeights(r.bytes),/уже/);assert.throws(()=>repairArmWeights(bytes,{memoryBudgetMiB:1}),/МиБ/);
});
test('weight preview clones bones/geometry, shares textures, and matches the saved GLB while playing',async()=>{
 const {bytes}=await source(),r=repairArmWeights(bytes),loader=new GLTFLoader(),old=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),''),fixed=await loader.parseAsync(r.bytes.buffer,''),preview=makeArmWeightsPreview(old.scene,old.parser.associations,r.preview);let original,changed,saved;old.scene.traverse(n=>{if(n.isSkinnedMesh)original=n});preview.traverse(n=>{if(n.isSkinnedMesh)changed=n});fixed.scene.traverse(n=>{if(n.isSkinnedMesh)saved=n});assert.notEqual(original.geometry,changed.geometry);assert.notEqual(original.skeleton.bones[0],changed.skeleton.bones[0]);assert.equal(original.material.map,changed.material.map);
 const mixers=[old.scene,preview,fixed.scene].map(root=>{const m=new THREE.AnimationMixer(root);m.clipAction(old.animations[0]).play();m.setTime(1);root.updateMatrixWorld(true);return m});for(const m of [original,changed,saved])m.skeleton.update();let moved=0;for(let i=0;i<changed.geometry.attributes.position.count;i+=11){const a=changed.getVertexPosition(i,new THREE.Vector3()),b=saved.getVertexPosition(i,new THREE.Vector3()),c=original.getVertexPosition(i,new THREE.Vector3());assert.ok(a.distanceTo(b)<1e-5);if(a.distanceTo(c)>.001)moved++}assert.ok(moved>0);mixers.forEach(m=>m.stopAllAction());
});

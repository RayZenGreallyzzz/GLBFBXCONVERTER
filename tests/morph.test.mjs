import test from 'node:test';
import assert from 'node:assert/strict';
import {WebIO} from '@gltf-transform/core';
import {optimizeGlb} from '../src/glb-optimize.js';
import {captureMorphs,assertMorphMetadata,morphLocks,inspectMorphJson} from '../src/morph-policy.js';
import {morphFixture} from './helpers/morph-fixture.mjs';
import validator from 'gltf-validator';
import {prepareBakeGlb} from '../src/bake-prepare.js';
import {projectBakeGlb} from '../src/bake-project.js';
import {PNG} from 'pngjs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ModelPlayback} from '../src/model-playback.js';
import {cloneDocument} from '@gltf-transform/functions';
function rows(prim){const pos=prim.getAttribute('POSITION').getArray(),map=new Map();for(let i=0;i<pos.length/3;i++)map.set(Array.from(pos.subarray(i*3,i*3+3)).join(','),prim.listTargets().map(t=>t.listSemantics().map(s=>[s,...t.getAttribute(s).getArray().subarray(i*3,i*3+3)])));return map}
for(const rigged of [false,true])test('safe NPC simplification preserves morph deltas, defaults and all interpolation modes; rigged='+rigged,async()=>{
 const source=await morphFixture({rigged,tangents:true,sparse:true,instance:true}),copy=source.slice(),io=new WebIO(),before=await io.readBinary(source),snapshot=captureMorphs(before),result=await optimizeGlb(source,{targetTriangles:1000,error:.02,geometry:true,textures:false,animationKeys:true});
 assert.deepEqual(source,copy);assert.ok(result.optimizedTriangles<result.sourceTriangles);assert.equal(result.unchanged,false);const after=await io.readBinary(result.bytes);assertMorphMetadata(snapshot,after);
 const old=before.getRoot().listMeshes()[0].listPrimitives()[0],out=after.getRoot().listMeshes()[0].listPrimitives()[0],oldRows=rows(old),newRows=rows(out);for(const [key,value]of newRows)assert.deepEqual(value,oldRows.get(key));
 const locks=morphLocks(old),p=old.getAttribute('POSITION').getArray();for(let i=0;i<locks.length;i++)if(locks[i])assert.ok(newRows.has(Array.from(p.subarray(i*3,i*3+3)).join(',')),'facial vertex removed');
 assert.ok(!out.listSemantics().some(s=>s.startsWith('_PHOENIX_')));const report=await validator.validateBytes(result.bytes,{maxIssues:50});assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));
});
test('morph guards include expanded sparse size and inconsistent names before allocation',()=>{
 assert.throws(()=>inspectMorphJson({accessors:[{count:1000000,type:'VEC3'},{count:1000000,type:'VEC3',sparse:{count:1}}],meshes:[{primitives:[{attributes:{POSITION:0},targets:Array.from({length:12},()=>({POSITION:1}))}]}]}),/96 МиБ/);
 assert.throws(()=>inspectMorphJson({accessors:[{count:3,type:'VEC3'}],meshes:[{extras:{targetNames:['A','B']},primitives:[{attributes:{POSITION:0},targets:[{POSITION:0}]}]}]}),/названия/);
});
test('animation-only optimization preserves every morph row and its keyframes',async()=>{const source=await morphFixture(),result=await optimizeGlb(source,{geometry:false,textures:false,animationKeys:true}),a=await new WebIO().readBinary(source),b=await new WebIO().readBinary(result.bytes);assertMorphMetadata(captureMorphs(a),b);assert.deepEqual(rows(b.getRoot().listMeshes()[0].listPrimitives()[0]),rows(a.getRoot().listMeshes()[0].listPrimitives()[0]))});
const png=new Uint8Array(PNG.sync.write({width:1,height:1,data:Buffer.from([160,90,30,255])}));
const encodeImage=async({data,width,height})=>({image:new Uint8Array(PNG.sync.write({data:Buffer.from(data),width,height})),mimeType:'image/png'}),decodeImage=async t=>{const p=PNG.sync.read(Buffer.from(t.getImage()));return {data:p.data,width:p.width,height:p.height}};
async function runtime(document){const copy=cloneDocument(document);for(const m of copy.getRoot().listMaterials())m.dispose();for(const t of copy.getRoot().listTextures())t.dispose();const bytes=await new WebIO().writeBinary(copy);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')}
for(const rigged of [false,true])test('UV and detail bake preserve animated and combined expressions with skinning; rigged='+rigged,{timeout:120000},async()=>{
 const source=await morphFixture({rigged,tangents:true,sparse:true,texture:png}),io=new WebIO(),before=await io.readBinary(source),snapshot=captureMorphs(before),opts={targetTriangles:1000,error:.02,resolution:64,encodeImage,decodeImage,animationKeys:true};
 const prepared=await prepareBakeGlb(source,opts),result=await projectBakeGlb(source,prepared,opts),after=await io.readBinary(result.bytes);assert.ok(result.optimizedTriangles<result.sourceTriangles);assert.ok(result.bakeReports.every(r=>r.misses===0&&r.coverage>0));assertMorphMetadata(snapshot,after);
 const old=before.getRoot().listMeshes()[0].listPrimitives()[0],out=after.getRoot().listMeshes()[0].listPrimitives()[0],oldRows=rows(old);for(const [key,targets]of rows(out))for(let i=0;i<targets.length;i++)for(const attr of targets[i])if(attr[0]!=='TANGENT')assert.deepEqual(attr,oldRows.get(key)[i].find(a=>a[0]===attr[0]));
 const a=await runtime(before),b=await runtime(after),meshes=[];for(const loaded of [a,b]){let m;loaded.scene.traverse(n=>{if(n.isMesh)m=n});meshes.push(m)}const positions=meshes[0].geometry.attributes.position,lookup=new Map();for(let i=0;i<positions.count;i++)lookup.set([positions.getX(i),positions.getY(i),positions.getZ(i)].join(','),i);
 const compare=()=>{for(const m of meshes)m.skeleton?.update();const p=meshes[1].geometry.attributes.position;for(let i=0;i<p.count;i++){const old=lookup.get([p.getX(i),p.getY(i),p.getZ(i)].join(','));assert.notEqual(old,undefined);const x=meshes[0].getVertexPosition(old,new THREE.Vector3()).applyMatrix4(meshes[0].matrixWorld),y=meshes[1].getVertexPosition(i,new THREE.Vector3()).applyMatrix4(meshes[1].matrixWorld);assert.ok(x.distanceTo(y)<2e-5,'morph/skinned position changed')}};
 const player=new ModelPlayback();player.setModels(a.scene,a.animations,b.scene,b.animations);for(let clip=0;clip<a.animations.length;clip++){player.stop();player.play(clip);for(let i=0;i<8;i++){player.update(.1);compare()}}player.stop();for(const weights of [[0,0],[1,0],[0,1],[.5,.8],[-.25,1.2]]){for(const m of meshes)m.morphTargetInfluences.splice(0,2,...weights);compare()}player.dispose();
 assert.ok(!out.listSemantics().some(s=>s.startsWith('_PHOENIX_')));const report=await validator.validateBytes(result.bytes,{maxIssues:50});assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));
});

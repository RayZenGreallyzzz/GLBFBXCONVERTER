import test from 'node:test';
import assert from 'node:assert/strict';
import {WebIO} from '@gltf-transform/core';
import {optimizeGlb} from '../src/glb-optimize.js';
import {captureMorphs,assertMorphMetadata,morphLocks,inspectMorphJson,resampleWithMorphs} from '../src/morph-policy.js';
import {morphFixture} from './helpers/morph-fixture.mjs';
import validator from 'gltf-validator';
import {prepareBakeGlb} from '../src/bake-prepare.js';
import {projectBakeGlb} from '../src/bake-project.js';
import {PNG} from 'pngjs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {ModelPlayback} from '../src/model-playback.js';
import {cloneDocument} from '@gltf-transform/functions';
import {compressGlb} from '../src/glb-compression.js';
import {createCodecIO} from '../src/codec-io.js';
import {transportMorphTangents} from '../src/bake-morph.js';
import {inspectGlb} from '../src/format.js';
import {readBakeGlb} from '../src/bake-common.js';
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
test('fully affected shapes retain the exact original and cannot enter static low-memory baking',async()=>{
 const io=new WebIO(),doc=await io.readBinary(await morphFixture({rigged:false})),p=doc.getRoot().listMeshes()[0].listPrimitives()[0];
 for(const t of p.listTargets()){const a=t.getAttribute('POSITION');a.setArray(Float32Array.from(a.getArray(),(_,i)=>i%3===0?.01:0))}
 const source=await io.writeBinary(doc),copy=source.slice(),result=await optimizeGlb(source,{targetTriangles:100,error:.1,geometry:true,textures:false});
 assert.equal(result.unchanged,true);assert.deepEqual(result.bytes,copy);await assert.rejects(readBakeGlb(source,{lowMemory:true}),/без скелета и анимаций|Blend Shapes/);assert.deepEqual(source,copy);
});
test('malformed face key layouts and nonfinite decoded weights fail safely',async()=>{
 const source=await morphFixture(),json=inspectGlb(source).json,channel=json.animations.flatMap(a=>a.channels.map(c=>({a,c}))).find(({c})=>c.target.path==='weights'),sampler=channel.a.samplers[channel.c.sampler];
 json.accessors[sampler.output].count--;assert.throws(()=>inspectMorphJson(json),/анимация Blend Shapes/);
 const doc=await new WebIO().readBinary(source),face=doc.getRoot().listAnimations().flatMap(a=>a.listChannels()).find(c=>c.getTargetPath()==='weights');face.getSampler().getOutput().getArray()[0]=NaN;
 assert.throws(()=>captureMorphs(doc),/Нечисловое/);
});
test('animation-only optimization resamples bones but preserves every facial key and morph row',async()=>{
 const source=await morphFixture(),a=await new WebIO().readBinary(source),snapshot=captureMorphs(a),count=a.getRoot().listAnimations()[0].listSamplers()[0].getInput().getCount();
 await resampleWithMorphs(a);assert.ok(a.getRoot().listAnimations()[0].listSamplers()[0].getInput().getCount()<count);assertMorphMetadata(snapshot,a);
 const result=await optimizeGlb(source,{geometry:false,textures:false,animationKeys:true}),original=await new WebIO().readBinary(source),b=await new WebIO().readBinary(result.bytes);assertMorphMetadata(captureMorphs(original),b);assert.deepEqual(rows(b.getRoot().listMeshes()[0].listPrimitives()[0]),rows(original.getRoot().listMeshes()[0].listPrimitives()[0]));
});
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
test('UV frame transport preserves custom tangent-only expressions and exact zero deltas',()=>{
 const angle=.3,delta=new Float32Array([Math.cos(angle)-1,Math.sin(angle),0,0,0,0]);
 transportMorphTangents({normals:new Float32Array([0,0,1,0,0,1]),tangents:new Float32Array([1,0,0,1,1,0,0,1])},new Uint32Array([0,1]),new Float32Array([0,1,0,1,0,1,0,1]),{getAttribute:s=>s==='TANGENT'?{getArray:()=>delta}:null});
 assert.ok(Math.abs(delta[0]+Math.sin(angle))<1e-6);assert.ok(Math.abs(delta[1]-(Math.cos(angle)-1))<1e-6);assert.deepEqual(Array.from(delta.subarray(3)),[0,0,0]);
});
for(const codec of ['meshopt','draco'])test(codec+' preserves multiple distinct shapes, names, defaults and face keyframes',{timeout:120000},async()=>{
 const source=await morphFixture({tangents:true,sparse:true}),doc=await new WebIO().readBinary(source),meta=captureMorphs(doc),result=await compressGlb(source,{geometryCodec:codec}),io=await createCodecIO(result.bytes),after=await io.readBinary(result.bytes);assertMorphMetadata(meta,after);
 const a=doc.getRoot().listMeshes()[0].listPrimitives()[0],b=after.getRoot().listMeshes()[0].listPrimitives()[0],p=a.getAttribute('POSITION').getArray(),q=b.getAttribute('POSITION').getArray();
 for(let i=0;i<q.length/3;i++){
  let nearest=-1,distance=Infinity;for(let j=0;j<p.length/3;j++){const d=Math.hypot(p[j*3]-q[i*3],p[j*3+1]-q[i*3+1],p[j*3+2]-q[i*3+2]);if(d<distance){nearest=j;distance=d}}
  assert.ok(distance<1e-5);
  for(let t=0;t<2;t++)for(const semantic of ['POSITION','NORMAL','TANGENT']){const old=a.listTargets()[t].getAttribute(semantic).getArray(),current=b.listTargets()[t].getAttribute(semantic).getArray();for(let k=0;k<3;k++)assert.ok(Math.abs(old[nearest*3+k]-current[i*3+k])<1e-6,'codec mismatched morph rows')}
 }
 const report=await validator.validateBytes(result.bytes,{maxIssues:30});assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));
});

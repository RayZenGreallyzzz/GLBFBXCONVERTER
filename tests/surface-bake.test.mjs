import test from 'node:test';
import assert from 'node:assert/strict';
import {Document,WebIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import * as THREE from 'three';
import {PNG} from 'pngjs';
import validator from 'gltf-validator';
import {prepareBakeGlb} from '../src/bake-prepare.js';
import {projectBakeGlb} from '../src/bake-project.js';
import {primitiveGeometry} from '../src/bake-geometry.js';
import {projectBakePixels,sampleMap,padBakeMaps} from '../src/bake-pixels.js';
import {bakePlan,assertBakeRigPreserved,readBakeGlb} from '../src/bake-common.js';
import {bakeGlbOffThread} from '../src/surface-bake-client.js';
import {geometryHistory} from '../src/geometry-policy.js';
import {inspectGlb} from '../src/format.js';
import {compressionFixture} from './helpers/compression-fixtures.mjs';
const io=()=>new WebIO().registerExtensions(ALL_EXTENSIONS);
const encodeImage=async({data,width,height})=>({image:new Uint8Array(PNG.sync.write({data:Buffer.from(data),width,height})),mimeType:'image/png'});
const decodeImage=async t=>{const p=PNG.sync.read(Buffer.from(t.getImage()));return {data:p.data,width:p.width,height:p.height}};
const options={resolution:64,targetTriangles:300,error:.03,encodeImage,decodeImage};
async function sphere(){
 const doc=new Document(),buffer=doc.createBuffer(),g=new THREE.SphereGeometry(1,32,20),acc=(a,t)=>doc.createAccessor().setBuffer(buffer).setType(t).setArray(a);
 const p=doc.createPrimitive().setAttribute('POSITION',acc(g.attributes.position.array,'VEC3')).setAttribute('NORMAL',acc(g.attributes.normal.array,'VEC3')).setAttribute('TEXCOORD_0',acc(g.attributes.uv.array,'VEC2')).setIndices(acc(g.index.array,'SCALAR'));
 doc.createScene().addChild(doc.createNode('Static').setMesh(doc.createMesh().addPrimitive(p)));return {doc,prim:p,bytes:await io().writeBinary(doc)};
}
test('lower-poly surface receives new UV, geometric normal detail and portable maps',async()=>{
 const {bytes}=await sphere(),copy=bytes.slice(),prepared=await prepareBakeGlb(bytes,options);
 assert.equal(prepared.sourceTriangles,1216);assert.ok(prepared.optimizedTriangles<=300);
 const out=await projectBakeGlb(bytes,prepared,options);assert.deepEqual(bytes,copy);
 const validation=await validator.validateBytes(out.bytes,{maxIssues:100});
 assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues));
 assert.ok(out.bakeReports.every(r=>r.coverage>0&&r.misses===0&&r.coverage===r.projected));
 const doc=await io().readBinary(out.bytes),root=doc.getRoot(),p=root.listMeshes()[0].listPrimitives()[0];
 assert.ok(p.getAttribute('TANGENT'));assert.equal(root.listTextures().length,3);assert.equal(p.getMaterial().getNormalScale(),1);
 assert.equal(geometryHistory(inspectGlb(out.bytes).json.extras).surfaceBake.projectionMisses,0);
 const normal=await decodeImage(p.getMaterial().getNormalTexture());assert.equal(normal.width,64);
 assert.ok(normal.data.some((v,i)=>i%4<2&&Math.abs(v-128)>12),'curvature of the donor must reach its normal map');
 for(const v of p.getAttribute('TANGENT').getArray())assert.ok(Number.isFinite(v));
});
test('projection transfers source UV transforms, normal map and ORM without lighting',()=>{
 const d=new Document(),b=d.createBuffer(),acc=(a,t)=>d.createAccessor().setBuffer(b).setType(t).setArray(new Float32Array(a));
 const p=d.createPrimitive().setAttribute('POSITION',acc([0,0,.05,1,0,.05,1,1,.05,0,1,.05],'VEC3'))
  .setAttribute('NORMAL',acc([0,0,1,0,0,1,0,0,1,0,0,1],'VEC3')).setAttribute('TEXCOORD_0',acc([0,0,1/16,0,1/16,1/16,0,1/16],'VEC2'))
  .setIndices(d.createAccessor().setBuffer(b).setType('SCALAR').setArray(new Uint16Array([0,1,2,0,2,3])));
 const source=primitiveGeometry(p),positions=new Float32Array(source.positions);for(let i=2;i<positions.length;i+=3)positions[i]=0;
 const target={positions,normals:source.normals,uv:new Float32Array([.1,.1,.9,.1,.9,.9,.1,.9]),indices:source.indices,tangents:new Float32Array([1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1]),margin:2};
 const map=color=>({data:new Uint8Array(color),width:1,height:1,coord:0,matrix:[16,0,0,16,0,0]});
 const out=projectBakePixels(source,target,{size:32,projectionDistance:.1,maps:{base:map([120,80,210,255]),normal:map([128,190,238,255]),orm:map([10,80,180,255]),occlusion:map([36,0,0,255])}}),center=(16*32+16)*4;
 assert.deepEqual(Array.from(out.maps.base.slice(center,center+4)),[120,80,210,255]);assert.deepEqual(Array.from(out.maps.orm.slice(center,center+3)),[36,80,180]);
 assert.ok(out.maps.normal[center+1]>180);assert.equal(out.misses,0);
});
test('Mixamo with extra head/hips bones, weights and separate ear/tail clips survives',async()=>{
 const png=PNG.sync.write({width:1,height:1,data:Buffer.from([160,90,30,255])}),original=await compressionFixture({texture:new Uint8Array(png),textureMime:'image/png'});
 const doc=await io().readBinary(original),root=doc.getRoot(),skin=root.listSkins()[0],buffer=root.listBuffers()[0],hips=root.listNodes().find(n=>n.getName()==='Hips'),arm=root.listNodes().find(n=>n.getName()==='Arm');
 const head=doc.createNode('mixamorig:Head').setTranslation([0,.2,0]);arm.addChild(head);
 const tail=doc.createNode('Tail').setTranslation([0,.1,0]),tip=doc.createNode('TailTip');hips.addChild(tail);tail.addChild(tip);
 const left=doc.createNode('Ear.L'),right=doc.createNode('Ear.R');head.addChild(left).addChild(right);
 for(const n of [head,tail,tip,left,right])skin.addJoint(n);
 const matrices=new Float32Array(skin.listJoints().length*16);skin.listJoints().forEach((n,i)=>matrices.set(new THREE.Matrix4().fromArray(n.getWorldMatrix()).invert().elements,i*16));skin.getInverseBindMatrices().setArray(matrices);
 const prim=root.listMeshes()[0].listPrimitives()[0],j=prim.getAttribute('JOINTS_0').getArray(),w=prim.getAttribute('WEIGHTS_0').getArray();
 for(let i=0;i<j.length/4;i+=50){j[i*4]=5;w[i*4]=1;w[i*4+1]=0;}
 for(const [name,node]of [['Ears',left],['TailMotion',tail]]){
  const input=doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Float32Array([0,.5,1]));
  const output=doc.createAccessor().setBuffer(buffer).setType('VEC4').setArray(new Float32Array([0,0,0,1,0,0,Math.sin(.1),Math.cos(.1),0,0,0,1]));
  const sampler=doc.createAnimationSampler().setInput(input).setOutput(output);doc.createAnimation(name).addSampler(sampler).addChannel(doc.createAnimationChannel().setSampler(sampler).setTargetNode(node).setTargetPath('rotation'));
 }
 const source=await io().writeBinary(doc),opts={...options,targetTriangles:400,error:.12},prepared=await prepareBakeGlb(source,opts);assert.ok(prepared.optimizedTriangles<800);
 const result=await projectBakeGlb(source,prepared,opts),after=await io().readBinary(result.bytes);assertBakeRigPreserved(doc,after);
 assert.deepEqual(after.getRoot().listAnimations().map(a=>a.getName()),['Wave','Ears','TailMotion']);
 const tuples=p=>{
  const pos=p.getAttribute('POSITION').getArray(),j=p.getAttribute('JOINTS_0').getArray(),w=p.getAttribute('WEIGHTS_0').getArray(),m=new Map();
  for(let i=0;i<pos.length/3;i++)m.set(Array.from(pos.slice(i*3,i*3+3)).join(','),Array.from(j.slice(i*4,i*4+4)).concat(Array.from(w.slice(i*4,i*4+4))));return m;
 };
 const before=tuples(prim);for(const [key,value]of tuples(after.getRoot().listMeshes()[0].listPrimitives()[0]))assert.deepEqual(value,before.get(key));
});
test('a model below its target is byte-identical and not rebaked',async()=>{
 const {bytes}=await sphere(),result=await prepareBakeGlb(bytes,{...options,targetTriangles:50000});assert.equal(result.unchanged,true);assert.deepEqual(result.bytes,bytes);
});
test('morphs and memory limits fail without modifying source bytes',async()=>{
 const bytes=await compressionFixture({morph:true}),copy=bytes.slice();await assert.rejects(()=>prepareBakeGlb(bytes,{...options,targetTriangles:100}),/Morph/);assert.deepEqual(bytes,copy);
 const {doc}=await sphere();assert.throws(()=>bakePlan(doc,1024*1024*1024,{...options,memoryBudgetMiB:64}),/память/);
});
test('projection misses fail instead of saving black stripes',()=>{
 const d=new Document(),b=d.createBuffer(),a=d.createAccessor().setBuffer(b).setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,1,0])),p=d.createPrimitive().setAttribute('POSITION',a),source=primitiveGeometry(p);
 const target={positions:new Float32Array([0,0,10,1,0,10,0,1,10]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),uv:new Float32Array([0,0,1,0,0,1]),indices:new Uint32Array([0,1,2]),tangents:new Float32Array([1,0,0,1,1,0,0,1,1,0,0,1]),margin:2};
 assert.throws(()=>projectBakePixels(source,target,{size:32}),/Не перенесено/);
});
test('color filtering is linear and padding extends only known surface data',()=>{
 const map={data:new Uint8Array([0,0,0,255,255,255,255,255]),width:2,height:1};assert.ok(sampleMap(map,.5,.5,true)[0]>.7);
 const pixels=new Uint8ClampedArray(100),mask=new Uint8Array(25);mask[12]=1;pixels.set([1,2,3,255],48);padBakeMaps({base:pixels},mask,5,1);assert.deepEqual(Array.from(pixels.slice(44,48)),[1,2,3,255]);assert.equal(pixels[0],0);
});
test('cancelling phase two terminates both workers and preserves the original',async()=>{
 const previous=globalThis.Worker,workers=[],original=new Uint8Array([1,2,3,4]),abort=new AbortController();
 globalThis.Worker=class{constructor(){workers.push(this);this.terminated=false}postMessage(data){queueMicrotask(()=>{if(data.phase==='prepare')this.onmessage({data:{result:{bytes:new Uint8Array([9,8,7]),unchanged:false}}});else this.onmessage({data:{progress:true,percent:1,message:'project'}})})}terminate(){this.terminated=true}};
 try{await assert.rejects(()=>bakeGlbOffThread(original,{},{signal:abort.signal,onProgress:p=>{if(p>=40)abort.abort()}}),e=>e.name==='AbortError');assert.equal(workers.length,2);assert.ok(workers.every(w=>w.terminated));assert.deepEqual(original,new Uint8Array([1,2,3,4]));}finally{globalThis.Worker=previous}
});
test('zero-area imported faces cannot create invalid tangent output',async()=>{
 const d=new Document(),b=d.createBuffer(),acc=(a,t)=>d.createAccessor().setBuffer(b).setType(t).setArray(a);
 const p=d.createPrimitive().setAttribute('POSITION',acc(new Float32Array([0,0,0,1,0,0,0,1,0,1,1,0,.5,0,0]),'VEC3')).setIndices(acc(new Uint16Array([0,1,2,1,3,2,0,4,1,0,0,1]),'SCALAR'));
 d.createScene().addChild(d.createNode().setMesh(d.createMesh().addPrimitive(p)));const bytes=await io().writeBinary(d),r=await prepareBakeGlb(bytes,{...options,targetTriangles:2,error:.01});
 const result=await io().readBinary(r.bytes),t=result.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('TANGENT').getArray();
 for(let i=0;i<t.length;i+=4)assert.ok(Math.abs(Math.hypot(t[i],t[i+1],t[i+2])-1)<1e-4);
});
test('oversized accessor declarations are rejected before decoding buffers',async()=>{
 const {bytes}=await sphere(),j=inspectGlb(bytes).json,old=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(12,true);
 j.accessors[j.meshes[0].primitives[0].attributes.POSITION].count=4000000;
 const json=new TextEncoder().encode(JSON.stringify(j)),length=Math.ceil(json.length/4)*4,out=new Uint8Array(bytes.length-old+length),view=new DataView(out.buffer);
 out.set(bytes.subarray(0,12));view.setUint32(8,out.length,true);view.setUint32(12,length,true);view.setUint32(16,0x4e4f534a,true);out.fill(32,20,20+length);out.set(json,20);out.set(bytes.subarray(20+old),20+length);
 await assert.rejects(()=>readBakeGlb(out),/слишком большой/);
});
test('new UV and MikkTSpace frame reconstruct the original normal direction',async()=>{
 const d=new Document(),b=d.createBuffer(),g=new THREE.PlaneGeometry(1,1,20,20),acc=(a,t)=>d.createAccessor().setBuffer(b).setType(t).setArray(a);
 const png=PNG.sync.write({width:1,height:1,data:Buffer.from([128,190,238,255])});
 const material=d.createMaterial().setNormalTexture(d.createTexture().setImage(new Uint8Array(png)).setMimeType('image/png'));
 const p=d.createPrimitive().setAttribute('POSITION',acc(g.attributes.position.array,'VEC3')).setAttribute('NORMAL',acc(g.attributes.normal.array,'VEC3')).setAttribute('TEXCOORD_0',acc(g.attributes.uv.array,'VEC2')).setIndices(acc(g.index.array,'SCALAR')).setMaterial(material);
 d.createScene().addChild(d.createNode().setMesh(d.createMesh().addPrimitive(p)));
 const source=await io().writeBinary(d),opts={...options,targetTriangles:100,error:.02},prep=await prepareBakeGlb(source,opts),result=await projectBakeGlb(source,prep,opts);
 const out=await io().readBinary(result.bytes),prim=out.getRoot().listMeshes()[0].listPrimitives()[0],normalMap=await decodeImage(prim.getMaterial().getNormalTexture());
 const uv=prim.getAttribute('TEXCOORD_0').getArray(),n=prim.getAttribute('NORMAL').getArray(),t=prim.getAttribute('TANGENT').getArray(),idx=prim.getIndices().getArray();
 const expected=new THREE.Vector3(128/255*2-1,190/255*2-1,238/255*2-1).normalize();
 for(let i=0;i<Math.min(idx.length,60);i+=3){
  const ids=Array.from(idx.slice(i,i+3));let u=0,v=0;
  for(const k of ids){u+=uv[k*2]/3;v+=uv[k*2+1]/3;}
  const rgb=sampleMap(normalMap,u,v),k=ids[0],N=new THREE.Vector3().fromArray(n,k*3),T=new THREE.Vector3().fromArray(t,k*4),B=new THREE.Vector3().crossVectors(N,T).multiplyScalar(t[k*4+3]);
  const actual=T.multiplyScalar(rgb[0]*2-1).addScaledVector(B,rgb[1]*2-1).addScaledVector(N,rgb[2]*2-1).normalize();
  assert.ok(actual.distanceTo(expected)<.025,'normal direction changed after UV/tangent rebaking');
 }
});
test('BVH projection samples the correct donor face across disconnected UV islands',async()=>{
 const d=new Document(),b=d.createBuffer(),g=new THREE.PlaneGeometry(1,1,12,12).toNonIndexed(),palette=new Uint8Array(16*16*4);
 for(let i=0;i<256;i++)palette.set([(i%16)*17,Math.floor(i/16)*17,((i%16)^Math.floor(i/16))*17,255],i*4);
 for(let face=0;face<g.attributes.position.count/3;face++)for(let c=0;c<3;c++)g.attributes.uv.setXY(face*3+c,((face%256)%16+.5)/16,(Math.floor((face%256)/16)+.5)/16);
 const acc=(a,t)=>d.createAccessor().setBuffer(b).setType(t).setArray(a),png=PNG.sync.write({width:16,height:16,data:Buffer.from(palette)});
 const p=d.createPrimitive().setAttribute('POSITION',acc(g.attributes.position.array,'VEC3')).setAttribute('NORMAL',acc(g.attributes.normal.array,'VEC3')).setAttribute('TEXCOORD_0',acc(g.attributes.uv.array,'VEC2')).setMaterial(d.createMaterial().setBaseColorTexture(d.createTexture().setMimeType('image/png').setImage(new Uint8Array(png))));
 d.createScene().addChild(d.createNode().setMesh(d.createMesh().addPrimitive(p)));
 const source=await io().writeBinary(d),opts={...options,targetTriangles:80},prep=await prepareBakeGlb(source,opts),result=await projectBakeGlb(source,prep,opts),out=await io().readBinary(result.bytes);
 const prim=out.getRoot().listMeshes()[0].listPrimitives()[0],image=await decodeImage(prim.getMaterial().getBaseColorTexture()),uv=prim.getAttribute('TEXCOORD_0').getArray(),pos=prim.getAttribute('POSITION').getArray(),idx=prim.getIndices().getArray();
 const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.updateMatrixWorld(true);let checked=0;
 for(let i=0;i<idx.length;i+=3){
  const ids=Array.from(idx.slice(i,i+3)),corners=ids.map(k=>new THREE.Vector3(uv[k*2],uv[k*2+1],0));
  const u=corners.reduce((n,v)=>n+v.x/3,0),v=corners.reduce((n,v)=>n+v.y/3,0),x=Math.floor(u*64),y=Math.floor(v*64);
  const bary=THREE.Triangle.getBarycoord(new THREE.Vector3((x+.5)/64,(y+.5)/64,0),...corners,new THREE.Vector3());
  if(Math.min(bary.x,bary.y,bary.z)<.05)continue;
  const point=new THREE.Vector3();ids.forEach((k,j)=>point.addScaledVector(new THREE.Vector3().fromArray(pos,k*3),bary.getComponent(j)));
  const hits=new THREE.Raycaster(point.clone().add(new THREE.Vector3(0,0,1)),new THREE.Vector3(0,0,-1)).intersectObject(mesh);
  assert.ok(hits.length);const face=hits[0].faceIndex%256;
  for(let c=0;c<3;c++)assert.ok(Math.abs(image.data[(y*64+x)*4+c]-palette[face*4+c])<=1,'sampled the wrong donor UV island');checked++;
 }
 assert.ok(checked>10);mesh.geometry.dispose();mesh.material.dispose();
});
test('optional unsupported metadata is rejected before IO can discard it',async()=>{
 const {bytes}=await sphere(),j=inspectGlb(bytes).json,old=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(12,true);
 j.extensionsUsed=['VRMC_vrm'];j.extensions={VRMC_vrm:{specVersion:'1.0',meta:{name:'Keep avatar metadata'}}};
 const json=new TextEncoder().encode(JSON.stringify(j)),length=Math.ceil(json.length/4)*4,out=new Uint8Array(bytes.length-old+length),view=new DataView(out.buffer);
 out.set(bytes.subarray(0,12));view.setUint32(8,out.length,true);view.setUint32(12,length,true);view.setUint32(16,0x4e4f534a,true);out.fill(32,20,20+length);out.set(json,20);out.set(bytes.subarray(20+old),20+length);
 await assert.rejects(()=>readBakeGlb(out),/VRMC_vrm/);
});
test('dense curved mesh keeps its budget and valid frames after an alternate donor-based attempt',{timeout:120000},async()=>{
 // Plain simplification of this mesh produced zero MikkTSpace tangents.
 const d=new Document(),b=d.createBuffer(),g=new THREE.TorusKnotGeometry(1,.15,512,96),acc=(a,t)=>d.createAccessor().setBuffer(b).setType(t).setArray(a);
 const p=d.createPrimitive().setAttribute('POSITION',acc(g.attributes.position.array,'VEC3')).setAttribute('NORMAL',acc(g.attributes.normal.array,'VEC3')).setAttribute('TEXCOORD_0',acc(g.attributes.uv.array,'VEC2')).setIndices(acc(g.index.array,'SCALAR'));
 d.createScene().addChild(d.createNode().setMesh(d.createMesh().addPrimitive(p)));
 const source=await io().writeBinary(d),copy=source.slice(),opts={...options,targetTriangles:50000,error:.008,resolution:512};
 const prepared=await prepareBakeGlb(source,opts),result=await projectBakeGlb(source,prepared,opts);
 assert.equal(prepared.sourceTriangles,98304);assert.equal(result.optimizedTriangles,50000,'a retry must use the donor, not compound the reduction ratio');
 assert.ok(source.every((value,i)=>value===copy[i]));assert.ok(result.bakeReports.every(r=>r.misses===0&&r.coverage>0));
 const validation=await validator.validateBytes(result.bytes,{maxIssues:100});assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues));
 const h=geometryHistory(inspectGlb(result.bytes).json.extras);assert.equal(h.sourceTriangles,98304);assert.equal(h.error,.008);assert.equal(h.geometryPasses,1);
});

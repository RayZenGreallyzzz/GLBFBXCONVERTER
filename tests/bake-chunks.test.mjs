import test from 'node:test';
import assert from 'node:assert/strict';
import {Document} from '@gltf-transform/core';
import * as THREE from 'three';
import {triangleChunks,simplifyBakeChunks,BAKE_CHUNK_TRIANGLES} from '../src/bake-chunks.js';
import {primitiveGeometry,packedProjectionSource} from '../src/bake-geometry.js';
import {projectBakePixels} from '../src/bake-pixels.js';
import {bakeGlbOffThread} from '../src/surface-bake-client.js';
import {faceTangents} from '../src/bake-frame.js';
import {readFileSync} from 'node:fs';
import * as Mikk from 'three/examples/jsm/libs/mikktspace.module.js';
import {unwrapPreparedBake} from '../src/bake-unwrap.js';
test('a zero-angle Mikk corner gets a valid UV-derived frame with a deliberate tangent seam',async()=>{
 const f=JSON.parse(readFileSync(new URL('./helpers/bake-sliver.json',import.meta.url))),p=new Float32Array(f.positions),n=new Float32Array(f.normals),uv=new Float32Array(f.uv);await Mikk.ready;
 const m=Mikk.generateTangents(p,n,uv);assert.equal(Math.hypot(...m.subarray(8,11)),0);
 const out=faceTangents(p,n,uv);
 for(let i=0;i<3;i++){const t=out.subarray(i*4,i*4+3),normal=n.subarray(i*3,i*3+3);assert.ok(Math.abs(Math.hypot(...t)-1)<1e-5);assert.ok(Math.abs(t.reduce((s,v,k)=>s+v*normal[k],0))<1e-5);assert.equal(Math.abs(out[i*4+3]),1)}
 const shifted=Float32Array.from(p,(v,i)=>v*2+[100,200,300][i%3]),again=faceTangents(shifted,n,uv);for(let i=0;i<out.length;i++)assert.ok(Math.abs(out[i]-again[i])<.001);
});
test('UV stage checks its own memory budget before decoding the intermediate',async()=>{
 await assert.rejects(()=>unwrapPreparedBake({bytes:new Uint8Array([1,2,3]),optimizedTriangles:200000},{memoryBudgetMiB:256}),/Расчётная память/);
});
function fixture(g){
 const d=new Document(),b=d.createBuffer(),a=(x,t,n=false)=>d.createAccessor().setBuffer(b).setType(t).setNormalized(n).setArray(x);
 const p=d.createPrimitive().setAttribute('POSITION',a(g.attributes.position.array,'VEC3')).setIndices(a(g.index.array,'SCALAR'));
 if(g.attributes.normal)p.setAttribute('NORMAL',a(g.attributes.normal.array,'VEC3'));
 if(g.attributes.uv)p.setAttribute('TEXCOORD_0',a(g.attributes.uv.array,'VEC2'));
 d.createScene().addChild(d.createNode().setMesh(d.createMesh().addPrimitive(p)));return {d,p,a};
}
test('spatial partition is bounded, complete and does not mutate source indices',()=>{
 const g=new THREE.PlaneGeometry(2,2,64,64),copy=g.index.array.slice(),plan=triangleChunks(g.index.array,g.attributes.position.array,{maxTriangles:128});
 assert.deepEqual(g.index.array,copy);assert.equal(new Set(plan.order).size,g.index.count/3);
 assert.ok(plan.chunks.every(c=>c.end-c.start<=128));assert.equal(plan.chunks.reduce((n,c)=>n+c.end-c.start,0),g.index.count/3);
});
test('file-backed stages terminate before the next stage and retry UV only from the original file',async()=>{
 const previous=globalThis.Worker,workers=[],file=new Blob([new Uint8Array([1,2,3,4])]);let uv=0;
 globalThis.Worker=class{
  constructor(){assert.ok(workers.every(w=>w.terminated));workers.push(this)}
  postMessage(data){this.data=data;queueMicrotask(()=>{
   if(data.phase==='unwrap'&&++uv===1)this.onmessage({data:{error:'frame',errorCode:'BAKE_FRAME'}});
   else this.onmessage({data:{result:{bytes:new Uint8Array([9,8,7]),unchanged:false,resolution:512,optimizedTriangles:50}}});
  })}
  terminate(){this.terminated=true}
 };
 try{
  await bakeGlbOffThread(file,{lowMemory:true,targetTriangles:50000,error:.008});
  assert.deepEqual(workers.map(w=>w.data.phase),['prepare','unwrap','prepare','unwrap','project']);
  for(const w of workers.filter(w=>w.data.phase==='prepare'||w.data.phase==='project')){assert.equal(w.data.file,file);assert.equal(w.data.bytes,undefined);assert.equal(w.data.options.targetTriangles,50000);assert.equal(w.data.options.error,.008)}
  assert.equal(workers[2].data.options.regularize,true);assert.ok(workers.every(w=>w.terminated));assert.deepEqual(new Uint8Array(await file.arrayBuffer()),new Uint8Array([1,2,3,4]));
 }finally{globalThis.Worker=previous}
});
test('cancelling file-backed UV preparation never starts projection and leaves the file intact',async()=>{
 const previous=globalThis.Worker,workers=[],file=new Blob([new Uint8Array([1,2,3,4])]),abort=new AbortController();
 globalThis.Worker=class{constructor(){workers.push(this)}postMessage(data){this.data=data;queueMicrotask(()=>{if(data.phase==='prepare')this.onmessage({data:{result:{bytes:new Uint8Array([9]),unchanged:false}}});else this.onmessage({data:{progress:true,percent:1,message:'UV'}})})}terminate(){this.terminated=true}};
 try{await assert.rejects(()=>bakeGlbOffThread(file,{lowMemory:true},{signal:abort.signal,onProgress:(_p,m)=>{if(m==='UV')abort.abort()}}),e=>e.name==='AbortError');assert.equal(workers.length,2);assert.ok(workers.every(w=>w.terminated));assert.deepEqual(new Uint8Array(await file.arrayBuffer()),new Uint8Array([1,2,3,4]))}finally{globalThis.Worker=previous}
});
test('bounded simplification preserves planar patch boundaries without holes',{timeout:120000},async()=>{
 const {d,p}=fixture(new THREE.PlaneGeometry(2,2,400,400));let chunks=0;
 const r=await simplifyBakeChunks(d,p,{ratio:.02,error:.003,onProgress:(_p,r)=>chunks=r.chunks});
 assert.ok(chunks>1);assert.equal(r.maxTriangles,BAKE_CHUNK_TRIANGLES);
 const pos=p.getAttribute('POSITION').getArray(),ix=p.getIndices().getArray();assert.ok(ix.length/3<20000);
 let area=0;for(let i=0;i<ix.length;i+=3){const a=ix[i]*3,b=ix[i+1]*3,c=ix[i+2]*3;area+=Math.abs((pos[b]-pos[a])*(pos[c+1]-pos[a+1])-(pos[b+1]-pos[a+1])*(pos[c]-pos[a]))/2}
 assert.ok(Math.abs(area-4)<1e-5,'all patches must cover the original sheet exactly');
});
test('chunked projection agrees with full BVH including nearest hits in the final partial chunk',{timeout:120000},()=>{
 const g=new THREE.PlaneGeometry(2,2,257,257),count=g.attributes.position.count;
 const xyz=new Float32Array(g.attributes.position.array.length+9);xyz.set(g.attributes.position.array);xyz.set([-1,-1,.002,1,-1,.002,-1,1,.002],count*3);
 const ix=new Uint32Array(g.index.count+3);ix.set(g.index.array);ix.set([count,count+1,count+2],g.index.count);
 g.setAttribute('position',new THREE.BufferAttribute(xyz,3)).setIndex(new THREE.BufferAttribute(ix,1));
 const {p,a}=fixture(g),normal=new Int8Array(xyz.length),uv=new Uint16Array(xyz.length/3*2);
 for(let i=0;i<xyz.length/3;i++){normal[i*3+2]=127;uv[i*2]=i<count?16384:49151;uv[i*2+1]=32768}
 p.setAttribute('NORMAL',a(normal,'VEC3',true)).setAttribute('TEXCOORD_0',a(uv,'VEC2',true));
 const target={positions:new Float32Array([-1,-1,.003,1,-1,.003,-1,1,.003,1,1,.003]),normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),uv:new Float32Array([0,0,1,0,0,1,1,1]),tangents:new Float32Array([1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1]),indices:new Uint32Array([0,1,2,2,1,3]),margin:2};
 const maps={base:{data:new Uint8Array([255,0,0,255,0,255,0,255]),width:2,height:1,coord:0,matrix:[1,0,0,1,0,0],wrapS:33071,wrapT:33071}};
 const full=projectBakePixels(primitiveGeometry(p),target,{size:32,maps}),packed=packedProjectionSource(p),bounded=projectBakePixels(packed,target,{size:32,maps});
 assert.equal(packed.normals.byteLength,normal.byteLength);assert.equal(packed.uv[0].byteLength,uv.byteLength);
 assert.equal(bounded.misses,0);assert.equal(bounded.coverage,full.coverage);
 assert.deepEqual(bounded.maps.base,full.maps.base);assert.deepEqual(bounded.maps.normal,full.maps.normal);
 assert.ok(bounded.maps.base.some((v,i)=>i%4===1&&v>200),'the last small donor triangle must win nearer hits');
});
test('a missed shared-UV-edge sample is projected with the other target face, without filling colours',()=>{
 const {p}=fixture(new THREE.PlaneGeometry(2,2,2,2));
 const uv=new Float32Array([0,0,.04,0,0,.04,0,0,1,0,0,1,1,1]),positions=new Float32Array(21),normals=new Float32Array(21),tangents=new Float32Array(28);
 for(let i=0;i<7;i++){positions[i*3]=uv[i*2]*2-1;positions[i*3+1]=uv[i*2+1]*2-1;normals[i*3+2]=i<3?-1:1;tangents[i*4]=1;tangents[i*4+3]=1}
 const target={positions,normals,uv,tangents,indices:new Uint32Array([0,1,2,3,4,5,5,4,6]),margin:2};
 const full=projectBakePixels(primitiveGeometry(p),target,{size:32}),bounded=projectBakePixels(packedProjectionSource(p),target,{size:32});
 assert.equal(bounded.coverage,1024);assert.equal(bounded.misses,0);assert.deepEqual(bounded.maps.normal,full.maps.normal);
});
test('smooth projection cage remains independent of a sharp shading frame',()=>{
 const {p}=fixture(new THREE.PlaneGeometry(2,2,2,2)),target={positions:new Float32Array([-1,-1,0,1,-1,0,-1,1,0,1,1,0]),uv:new Float32Array([0,0,1,0,0,1,1,1]),indices:new Uint32Array([0,1,2,2,1,3]),normals:new Float32Array([1,0,0,1,0,0,1,0,0,1,0,0]),projectionNormals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),tangents:new Float32Array([0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1]),margin:2};
 for(const source of [primitiveGeometry(p),packedProjectionSource(p)]){
  const out=projectBakePixels(source,target,{size:32});assert.equal(out.misses,0);
  // In this target frame B=(0,0,1). Green must encode the donor's world +Z.
  for(let i=0;i<out.maps.normal.length;i+=4){assert.ok(Math.abs(out.maps.normal[i]-128)<=1);assert.equal(out.maps.normal[i+1],255);assert.ok(Math.abs(out.maps.normal[i+2]-128)<=1)}
 }
});

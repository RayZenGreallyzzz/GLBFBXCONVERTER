import test from 'node:test';
import assert from 'node:assert/strict';
import {Document,WebIO} from '@gltf-transform/core';
import * as THREE from 'three';
import validator from 'gltf-validator';
import {unwrapBakeChunks,BAKE_UV_CHUNK_TRIANGLES} from '../src/bake-uv-chunks.js';
import {finishBakePrimitive} from '../src/bake-geometry.js';
import {unwrapPreparedBake} from '../src/bake-unwrap.js';

function fixture(g){
 const d=new Document(),b=d.createBuffer(),a=(array,type)=>d.createAccessor().setBuffer(b).setType(type).setArray(array);
 const p=d.createPrimitive().setAttribute('POSITION',a(g.attributes.position.array,'VEC3')).setIndices(a(g.index.array,'SCALAR'));
 d.createScene().addChild(d.createNode().setMesh(d.createMesh().addPrimitive(p)));return {d,p};
}
function triangles(p){
 const pos=p.getAttribute('POSITION').getArray(),ix=p.getIndices().getArray(),faces=[];
 for(let i=0;i<ix.length;i+=3)faces.push(Array.from(ix.subarray(i,i+3),v=>Array.from(pos.subarray(v*3,v*3+3)).join(',')).join(';'));
 return faces.sort();
}

test('bounded UV keeps every oriented triangle, one nonoverlapping atlas and comparable planar texel density',{timeout:120000},async()=>{
 const g=new THREE.PlaneGeometry(3,1,180,100);
 // Unequal world areas ensure chunks cannot simply receive equal-sized tiles.
 const pos=g.attributes.position.array;for(let i=0;i<pos.length;i+=3)pos[i]=Math.sign(pos[i])*pos[i]*pos[i];
 const {d,p}=fixture(g),before=triangles(p),progress=[];
 const out=await unwrapBakeChunks(d,p,512,(_c,percent)=>progress.push(percent));
 assert.ok(g.index.count/3>BAKE_UV_CHUNK_TRIANGLES*2);assert.equal(progress.at(-1),100);
 assert.deepEqual(triangles(p),before);assert.ok(out.uv.every(v=>Number.isFinite(v)&&v>0&&v<1));
 const owners=new Uint32Array(256*256);let minimum=Infinity,maximum=0,covered=0;
 for(let i=0;i<out.indices.length;i+=3){
  const q=Array.from({length:3},(_,c)=>[out.uv[(i+c)*2],out.uv[(i+c)*2+1]]),xyz=Array.from({length:3},(_,c)=>[out.positions[(i+c)*3],out.positions[(i+c)*3+1]]);
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]),area=cross(...q),density=Math.abs(area/cross(...xyz));
  assert.ok(Number.isFinite(density)&&density>0);minimum=Math.min(minimum,density);maximum=Math.max(maximum,density);
  const lo=[0,1].map(k=>Math.max(0,Math.floor(Math.min(...q.map(v=>v[k]))*256))),hi=[0,1].map(k=>Math.min(255,Math.ceil(Math.max(...q.map(v=>v[k]))*256)));
  for(let y=lo[1];y<=hi[1];y++)for(let x=lo[0];x<=hi[0];x++){
   const pixel=[(x+.5)/256,(y+.5)/256],a=cross(q[1],q[2],pixel)/area,b=cross(q[2],q[0],pixel)/area,c=1-a-b;
   if(Math.min(a,b,c)>1e-5){assert.equal(owners[y*256+x],0,'UV interiors must not overlap');owners[y*256+x]=i/3+1;covered++}
  }
 }
 assert.ok(covered>10000);assert.ok(maximum/minimum<1.05,'all spatial patches retain equal world-space texel density: '+minimum+' / '+maximum);
 for(let i=0;i<out.normals.length;i+=3)assert.deepEqual(Array.from(out.normals.subarray(i,i+3)),[0,0,1]);
 for(let i=0;i<out.tangents.length;i+=4){assert.ok(Math.abs(Math.hypot(...out.tangents.subarray(i,i+3))-1)<1e-4);assert.equal(Math.abs(out.tangents[i+3]),1)}
 finishBakePrimitive(p,true);assert.ok(p.getAttribute('POSITION').getCount()<out.positions.length/3/2);assert.deepEqual(triangles(p),before);
 const validation=await validator.validateBytes(await new WebIO().writeBinary(d),{maxIssues:20});assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues));
});

test('UV memory guard rejects a bounded job before decoding when its live budget is too small',async()=>{
 await assert.rejects(()=>unwrapPreparedBake({bytes:new Uint8Array([1]),geometryOnly:true,optimizedTriangles:200000},{memoryBudgetMiB:128}),/UV.*Расчётная память/);
});

test('bounded UV retains smooth projection normals across spatial chart boundaries',{timeout:120000},async()=>{
 const g=new THREE.TorusGeometry(1,.3,96,128),{d,p}=fixture(g);g.computeVertexNormals();
 const io=new WebIO(),source=await io.writeBinary(d),out=await unwrapPreparedBake({bytes:source,geometryOnly:true,optimizedTriangles:g.index.count/3,resolution:256},{memoryBudgetMiB:256});
 const result=(await io.readBinary(out.bytes)).getRoot().listMeshes()[0].listPrimitives()[0],positions=result.getAttribute('POSITION').getArray(),reference=new Map();
 for(let i=0;i<g.attributes.position.count;i++)reference.set(Array.from(g.attributes.position.array.subarray(i*3,i*3+3)).join(','),g.attributes.normal.array.subarray(i*3,i*3+3));
 const cage=result.getAttribute('_PHOENIX_PROJECTION_NORMAL').getArray();
 assert.equal(result.getIndices().getCount(),g.index.count);assert.equal(out.geometryOnly,false);
 for(let i=0;i<positions.length;i+=3){const n=reference.get(Array.from(positions.subarray(i,i+3)).join(','));for(let k=0;k<3;k++)assert.ok(Math.abs(cage[i+k]-n[k])<1e-6)}
});

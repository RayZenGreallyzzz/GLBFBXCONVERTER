import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Document} from '@gltf-transform/core';
import {primitiveGeometry,packedProjectionSource} from '../src/bake-geometry.js';
import {projectBakePixels,sampleMap} from '../src/bake-pixels.js';
import {surfaceBarycentric} from '../src/bake-projection.js';

const green={data:new Uint8Array([255,0,0,255,0,255,0,255]),width:2,height:1,coord:0,matrix:[1,0,0,1,0,0],wrapS:33071,wrapT:33071};
function primitive(positions,normals,uv,indices){
 const d=new Document(),b=d.createBuffer(),a=(v,t)=>d.createAccessor().setBuffer(b).setType(t).setArray(v);
 return d.createPrimitive().setAttribute('POSITION',a(new Float32Array(positions),'VEC3')).setAttribute('NORMAL',a(new Float32Array(normals),'VEC3'))
  .setAttribute('TEXCOORD_0',a(new Float32Array(uv),'VEC2')).setIndices(a(new Uint32Array(indices),'SCALAR'));
}
function layers(specs){
 const positions=[],normals=[],uv=[],indices=[];
 for(const {z=0,sign=1,u=.75,x0=-1,x1=1}of specs){
  const first=positions.length/3;positions.push(x0,-1,z,x1,-1,z,x0,1,z,x1,1,z);
  for(let i=0;i<4;i++){normals.push(0,0,sign);uv.push(u,.5)}
  indices.push(...(sign>0?[0,1,2,2,1,3]:[0,2,1,2,3,1]).map(i=>i+first));
 }
 return primitive(positions,normals,uv,indices);
}
function sheet(x0=-1,x1=1,z=0){return {positions:new Float32Array([x0,-1,z,x1,-1,z,x0,1,z,x1,1,z]),normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),uv:new Float32Array([0,0,1,0,0,1,1,1]),indices:new Uint32Array([0,1,2,2,1,3]),tangents:new Float32Array([1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1]),margin:2}}
function both(p,target,options={}){
 const full=projectBakePixels(primitiveGeometry(p),target,{size:32,...options}),bounded=projectBakePixels(packedProjectionSource(p),target,{size:32,...options});
 assert.equal(full.misses,0);assert.equal(bounded.misses,0);assert.equal(bounded.coverage,full.coverage);
 for(const name of Object.keys(full.maps))assert.deepEqual(bounded.maps[name],full.maps[name]);
 return bounded;
}
function allGreen(out){for(let i=0;i<out.mask.length;i++)if(out.mask[i])assert.deepEqual(Array.from(out.maps.base.subarray(i*4,i*4+4)),[0,255,0,255])}

test('rejected first ray faces cannot hide the nearest compatible folded surface',()=>{
 const p=layers([{z:-.001,sign:-1,u:.25},{z:.001,sign:-1,u:.25},{z:.012,sign:1},{z:-.02,sign:1,u:.25}]);
 const out=both(p,sheet(),{maps:{base:green}});assert.equal(out.coverage,1024);allGreen(out);
});

test('nearest-point fallback searches compatible faces without increasing the cage distance',()=>{
 const p=layers([{x0:.05,x1:.055,sign:-1,u:.25},{x0:.06,x1:.065,sign:1}]),target=sheet(-.019,.019);
 const out=both(p,target,{maps:{base:green}});assert.equal(out.coverage,1024);allGreen(out);
 for(const source of [primitiveGeometry(p),packedProjectionSource(p)])assert.throws(()=>projectBakePixels(source,sheet(-.5,-.4),{size:32}),/Не перенесено/);
});

test('dominant-plane barycentrics retain a needle triangle whose squared-length determinant cancels',()=>{
 const a=new THREE.Vector3(0,0,0),b=new THREE.Vector3(1,1e-8,0),c=new THREE.Vector3(2,0,0),p=new THREE.Vector3(1.25,2.5e-9,0),w=new THREE.Vector3();
 assert.equal(THREE.Triangle.getBarycoord(p,a,b,c,new THREE.Vector3()),null);
 assert.ok(surfaceBarycentric(p,a,b,c,w));assert.ok(w.distanceTo(new THREE.Vector3(.25,.25,.5))<1e-12);
 assert.equal(surfaceBarycentric(p,a,a,c,w),false);
});

for(const offset of [0,1e6])test('needle-face texture samples retain barycentrics through bounded storage at offset '+offset,()=>{
 const positions=[offset,0,0,offset+1,1e-8,0,offset+2,0,0],normals=[0,0,1,0,0,1,0,0,1],uv=[0,0,.5,1,1,0],p=primitive(positions,normals,uv,[0,1,2]);
 const target={positions:Float32Array.from(positions,(v,i)=>i%3===2?.001:v),normals:new Float32Array(normals),uv:new Float32Array(uv),indices:new Uint32Array([0,1,2]),tangents:new Float32Array([1,0,0,1,1,0,0,1,1,0,0,1]),margin:2};
 const map={...green,width:2,height:2,data:new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255])},out=both(p,target,{maps:{base:map}});
 assert.ok(out.coverage>400);
 for(let i=0;i<out.mask.length;i++)if(out.mask[i]){
  const expected=sampleMap(map,(i%32+.5)/32,(Math.floor(i/32)+.5)/32,true);
  for(let k=0;k<4;k++)assert.ok(Math.abs(out.maps.base[i*4+k]-Math.round(expected[k]*255))<=1,'source UV must agree with the projected point');
 }
});

test('a cancelled cage normal uses the actual target face; a reversed valid cage still fails',()=>{
 const p=layers([{}]),target=sheet();target.projectionNormals=new Float32Array(12);both(p,target);
 target.projectionNormals=new Float32Array([0,0,-1,0,0,-1,0,0,-1,0,0,-1]);
 for(const source of [primitiveGeometry(p),packedProjectionSource(p)])assert.throws(()=>projectBakePixels(source,target,{size:32}),/Не перенесено/);
});

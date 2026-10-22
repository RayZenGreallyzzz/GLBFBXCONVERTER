import test from 'node:test';
import assert from 'node:assert/strict';
import {Document,WebIO,Accessor} from '@gltf-transform/core';
import {optimizeGlb,countTriangles} from '../src/glb-optimize.js';
import {inspectGlb} from '../src/format.js';

async function makeRiggedGrid(xSegments=48,ySegments=24){
 const doc=new Document(),buffer=doc.createBuffer();
 const positions=[],uvs=[],normals=[],jointIds=[],jointWeights=[],indices=[];
 for(let y=0;y<=ySegments;y++)for(let x=0;x<=xSegments;x++){
   const u=x/xSegments,v=y/ySegments;
   positions.push(u*2-1,v*2,0.03*Math.sin(u*7)*Math.cos(v*5));
   normals.push(0,0,1);uvs.push(u,v);
   jointIds.push(0,1,0,0);
   jointWeights.push(1-u,u,0,0);
 }
 for(let y=0;y<ySegments;y++)for(let x=0;x<xSegments;x++){
   const a=y*(xSegments+1)+x,b=a+1,c=a+xSegments+1,d=c+1;
   indices.push(a,b,c,b,d,c);
 }
 const accessor=(array,type)=>doc.createAccessor().setBuffer(buffer).setType(type).setArray(array);
 const pos=accessor(new Float32Array(positions),Accessor.Type.VEC3);
 const uv=accessor(new Float32Array(uvs),Accessor.Type.VEC2);
 const norm=accessor(new Float32Array(normals),Accessor.Type.VEC3);
 const joint=accessor(new Uint16Array(jointIds),Accessor.Type.VEC4);
 const weight=accessor(new Float32Array(jointWeights),Accessor.Type.VEC4);
 const index=accessor(new Uint16Array(indices),Accessor.Type.SCALAR);
 const prim=doc.createPrimitive().setAttribute('POSITION',pos)
   .setAttribute('NORMAL',norm).setAttribute('TEXCOORD_0',uv)
   .setAttribute('JOINTS_0',joint).setAttribute('WEIGHTS_0',weight).setIndices(index);
 const mesh=doc.createMesh('RiggedGrid').addPrimitive(prim);
 const hip=doc.createNode('Hips'),arm=doc.createNode('RightArm');
 hip.addChild(arm);
 const transforms=new Float32Array(32);
 for(let k=0;k<2;k++)for(let j=0;j<4;j++)transforms[k*16+j*5]=1;
 const inverse=accessor(transforms,Accessor.Type.MAT4);
 const skin=doc.createSkin('Rig').addJoint(hip).addJoint(arm).setInverseBindMatrices(inverse);
 doc.createScene('Scene').addChild(hip).addChild(doc.createNode('Body').setMesh(mesh).setSkin(skin));
 const times=accessor(new Float32Array([0,.5,1,1.5]),Accessor.Type.SCALAR);
 const values=accessor(new Float32Array([0,0,0,0,.1,0,0,.2,0,0,.3,0]),Accessor.Type.VEC3);
 const sampler=doc.createAnimationSampler().setInput(times).setOutput(values).setInterpolation('LINEAR');
 const channel=doc.createAnimationChannel().setSampler(sampler).setTargetNode(arm).setTargetPath('translation');
 doc.createAnimation('Idle').addSampler(sampler).addChannel(channel);
 return new WebIO().writeBinary(doc);
}
function signatures(doc){
 const p=doc.getRoot().listMeshes()[0].listPrimitives()[0];
 const pos=p.getAttribute('POSITION').getArray(),
  joint=p.getAttribute('JOINTS_0').getArray(),
  weights=p.getAttribute('WEIGHTS_0').getArray(),
  uv=p.getAttribute('TEXCOORD_0').getArray();
 const set=new Set();
 for(let i=0;i<pos.length/3;i++){
   const f=[...pos.slice(i*3,i*3+3),
     ...joint.slice(i*4,i*4+4),...weights.slice(i*4,i*4+4),
     ...uv.slice(i*2,i*2+2)];
   set.add(f.join(','));
 }
 return set;
}
test('rigged grid can be simplified while every surviving vertex preserves exact bone weights and UVs',async()=>{
 const src=await makeRiggedGrid(),io=new WebIO(),before=await io.readBinary(src);
 const result=await optimizeGlb(src,{geometry:true,textures:false,animationKeys:false,ratio:.45,error:.07});
 assert.ok(result.optimizedTriangles<result.sourceTriangles,
   'skin-aware optimizer should remove triangles without removing bones');
 assert.ok(result.afterBytes<result.beforeBytes);
 assert.equal(result.unchanged,false);
 const resultInfo=inspectGlb(result.bytes);
 assert.equal(resultInfo.skins,1);
 assert.equal(resultInfo.animations,1);
 const after=await io.readBinary(result.bytes);
 assert.equal(after.getRoot().listAnimations()[0].getName(),'Idle');
 assert.equal(after.getRoot().listSkins()[0].listJoints().length,2);
 const oldSig=signatures(before);
 const newSig=signatures(after);
 assert.ok(newSig.size<oldSig.size);
 for(const entry of newSig)assert.ok(oldSig.has(entry),
   'LOD vertices must be an exact subset of the original positions, UVs, JOINTS and WEIGHTS');
});
test('conservative high-error target still preserves named animation and joint binding',async()=>{
 const src=await makeRiggedGrid(24,12);
 const result=await optimizeGlb(src,{geometry:true,textures:false,animationKeys:false,ratio:.25,error:.12});
 const meta=inspectGlb(result.bytes);
 assert.equal(meta.skins,1);
 assert.equal(meta.animations,1);
 const scene=meta.json;
 const bound=scene.nodes.filter(n=>n.skin!==undefined);
 assert.equal(bound.length,1);
 assert.ok(scene.skins[0].joints.length===2);
 const attributes=scene.meshes[0].primitives[0].attributes;
 assert.ok(attributes.WEIGHTS_0!==undefined&&attributes.JOINTS_0!==undefined);
});
test('already optimized rigged mesh with geometry unchecked stays exact byte-for-byte',async()=>{
 const src=await makeRiggedGrid(16,8);
 const result=await optimizeGlb(src,{geometry:false,textures:false,animationKeys:false,ratio:.22});
 assert.equal(result.unchanged,true);
 assert.deepEqual(Buffer.from(result.bytes),Buffer.from(src));
});

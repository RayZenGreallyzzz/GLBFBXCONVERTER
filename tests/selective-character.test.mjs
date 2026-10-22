import test from 'node:test';
import assert from 'node:assert/strict';
import {Document,WebIO,Accessor} from '@gltf-transform/core';
import {optimizeGlb,countAnimationKeys,selectiveOptimizationPlan} from '../src/glb-optimize.js';
import {inspectGlb} from '../src/format.js';

async function riggedGlb(){
 const doc=new Document(),buffer=doc.createBuffer();
 const acc=(arr,type)=>doc.createAccessor().setBuffer(buffer).setType(type).setArray(arr);
 const positions=acc(new Float32Array([0,0,0,1,0,0,0,1,0]),Accessor.Type.VEC3);
 const indices=acc(new Uint16Array([0,1,2]),Accessor.Type.SCALAR);
 const joints=acc(new Uint16Array([0,0,0,0,0,0,0,0,0,0,0,0]),Accessor.Type.VEC4);
 const weights=acc(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0]),Accessor.Type.VEC4);
 const primitive=doc.createPrimitive()
   .setAttribute('POSITION',positions).setIndices(indices)
   .setAttribute('JOINTS_0',joints).setAttribute('WEIGHTS_0',weights);
 const mesh=doc.createMesh('Character').addPrimitive(primitive);
 const joint=doc.createNode('Hips');
 const ibm=acc(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),Accessor.Type.MAT4);
 const skin=doc.createSkin('Rig').addJoint(joint).setInverseBindMatrices(ibm);
 const node=doc.createNode('CharacterNode').setMesh(mesh).setSkin(skin);
 doc.createScene('Scene').addChild(node).addChild(joint);
 const times=new Float32Array(90);
 const values=new Float32Array(90*3);
 for(let i=0;i<90;i++){times[i]=i/30;values[i*3]=0;values[i*3+1]=0;values[i*3+2]=0;}
 const input=acc(times,Accessor.Type.SCALAR),output=acc(values,Accessor.Type.VEC3);
 const sampler=doc.createAnimationSampler().setInput(input).setOutput(output)
   .setInterpolation('LINEAR');
 const channel=doc.createAnimationChannel().setSampler(sampler)
   .setTargetNode(joint).setTargetPath('translation');
 doc.createAnimation('Idle').addSampler(sampler).addChannel(channel);
 return new WebIO().writeBinary(doc);
}
test('optimizer skip plan respects individually disabled operations',()=>{
 assert.deepEqual(selectiveOptimizationPlan({geometry:false,textures:false,animationKeys:true,ratio:.22}),
   {geometry:false,textures:false,animationKeys:true});
 assert.deepEqual(selectiveOptimizationPlan({geometry:true,textures:false,animationKeys:false,ratio:1}),
   {geometry:false,textures:false,animationKeys:false});
});
test('already optimized character: untouched GLB bytes when nothing selected',async()=>{
 const original=await riggedGlb();
 const r=await optimizeGlb(original,{geometry:false,textures:false,animationKeys:false});
 assert.equal(r.unchanged,true);
 assert.equal(r.afterBytes,r.beforeBytes);
 assert.deepEqual(Buffer.from(r.bytes),Buffer.from(original));
});
test('rigged model requested geometry-only: safely skip without touching skin/weights',async()=>{
 const original=await riggedGlb();
 const result=await optimizeGlb(original,{geometry:true,ratio:.2,error:.1,
   textures:false,animationKeys:false});
 assert.equal(result.unchanged,true);
 assert.match(result.note,/скелетн/i);
 assert.deepEqual(Buffer.from(result.bytes),Buffer.from(original));
});
test('animation-only removes constant duplicate keys while keeping 1 skin + 1 named animation',async()=>{
 const original=await riggedGlb();
 const io=new WebIO(),before=await io.readBinary(original);
 assert.equal(countAnimationKeys(before),90);
 const r=await optimizeGlb(original,{geometry:false,textures:false,animationKeys:true});
 assert.ok(r.removedKeys>0,'keyframe duplicates should be removed');
 assert.equal(r.sourceTriangles,1);
 assert.equal(r.optimizedTriangles,1);
 assert.ok(r.afterBytes<r.beforeBytes);
 const after=await io.readBinary(r.bytes);
 assert.equal(inspectGlb(r.bytes).skins,1);
 assert.equal(inspectGlb(r.bytes).animations,1);
 assert.equal(after.getRoot().listAnimations()[0].getName(),'Idle');
 assert.equal(after.getRoot().listAnimations()[0].listChannels().length,1);
 assert.ok(countAnimationKeys(after)<90);
 const srcPrim=before.getRoot().listMeshes()[0].listPrimitives()[0];
 const dstPrim=after.getRoot().listMeshes()[0].listPrimitives()[0];
 for(const key of ['POSITION','JOINTS_0','WEIGHTS_0']){
   assert.deepEqual(
     Array.from(dstPrim.getAttribute(key).getArray()),
     Array.from(srcPrim.getAttribute(key).getArray()),
     key+' cannot change during animation-only optimization'
   );
 }
});
test('textures-only on no-texture character returns exact original',async()=>{
 const original=await riggedGlb();
 const r=await optimizeGlb(original,{geometry:false,textures:true,animationKeys:false});
 assert.equal(r.unchanged,true);
 assert.deepEqual(Buffer.from(r.bytes),Buffer.from(original));
});

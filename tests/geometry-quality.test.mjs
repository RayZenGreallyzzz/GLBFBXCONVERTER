import test from 'node:test';
import assert from 'node:assert/strict';
import {Document,WebIO,Accessor} from '@gltf-transform/core';
import {ALL_EXTENSIONS,KHRMeshQuantization} from '@gltf-transform/extensions';
import {optimizeGlb} from '../src/glb-optimize.js';
import {compressGlb} from '../src/glb-compression.js';
import {inspectGlb} from '../src/format.js';
import {geometryHistory,geometryPlan} from '../src/geometry-policy.js';

async function grid(quantized=false,n=50){
 const doc=new Document(),buffer=doc.createBuffer(),positions=[],normals=[],uvs=[],indices=[];
 for(let y=0;y<=n;y++)for(let x=0;x<=n;x++){
  positions.push(x,y,0);normals.push(0,0,quantized?127:1);
  uvs.push(quantized?Math.round(x/n*65535):x/n,quantized?Math.round(y/n*65535):y/n);
 }
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){
  const a=y*(n+1)+x;indices.push(a,a+1,a+n+1,a+1,a+n+2,a+n+1);
 }
 const acc=(data,type)=>doc.createAccessor().setBuffer(buffer).setType(type).setArray(data);
 const prim=doc.createPrimitive()
  .setAttribute('POSITION',acc(quantized?new Uint16Array(positions):new Float32Array(positions),Accessor.Type.VEC3))
  .setAttribute('NORMAL',acc(quantized?new Int8Array(normals):new Float32Array(normals),Accessor.Type.VEC3).setNormalized(quantized))
  .setAttribute('TEXCOORD_0',acc(quantized?new Uint16Array(uvs):new Float32Array(uvs),Accessor.Type.VEC2).setNormalized(quantized))
  .setIndices(acc(new Uint32Array(indices),Accessor.Type.SCALAR));
 doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
 if(quantized)doc.createExtension(KHRMeshQuantization).setRequired(true);
 return new WebIO().registerExtensions(ALL_EXTENSIONS).writeBinary(doc);
}
test('absolute target is based on source triangle count, not the texture profile',async()=>{
 const source=await grid(),result=await optimizeGlb(source,{targetTriangles:1000,error:.003,textures:false});
 assert.ok(result.optimizedTriangles<=1000);
 assert.equal(result.sourceTriangles,5000);
 assert.equal(result.targetTriangles,1000);
 assert.ok(geometryHistory(inspectGlb(result.bytes).json.extras));
});
test('saved geometry cannot enter a repeated percentage simplification chain; other operations remain usable',async()=>{
 const source=await grid(),result=await optimizeGlb(source,{targetTriangles:1000,error:.003,textures:false});
 await assert.rejects(()=>optimizeGlb(result.bytes,{geometry:true,textures:false,ratio:.22}),/уже упрощена/);
 const untouched=await optimizeGlb(result.bytes,{geometry:false,textures:false,animationKeys:false});
 assert.deepEqual(untouched.bytes,result.bytes);
 const packed=await compressGlb(result.bytes,{geometryCodec:'draco'});
 assert.equal(geometryHistory(inspectGlb(packed.bytes).json.extras).geometryPasses,1);
 await assert.rejects(()=>optimizeGlb(packed.bytes,{geometry:true,textures:false,ratio:.22}),/уже упрощена/);
});
test('different previews start independently from the original, without mutating it',async()=>{
 const source=await grid(),copy=source.slice();
 const a=await optimizeGlb(source,{targetTriangles:1500,error:.003,textures:false});
 const b=await optimizeGlb(source,{targetTriangles:1000,error:.003,textures:false});
 assert.deepEqual(source,copy);
 assert.equal(a.sourceTriangles,b.sourceTriangles);
 assert.equal(geometryHistory(inspectGlb(b.bytes).json.extras).sourceTriangles,5000);
});
test('saved reduced GLB does not carry the unused original index array',async()=>{
 const source=await grid(false,100);
 const result=await optimizeGlb(source,{targetTriangles:1000,error:.003,textures:false});
 const doc=await new WebIO().readBinary(result.bytes);
 const prim=doc.getRoot().listMeshes()[0].listPrimitives()[0];
 assert.ok(result.optimizedTriangles<=1000);
 assert.ok(result.bytes.length<source.length*.25,'reduced geometry must reduce stored payload');
 assert.deepEqual(prim.listSemantics().sort(),['NORMAL','POSITION','TEXCOORD_0']);
 assert.ok(doc.getRoot().listAccessors().every(a=>a.listParents().some(p=>p.propertyType!=='Root')),
  'orphaned source geometry must not remain in the output');
});
test('quantized normals and UV are accepted and preserved exactly on surviving vertices',async()=>{
 const source=await grid(true),io=new WebIO().registerExtensions(ALL_EXTENSIONS),before=await io.readBinary(source);
 const result=await optimizeGlb(source,{targetTriangles:1500,error:.003,textures:false});
 assert.ok(result.optimizedTriangles<result.sourceTriangles);
 const after=await io.readBinary(result.bytes);
 const primitive=d=>d.getRoot().listMeshes()[0].listPrimitives()[0];
 const tuples=p=>{
  const attrs=['POSITION','NORMAL','TEXCOORD_0'].map(s=>p.getAttribute(s));
  const values=attrs.map(a=>a.getArray()),sizes=attrs.map(a=>a.getElementSize()),set=new Set();
  for(let i=0;i<attrs[0].getCount();i++)set.add(values.flatMap((v,k)=>Array.from(v.slice(i*sizes[k],(i+1)*sizes[k]))).join(','));
  return set;
 };
 const original=tuples(primitive(before));
 for(const t of tuples(primitive(after)))assert.ok(original.has(t));
 assert.equal(primitive(after).getAttribute('NORMAL').getComponentType(),5120);
});
test('invalid or unreachable targets fail safely rather than removing all geometry',()=>{
 for(const targetTriangles of [0,-1,NaN,2.5])assert.throws(()=>geometryPlan({sourceTriangles:1000,targetTriangles}));
 assert.equal(geometryPlan({sourceTriangles:1000,targetTriangles:50000}).ratio,1);
});

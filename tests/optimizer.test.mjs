import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, WebIO, Accessor } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { optimizeGlb, MOBILE_PRESETS, countTriangles, resizeTextures } from '../src/glb-optimize.js';
import { inspectGlb } from '../src/format.js';

// A subdivided plane similar to a dense static Meshy prop, with all vertices used.
async function createDenseGlb(n = 32) {
  const doc = new Document(), buffer = doc.createBuffer();
  const positions=[], indices=[];
  for(let y=0;y<=n;y++) for(let x=0;x<=n;x++)
    positions.push(x/n,y/n,0.03*Math.sin(x*.4)*Math.cos(y*.3));
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const a=y*(n+1)+x,b=a+1,c=a+n+1,d=c+1;
    indices.push(a,b,c,b,d,c);
  }
  const position=doc.createAccessor().setType(Accessor.Type.VEC3)
    .setBuffer(buffer).setArray(new Float32Array(positions));
  const index=doc.createAccessor().setType(Accessor.Type.SCALAR)
    .setBuffer(buffer).setArray(new Uint32Array(indices));
  const primitive=doc.createPrimitive().setAttribute('POSITION',position)
    .setIndices(index);
  const mesh=doc.createMesh('Test').addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode('DenseProp').setMesh(mesh));
  return new WebIO().writeBinary(doc);
}
test('the 1024-balanced profile really enables geometry simplification',()=>{
  assert.equal(MOBILE_PRESETS.balanced.texture,1024);
  assert.ok(MOBILE_PRESETS.balanced.ratio<1);
});
test('countTriangles returns number of actual triangle indices',async()=>{
  const glb=await createDenseGlb(8);
  const doc=await new WebIO().readBinary(glb);
  assert.equal(countTriangles(doc),128);
  assert.equal(inspectGlb(glb).meshes,1);
});
test('actual optimization reduces triangles and bytes in unskinned GLB',async()=>{
  const glb=await createDenseGlb(32);
  const result=await optimizeGlb(glb,{
    texture:1024, ratio:.40, error:.04
  });
  assert.ok(result.optimizedTriangles<result.sourceTriangles,
    'the optimizer must change triangle counts');
  assert.ok(result.afterBytes<result.beforeBytes,
    'optimizer must not increase GLB size');
  const out=inspectGlb(result.bytes);
  assert.equal(out.meshes,1);
  assert.equal(out.skins,0);
});

test('required EXT_texture_webp loads and remains valid without re-encoding original textures',async()=>{
 const doc=new Document(),buffer=doc.createBuffer();
 const positions=doc.createAccessor().setType(Accessor.Type.VEC3).setBuffer(buffer)
   .setArray(new Float32Array([0,0,0,1,0,0,0,1,0]));
 const indices=doc.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer)
   .setArray(new Uint16Array([0,1,2]));
 const image=Uint8Array.from(Buffer.from(
   'UklGRloAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAlpaWlgBWUDggLgAAABACAJ0BKgIAAgABQCYloAJ0ugH4AfgAA8gA/u1N3/1Z9NCL+9f/9Tgwc+fj/AA=',
   'base64'));
 doc.createExtension(EXTTextureWebP).setRequired(true);
 const texture=doc.createTexture().setMimeType('image/webp').setImage(image);
 const material=doc.createMaterial().setBaseColorTexture(texture);
 const prim=doc.createPrimitive().setAttribute('POSITION',positions)
  .setIndices(indices).setMaterial(material);
 const mesh=doc.createMesh().addPrimitive(prim);
 doc.createScene().addChild(doc.createNode().setMesh(mesh));
 const io=new WebIO().registerExtensions(ALL_EXTENSIONS);
 const glb=await io.writeBinary(doc);
 const loaded=await io.readBinary(glb);
 assert.equal(loaded.getRoot().listTextures()[0].getMimeType(),'image/webp');
 const original=globalThis.createImageBitmap;
 const previousWindow=globalThis.window;
 globalThis.window={};
 globalThis.createImageBitmap=async()=>({width:2,height:2,close(){}});
 try{
   const stats=await resizeTextures(loaded,1024);
   assert.equal(stats.unchanged,1);
   const output=await io.writeBinary(loaded);
   const reread=await io.readBinary(output);
   assert.equal(reread.getRoot().listTextures()[0].getMimeType(),'image/webp');
   assert.ok(reread.getRoot().listExtensionsRequired().some(x=>x.extensionName==='EXT_texture_webp'));
 }finally{globalThis.createImageBitmap=original;globalThis.window=previousWindow}
});

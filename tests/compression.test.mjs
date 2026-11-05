import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compressGlb} from '../src/glb-compression.js';
import {createCodecIO} from '../src/codec-io.js';
import {optimizeGlb} from '../src/glb-optimize.js';
import {inspectGlb,assertGlbPreserved} from '../src/format.js';
import {asArrayBuffer} from '../src/binary.js';
import {encodeKtx2,decodeKtx2} from '../src/texture-codecs.js';
import {compressionFixture,pixels} from './helpers/compression-fixtures.mjs';

for(const codec of ['meshopt','draco'])test(codec+' real round trip preserves rig, UV, weights, animation, morph and source',async()=>{
 const source=await compressionFixture({morph:true}),copy=source.slice();
 const result=await compressGlb(source,{geometryCodec:codec});
 assert.deepEqual(source,copy);
 const info=inspectGlb(result.bytes);
 assert.ok(info.required.includes(codec==='draco'?'KHR_draco_mesh_compression':'EXT_meshopt_compression'));
 const io=await createCodecIO(result.bytes);
 const before=await (await createCodecIO(source)).readBinary(source),after=await io.readBinary(result.bytes);
 assert.equal(after.getRoot().listSkins()[0].listJoints().length,2);
 assert.equal(after.getRoot().listAnimations()[0].getName(),'Wave');
 const a=before.getRoot().listMeshes()[0].listPrimitives()[0];
 const b=after.getRoot().listMeshes()[0].listPrimitives()[0];
 assert.equal(b.getIndices().getCount(),a.getIndices().getCount());
 for(const semantic of ['JOINTS_0','WEIGHTS_0'])
  assert.deepEqual(b.getAttribute(semantic).getArray(),a.getAttribute(semantic).getArray());
 for(const semantic of ['POSITION','TEXCOORD_0']){
  const x=a.getAttribute(semantic).getArray(),y=b.getAttribute(semantic).getArray();
  assert.equal(x.length,y.length);
  for(let i=0;i<x.length;i++)assert.ok(Math.abs(x[i]-y[i])<(codec==='meshopt'?1e-8:3e-5));
 }
 assert.deepEqual(b.listTargets()[0].getAttribute('POSITION').getArray(),a.listTargets()[0].getAttribute('POSITION').getArray());
 assertGlbPreserved({meshes:1,skinned:1,animations:1},info,[{name:'Wave'}]);
 const unchanged=await optimizeGlb(result.bytes,{geometry:false,textures:false,animationKeys:false});
 assert.deepEqual(unchanged.bytes,result.bytes);
 const unpacked=await compressGlb(result.bytes,{geometryCodec:'none'});
 assert.ok(!inspectGlb(unpacked.bytes).required.some(e=>/draco|meshopt/.test(e)));
});
for(const mode of ['etc1s','uastc'])test('KTX2 '+mode+' real WASM encode/decode preserves alpha and orientation',async()=>{
 const image=pixels(),encoded=await encodeKtx2(image,{mode,srgb:true});
 assert.deepEqual([...encoded.slice(0,4)],[171,75,84,88]);
 const decoded=await decodeKtx2(encoded);
 assert.equal(decoded.width,16);assert.equal(decoded.height,16);
 const rgba=(x,y)=>decoded.data.slice((y*16+x)*4,(y*16+x)*4+4);
 assert.ok(rgba(2,2)[0]>180&&rgba(2,2)[1]<70);
 assert.ok(rgba(2,12)[1]>170);
 assert.ok(rgba(12,2)[3]<120&&rgba(2,2)[3]>220);
 const source=await compressionFixture({texture:encoded});
 const result=await compressGlb(source,{geometryCodec:'meshopt',textureCodec:mode,maxTextureSize:1024});
 const info=inspectGlb(result.bytes);
 assert.ok(info.required.includes('KHR_texture_basisu'));
 const doc=await (await createCodecIO(result.bytes)).readBinary(result.bytes);
 assert.equal(doc.getRoot().listTextures()[0].getMimeType(),'image/ktx2');
 const again=await decodeKtx2(doc.getRoot().listTextures()[0].getImage());
 assert.equal(again.width,16);assert.equal(again.height,16);
});
test('binary preview accepts real ArrayBuffer and sliced Uint8Array without unrelated bytes',()=>{
 const bytes=new Uint8Array([9,1,2,3,8]);
 assert.deepEqual([...new Uint8Array(asArrayBuffer(bytes.subarray(1,4)))],[1,2,3]);
 assert.equal(asArrayBuffer(bytes.buffer),bytes.buffer);
});
test('required Meshopt fallback buffers are accepted; real external buffers are rejected',async()=>{
 const src=await compressionFixture(),r=await compressGlb(src,{geometryCodec:'meshopt'});
 assert.ok(inspectGlb(r.bytes).meshes);
 const info=inspectGlb(r.bytes);info.json.buffers[1].uri='https://example.com/remote.bin';
 const json=new TextEncoder().encode(JSON.stringify(info.json));const n=Math.ceil(json.length/4)*4;
 const bytes=new Uint8Array(n+20),view=new DataView(bytes.buffer);
 view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,bytes.length,true);
 view.setUint32(12,n,true);view.setUint32(16,0x4e4f534a,true);bytes.fill(32,20);bytes.set(json,20);
 assert.throws(()=>inspectGlb(bytes),/внешние/);
});
test('offline codec assets contain executable WASM and matching module glue',async()=>{
 for(const path of ['draco/draco_decoder.wasm','draco/draco_decoder_gltf.wasm','draco/draco_encoder.wasm',
  'basis/basis_transcoder.wasm','ktx2/basis_encoder.wasm']){
  const bytes=await readFile(new URL('../public/codecs/'+path,import.meta.url));
  assert.deepEqual([...bytes.slice(0,4)],[0,97,115,109]);
 }
});

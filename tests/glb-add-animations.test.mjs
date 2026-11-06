import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import validator from 'gltf-validator';
import {EXTTextureWebP} from '@gltf-transform/extensions';
import {appendGlbAnimations} from '../src/glb-add-animations.js';
import {inspectGlb} from '../src/format.js';
import {createCodecIO} from '../src/codec-io.js';
import {compressGlb} from '../src/glb-compression.js';
import {compressionFixture} from './helpers/compression-fixtures.mjs';

const webp=new Uint8Array(Buffer.from('UklGRloAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAlpaWlgBWUDggLgAAABACAJ0BKgIAAgABQCYloAJ0ugH4AfgAA8gA/u1N3/1Z9NCL+9f/9Tgwc+fj/AA=','base64'));
function clip(name='New motion'){
 const times=[0,.5,1],q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),.7).toArray();
 return new THREE.AnimationClip(name,1,[new THREE.QuaternionKeyframeTrack('Arm.quaternion',times,[0,0,0,1,...q,0,0,0,1]),new THREE.VectorKeyframeTrack('Hips.position',times,[0,0,0,.1,.2,.3,.2,.4,.6]),new THREE.VectorKeyframeTrack('Arm.scale',times,[1,1,1,1,1.1,1,1,1,1],THREE.InterpolateDiscrete)]);
}
function binary(bytes){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);for(let off=12;off<bytes.length;){const n=view.getUint32(off,true);if(view.getUint32(off+4,true)===0x004e4942)return bytes.subarray(off+8,off+8+n);off+=8+n}throw Error('No BIN')}
async function fixture(){
 const bytes=await compressionFixture({morph:true,texture:webp,textureMime:'image/webp'}),io=await createCodecIO(bytes),doc=await io.readBinary(bytes);doc.createExtension(EXTTextureWebP).setRequired(true);doc.getRoot().setExtras({custom:'retain'});return io.writeBinary(doc);
}
for(const codec of ['keep','meshopt','draco'])test('BVH append keeps original '+codec+' geometry, WebP, morphs, skin and clips byte-for-byte',async()=>{
 let source=await fixture();if(codec!=='keep')source=(await compressGlb(source,{geometryCodec:codec})).bytes;const copy=source.slice(),motion=clip(),output=appendGlbAnimations(source,[motion]),a=inspectGlb(source).json,b=inspectGlb(output).json;
 assert.deepEqual(source,copy);assert.deepEqual(binary(output).subarray(0,binary(source).length),binary(source),'original BIN must stay exact');
 for(const key of ['meshes','nodes','skins','images','textures','materials','extensionsUsed','extensionsRequired','extras'])assert.deepEqual(b[key],a[key],key+' changed');
 assert.deepEqual(b.accessors.slice(0,a.accessors.length),a.accessors);assert.deepEqual(b.bufferViews.slice(0,a.bufferViews.length),a.bufferViews);assert.deepEqual(b.animations.slice(0,a.animations.length),a.animations);
 assert.equal(b.animations.length,2);assert.equal(b.animations[1].samplers[0].input,b.animations[1].samplers[1].input,'identical key times share storage');assert.equal(b.animations[1].samplers[2].interpolation,'STEP');
 const report=await validator.validateBytes(output,{maxIssues:20});assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues));
 const io=await createCodecIO(output),d=await io.readBinary(output),animation=d.getRoot().listAnimations()[1];assert.equal(animation.getName(),motion.name);
 for(let i=0;i<motion.tracks.length;i++){assert.deepEqual(animation.listSamplers()[i].getInput().getArray(),motion.tracks[i].times);assert.deepEqual(animation.listSamplers()[i].getOutput().getArray(),motion.tracks[i].values)}
 assert.deepEqual(d.getRoot().listTextures()[0].getImage(),webp);assert.equal(d.getRoot().listSkins()[0].listJoints().length,2);
});
test('ambiguous bone names require explicit GLTFLoader node associations',async()=>{
 const source=await fixture(),io=await createCodecIO(source),doc=await io.readBinary(source);doc.getRoot().listScenes()[0].addChild(doc.createNode('Arm'));const bytes=await io.writeBinary(doc);
 assert.throws(()=>appendGlbAnimations(bytes,[clip()]),/Неоднозначная/);const index=inspectGlb(bytes).json.nodes.findIndex(n=>n.name==='Arm');assert.ok(appendGlbAnimations(bytes,[clip()],{nodeIndices:new Map([['Arm',index]])}).length>bytes.length);
});
test('invalid animation tracks and duplicate clip names fail before changing the source',async()=>{
 const bytes=await fixture(),before=bytes.slice();assert.throws(()=>appendGlbAnimations(bytes,[clip('Wave')]),/Повторное/);
 for(const mutate of [c=>c.tracks[0].times[1]=-.1,c=>c.tracks[0].values[3]=0,c=>c.tracks[0].name='Unknown.quaternion',c=>c.tracks.push(c.tracks[0])]){const c=clip();mutate(c);assert.throws(()=>appendGlbAnimations(bytes,[c]))}
 assert.deepEqual(appendGlbAnimations(bytes,[]),bytes);assert.deepEqual(bytes,before);
});

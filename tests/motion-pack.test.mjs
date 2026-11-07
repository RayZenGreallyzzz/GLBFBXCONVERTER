import test from 'node:test';import assert from 'node:assert/strict';import {zipSync,strToU8} from 'fflate';
import {openMotionPack,indexMotionZip} from '../src/motion-pack.js';import {motionBvh,namedBlob} from './helpers/motion-fixture.mjs';
test('ZIP indexes lazily and opens only the selected animation while retaining folder names',async()=>{
 const bytes=zipSync({'idle/Walk.bvh':strToU8(motionBvh),'run/Walk.bvh':strToU8(motionBvh),'textures/huge.png':new Uint8Array(2*1048576)},{level:0}),file=namedBlob('pack.zip',bytes);file.arrayBuffer=()=>{throw Error('whole archive must not be read')};
 const pack=await openMotionPack([file]);assert.equal(pack.length,2);assert.notEqual(pack[0].path,pack[1].path);assert.equal(new TextDecoder().decode(await pack[1].read()),motionBvh);
});
test('ZIP rejects traversal, duplicate paths and damaged entry data',async()=>{
 for(const files of [{'../bad.bvh':strToU8(motionBvh)},{'Walk.bvh':strToU8(motionBvh),'walk.bvh':strToU8(motionBvh)}])await assert.rejects(indexMotionZip(namedBlob('bad.zip',zipSync(files))));
 const bytes=zipSync({'bad.bvh':strToU8(motionBvh)},{level:0}),view=new DataView(bytes.buffer),begin=30+view.getUint16(26,true)+view.getUint16(28,true);bytes[begin]^=1;
 const pack=await openMotionPack([namedBlob('crc.zip',bytes)]);await assert.rejects(pack[0].read(),/Повреждён/);
});
test('glTF resolves its own BIN relative to its archive folder and blocks remote/missing resources',async()=>{
 const pack=await openMotionPack([namedBlob('pack.zip',zipSync({'folder/a.gltf':strToU8('{}'),'shared/a.bin':new Uint8Array([1,2,3]),'other/a.bin':new Uint8Array([9])}))]);assert.deepEqual(await pack[0].resource('../shared/a.bin'),new Uint8Array([1,2,3]));await assert.rejects(async()=>pack[0].resource('https://example.invalid/a.bin'),/Внешний/);await assert.rejects(async()=>pack[0].resource('missing.bin'),/BIN/);
 const loose=await openMotionPack([namedBlob('a.gltf','{}'),namedBlob('a.bin',new Uint8Array([4]))]);assert.deepEqual(await loose[0].resource('a.bin'),new Uint8Array([4]));
});

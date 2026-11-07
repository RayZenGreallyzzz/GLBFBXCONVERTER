import test from 'node:test';import assert from 'node:assert/strict';
import {loadMotionSource} from '../src/motion-import.js';import {importFbxMotion} from '../src/fbx-motion-client.js';
test('closing a preview before or during file reading prevents the animation parser from starting',async()=>{
 const controller=new AbortController();controller.abort();let reads=0;await assert.rejects(loadMotionSource({format:'glb',size:4,read:async()=>{reads++;return new Uint8Array(4)}},{signal:controller.signal}),e=>e.name==='AbortError');assert.equal(reads,0);
 const other=new AbortController();let complete;const pending=loadMotionSource({format:'fbx',size:4,read:()=>new Promise(resolve=>{complete=resolve})},{signal:other.signal});other.abort();complete(new Uint8Array(4));await assert.rejects(pending,e=>e.name==='AbortError');
});
test('aborting an FBX thumbnail terminates its worker and ignores a late result',async()=>{
 const previous=globalThis.Worker,workers=[];globalThis.Worker=class{constructor(){workers.push(this)}postMessage(data){this.data=data}terminate(){this.terminated=true}};
 try{const controller=new AbortController(),pending=importFbxMotion(new Uint8Array([1,2]),{signal:controller.signal});assert.equal(workers.length,1);controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(workers[0].terminated,true);workers[0].onmessage({data:{source:{invalid:true}}});
 }finally{globalThis.Worker=previous}
});

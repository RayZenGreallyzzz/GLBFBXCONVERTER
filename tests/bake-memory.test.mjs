import test from 'node:test';
import assert from 'node:assert/strict';
import {bakeMemoryBudget,resolveBakeMemoryBudget,checkBakeMemory} from '../src/bake-memory.js';
import {bakeGlbOffThread} from '../src/surface-bake-client.js';
import {readBakeGlb} from '../src/bake-common.js';

const roomy={totalMiB:7600,availableMiB:2400,thresholdMiB:400,lowMemory:false,lowRamDevice:false};
test('native available memory admits a 539 MiB task despite a coarse WebView value of 4',()=>{
 const budget=bakeMemoryBudget({android:true,deviceMemory:4,native:roomy});
 assert.equal(budget,768);assert.ok(budget>=539);
 assert.equal(bakeMemoryBudget({android:false,deviceMemory:4}),384);
});
test('native policy retains system headroom and caps small or low-RAM devices',()=>{
 assert.equal(bakeMemoryBudget({android:true,native:{...roomy,availableMiB:1400}}),500);
 assert.equal(bakeMemoryBudget({android:true,native:{...roomy,totalMiB:3800}}),512);
 assert.equal(bakeMemoryBudget({android:true,native:{...roomy,lowRamDevice:true}}),256);
 assert.equal(bakeMemoryBudget({android:true,native:{...roomy,totalMiB:2800}}),256);
});
test('low-memory Android snapshots block rather than falling back to a larger allowance',async()=>{
 assert.throws(()=>bakeMemoryBudget({android:true,native:{...roomy,lowMemory:true}}),/нехватке/);
 await assert.rejects(()=>resolveBakeMemoryBudget({android:true,readNative:async()=>({...roomy,availableMiB:450})}),/недостаточно/);
});
test('missing or invalid native information uses a conservative Android fallback',async()=>{
 assert.equal(await resolveBakeMemoryBudget({android:true,deviceMemory:8,readNative:async()=>{throw Error('old APK')}}),384);
 assert.equal(bakeMemoryBudget({android:true,deviceMemory:8,native:{...roomy,availableMiB:NaN}}),384);
 assert.equal(bakeMemoryBudget({android:true,deviceMemory:2}),256);
 assert.equal(await resolveBakeMemoryBudget({android:false,readNative:()=>{throw Error('must not query Android')}}),768);
});
test('an unresponsive native bridge times out to the conservative budget',{timeout:6000},async()=>{
 assert.equal(await resolveBakeMemoryBudget({android:true,deviceMemory:8,readNative:()=>new Promise(()=>{})}),384);
});
// The original elephant's counts/bytes and three 2048px decoded maps.
const stats={geometryBytes:106821712*2+2756460*40+5027674*38,
 projectionBytes:106821712*2+2756460*40+5027674*22+3*2048**2*4+2048**2*4+50000*250,
 mapBytesPerPixel:48,resolution:1024};
test('memory advice suggests smaller maps only when they actually fit',()=>{
 assert.equal(checkBakeMemory({...stats,memoryBudgetMiB:768}),539);
 assert.throws(()=>checkBakeMemory({...stats,memoryBudgetMiB:512}),/Выбери карты 512 px/);
 assert.throws(()=>checkBakeMemory({...stats,memoryBudgetMiB:384}),e=>/Уменьшения карт недостаточно/.test(e.message)&&!e.message.includes('Выбери карты'));
 assert.throws(()=>checkBakeMemory({...stats,memoryBudgetMiB:900}),/Неверный/);
});
function glb(json){
 const text=new TextEncoder().encode(JSON.stringify(json)),length=Math.ceil(text.length/4)*4,bytes=new Uint8Array(20+length),view=new DataView(bytes.buffer);
 view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,bytes.length,true);view.setUint32(12,length,true);view.setUint32(16,0x4e4f534a,true);bytes.fill(32,20);bytes.set(text,20);return bytes;
}
test('oversized geometry is rejected before decoding invalid buffer data',async()=>{
 const bytes=glb({asset:{version:'2.0'},buffers:[{byteLength:1}],accessors:[{componentType:5126,type:'VEC3',count:2756460},{componentType:5125,type:'SCALAR',count:5027674*3}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1}]}]});
 const copy=bytes.slice();await assert.rejects(()=>readBakeGlb(bytes,{memoryBudgetMiB:256}),/Расчётная память/);assert.deepEqual(bytes,copy);
});
test('each worker receives a fresh budget and a failed second check launches no projection',async()=>{
 const previous=globalThis.Worker,workers=[],original=new Uint8Array([1,2,3,4]);let reads=0;
 globalThis.Worker=class{constructor(){workers.push(this)}postMessage(data){this.data=data;queueMicrotask(()=>this.onmessage({data:{result:{bytes:new Uint8Array([9,8,7]),unchanged:false}}}))}terminate(){this.terminated=true}};
 try{
  await assert.rejects(()=>bakeGlbOffThread(original,{}, {readMemoryBudget:async()=>{if(++reads===1)return 768;throw Error('Android сообщает о нехватке памяти')}}),/нехватке/);
  assert.equal(reads,2);assert.equal(workers.length,1);assert.equal(workers[0].data.options.memoryBudgetMiB,768);assert.ok(workers[0].terminated);assert.deepEqual(original,new Uint8Array([1,2,3,4]));
  workers.length=0;reads=0;
  await bakeGlbOffThread(original,{memoryBudgetMiB:600},{readMemoryBudget:async()=>++reads===1?768:512});
  assert.deepEqual(workers.map(w=>w.data.options.memoryBudgetMiB),[600,512]);assert.ok(workers.every(w=>w.terminated));
 }finally{globalThis.Worker=previous}
});
test('cancelling during the memory query never starts a worker',async()=>{
 const previous=globalThis.Worker,abort=new AbortController();let workers=0;
 globalThis.Worker=class{constructor(){workers++}};
 try{await assert.rejects(()=>bakeGlbOffThread(new Uint8Array([1]),{},{signal:abort.signal,readMemoryBudget:async()=>{abort.abort();return 768}}),e=>e.name==='AbortError');assert.equal(workers,0)}finally{globalThis.Worker=previous}
});

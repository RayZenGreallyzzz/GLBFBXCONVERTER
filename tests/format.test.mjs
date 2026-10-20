import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectGlb,inspectFbx,assertGlbPreserved,modelStats} from '../src/format.js';
function glb(doc){
  const s=new TextEncoder().encode(JSON.stringify(doc));const size=Math.ceil(s.length/4)*4;
  const b=new Uint8Array(20+size);const v=new DataView(b.buffer);
  v.setUint32(0,0x46546c67,true);v.setUint32(4,2,true);v.setUint32(8,b.length,true);
  v.setUint32(12,size,true);v.setUint32(16,0x4e4f534a,true);b.fill(32,20);b.set(s,20);
  return b.buffer;
}
test('parse standard GLB',()=>{
 const r=inspectGlb(glb({asset:{version:'2.0'},meshes:[{}],animations:[{}]}));
 assert.equal(r.meshes,1);assert.equal(r.animations,1);
});
test('reject broken GLB',()=>assert.throws(()=>inspectGlb(new Uint8Array(10)),/короткий/));
test('FBX version is read from header instead of filename',()=>{
 const m='Kaydara FBX Binary  \0\x1a\0',b=new Uint8Array(64);
 for(let i=0;i<m.length;i++)b[i]=m.charCodeAt(i);
 new DataView(b.buffer).setUint32(23,7300,true);
 assert.equal(inspectFbx(b).version,7300);
});
test('missing animations stop unsafe export',()=>{
 assert.throws(()=>assertGlbPreserved({meshes:1,skinned:0,animations:1},{meshes:1,skins:0,animations:0,json:{}},[]),/анимации/);
});
test('missing skin weights stop unsafe export',()=>{
 const output={meshes:1,skins:1,animations:0,json:{nodes:[{mesh:0,skin:0}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],skins:[{joints:[1]}]}};
 assert.throws(()=>assertGlbPreserved({meshes:1,skinned:1,animations:0},output,[]),/веса/);
});
test('empty model stats safe',()=>assert.equal(modelStats(null,[]).meshes,0));

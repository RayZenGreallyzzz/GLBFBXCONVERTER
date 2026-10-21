import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
globalThis.requestAnimationFrame ??= callback => setTimeout(callback,0);
import { importAdditional, exportAdditional, getExportWarnings,
 SUPPORTED_INPUTS, SUPPORTED_OUTPUTS, validateImportFiles } from '../src/model-formats.js';

function tinyMesh() {
 const root=new THREE.Group();
 const geo=new THREE.BoxGeometry(1,2,1);
 root.add(new THREE.Mesh(geo,new THREE.MeshStandardMaterial()));
 return root;
}
function input(name,blob) {
 const buf=blob instanceof ArrayBuffer?blob:typeof blob==='string'?
   new TextEncoder().encode(blob).buffer:blob;
 return [{name,size:buf.byteLength},buf];
}
test('offline format matrix includes all promised basic additions',()=>{
 for(const ext of ['gltf','vrm','obj','ply','stl','dae','usdz'])
   assert.ok(SUPPORTED_INPUTS.includes(ext),'import '+ext);
 for(const ext of ['gltf','obj','ply','stl','usdz'])
   assert.ok(SUPPORTED_OUTPUTS.includes(ext),'export '+ext);
 assert.equal(SUPPORTED_INPUTS.includes('usd'),false,'do not claim unsupported USD input');
});
test('OBJ round trip imports static triangles without internet',async()=>{
 const text=await exportAdditional('obj',tinyMesh());
 assert.equal(text.mime,'text/plain');
 assert.match(text.content,/^v /m);
 const [file,data]=input('mesh.obj',text.content);
 const result=await importAdditional(file,data);
 assert.ok(result.root);
 let faces=0;
 result.root.traverse(n=>{if(n.isMesh)faces++});
 assert.ok(faces>0);
});
test('PLY binary round trip',async()=>{
 const converted=await exportAdditional('ply',tinyMesh());
 assert.ok(converted.content?.byteLength>60);
 const [file,data]=input('mesh.ply',converted.content);
 const parsed=await importAdditional(file,data);
 assert.ok(parsed.root.children.length);
 assert.equal(parsed.clips.length,0);
});
test('STL binary round trip',async()=>{
 const converted=await exportAdditional('stl',tinyMesh());
 assert.ok(converted.content?.byteLength>80);
 const [file,data]=input('mesh.stl',converted.content);
 const parsed=await importAdditional(file,data);
 assert.ok(parsed.root.children.length);
});
test('warn before animation and texture loss on static formats',()=>{
 const warnings=getExportWarnings('obj',{skinned:1,bones:2,animations:4,textures:3});
 assert.ok(warnings.some(x=>x.includes('Скелет')));
 assert.ok(warnings.some(x=>x.includes('Анимации')));
 assert.ok(warnings.some(x=>x.includes('текстур')));
 assert.equal(getExportWarnings('gltf',{skinned:1,bones:2,animations:4,textures:3}).length,0);
});
test('reject unsupported file or huge assets',()=>{
 assert.throws(()=>validateImportFiles([{name:'model.usd',size:10}]),/формат/);
 assert.throws(()=>validateImportFiles([{name:'big.obj',size:300*1048576}]),/250/);
});

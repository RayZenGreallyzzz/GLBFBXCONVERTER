import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
globalThis.requestAnimationFrame ??= callback => setTimeout(callback,0);
import { importAdditional, importObjWithMaterials, exportAdditional, getExportWarnings,
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


test('OBJ with selected MTL applies named material without remote network',async()=>{
 const obj='mtllib hero.mtl\n' +
   'o Hero\n' +
   'v 0 0 0\nv 1 0 0\nv 0 1 0\n' +
   'vt 0 0\nvt 1 0\nvt 0 1\n' +
   'usemtl HeroColor\nf 1/1 2/2 3/3\n';
 const main={name:'hero.obj',size:obj.length};
 const mtl={name:'hero.mtl',size:40,async text(){
   return 'newmtl HeroColor\nKd 0.6 0.4 0.2\n';
 }};
 const result=await importObjWithMaterials(main,obj,[main,mtl]);
 assert.equal(result.root.children[0].material.name,'HeroColor');
 assert.ok(result.root.children[0].material.color.r>0);
 assert.ok(result.root.children[0].geometry.getAttribute('uv'));
 assert.match(result.notice,/OBJ \+ MTL/);
});
test('missing named MTL raises an error, never silently loses materials',async()=>{
 const text='mtllib special.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
 const main={name:'mesh.obj',size:text.length};
 await assert.rejects(
   importObjWithMaterials(main,text,[main]),
   /special.mtl/
 );
});
test('compact PLY keeps geometry, omits UV/normals and is smaller',async()=>{
 const scene=tinyMesh();
 const normal=await exportAdditional('ply',scene);
 const lite=await exportAdditional('ply-lite',scene);
 assert.ok(lite.content.byteLength<normal.content.byteLength,'compact PLY must be smaller');
 assert.equal(lite.mime,'application/octet-stream');
 const lightBuffer=lite.content instanceof ArrayBuffer ?lite.content:
   lite.content.buffer.slice(lite.content.byteOffset,lite.content.byteOffset+lite.content.byteLength);
 const header=new TextDecoder().decode(new Uint8Array(lightBuffer).subarray(0,450));
 assert.match(header,/binary_little_endian/);
 assert.match(header,/element vertex/);
 assert.doesNotMatch(header,/property float nx/);
 assert.doesNotMatch(header,/property float s\b/);
 const [file,buffer]=input('model.ply',lightBuffer);
 const parsed=await importAdditional(file,buffer);
 assert.ok(parsed.root.children.length>0);
 assert.ok(getExportWarnings('ply-lite',{textures:0,animations:0,skinned:0,bones:0})
   .some(t=>t.includes('UV')));
});
test('the modern Mixamo menu provides 2013 but does not advertise 2012',()=>{
 assert.ok(SUPPORTED_OUTPUTS.includes('fbx7300'));
 assert.ok(!SUPPORTED_OUTPUTS.includes('fbx7200'));
 assert.ok(SUPPORTED_OUTPUTS.includes('ply-lite'));
});

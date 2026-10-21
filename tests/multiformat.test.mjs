import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';
globalThis.requestAnimationFrame ??= callback => setTimeout(callback,0);
import { importAdditional, importObjWithMaterials, exportAdditional, getExportWarnings,
 SUPPORTED_INPUTS, SUPPORTED_OUTPUTS, validateImportFiles, outputNameExt as outputNameExtForTest } from '../src/model-formats.js';

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
test('OBJ ZIP contains linked OBJ and MTL, and plain OBJ can be imported',async()=>{
 const result=await exportAdditional('obj',tinyMesh(),[],{name:'hero'});
 assert.equal(result.mime,'application/zip');
 const files=unzipSync(result.content);
 assert.ok(files['hero.obj']);
 assert.ok(files['hero.mtl']);
 assert.ok(files['README.txt']);
 const obj=strFromU8(files['hero.obj']),mtl=strFromU8(files['hero.mtl']);
 assert.match(obj,/^mtllib hero\.mtl$/m);
 assert.match(obj,/^usemtl Mat_001_/m);
 assert.match(obj,/^v /m);
 assert.match(mtl,/^newmtl Mat_001_/m);
 const [file,data]=input('hero.obj',obj.replace(/^mtllib [^\n]+\n/,''));
 const parsed=await importAdditional(file,data);
 assert.ok(parsed.root);
 let faces=0;
 parsed.root.traverse(n=>{if(n.isMesh)faces++});
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


test('textured OBJ ZIP stores color PNG, matching MTL references, and UV transform',async()=>{
 const image=new THREE.DataTexture(new Uint8Array([
   255,0,0,255,0,255,0,255,
   0,0,255,255,255,255,255,255
 ]),2,2,THREE.RGBAFormat);
 image.name='Goblin_Albedo';image.needsUpdate=true;image.flipY=false;
 image.repeat.set(16,16);image.offset.set(0,.125);
 const mesh=new THREE.Mesh(new THREE.PlaneGeometry(1,1),
   new THREE.MeshStandardMaterial({name:'Goblin_Skin',map:image}));
 mesh.name='Goblin';
 const root=new THREE.Group();root.add(mesh);
 const beforeUV=Array.from(mesh.geometry.getAttribute('uv').array);
 const file=await exportAdditional('obj',root,[],{name:'goblin'});
 const parts=unzipSync(file.content);
 const obj=strFromU8(parts['goblin.obj']);
 const mtl=strFromU8(parts['goblin.mtl']);
 assert.equal(file.textures,1);
 assert.match(mtl,/^map_Kd texture_001_Goblin_Albedo\.png$/m);
 assert.ok(parts['texture_001_Goblin_Albedo.png']);
 const png=parts['texture_001_Goblin_Albedo.png'];
 assert.deepEqual([...png.slice(0,8)],[137,80,78,71,13,10,26,10]);
 assert.equal(new DataView(png.buffer,png.byteOffset+16).getUint32(0,false),2);
 assert.match(obj,/^mtllib goblin\.mtl$/m);
 assert.match(obj,/^usemtl Mat_001_Goblin_Skin$/m);
 const lines=obj.split('\n').filter(l=>l.startsWith('vt '));
 assert.ok(lines.length>0);
 const converted=lines.map(x=>x.split(' ').slice(1).map(Number));
 assert.ok(Math.max(...converted.map(x=>x[0]))>1,'texture repeat is baked into OBJ UV');
 assert.deepEqual(Array.from(mesh.geometry.getAttribute('uv').array),beforeUV,
   'source geometry must not be modified by archive creation');
 assert.equal(image.repeat.x,16);
 assert.equal(image.offset.y,.125);
});
test('OBJ ZIP preserves both material slots and images for one multi-material mesh',async()=>{
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.Float32BufferAttribute([
   0,0,0,1,0,0,1,1,0,0,1,0
 ],3));
 geometry.setAttribute('uv',new THREE.Float32BufferAttribute([
   0,0,1,0,1,1,0,1
 ],2));
 geometry.setIndex([0,1,2,0,2,3]);
 geometry.addGroup(0,3,0);geometry.addGroup(3,3,1);
 const colorTex=(name,c)=>{
   const t=new THREE.DataTexture(new Uint8Array([...c,255]),1,1,THREE.RGBAFormat);
   t.name=name;t.flipY=false;t.needsUpdate=true;return t;
 };
 const material1=new THREE.MeshStandardMaterial({name:'Armor',map:colorTex('armor',[1,2,3])});
 const material2=new THREE.MeshStandardMaterial({name:'Cape',map:colorTex('cape',[4,5,6])});
 const mesh=new THREE.Mesh(geometry,[material1,material2]);
 const src=new THREE.Group();src.add(mesh);
 const archived=await exportAdditional('obj',src,[],{name:'hero'});
 const unpacked=unzipSync(archived.content),obj=strFromU8(unpacked['hero.obj']);
 const mtl=strFromU8(unpacked['hero.mtl']);
 assert.equal((obj.match(/^usemtl /gm)||[]).length,2);
 assert.equal((obj.match(/^f /gm)||[]).length,2);
 assert.equal((mtl.match(/^map_Kd /gm)||[]).length,2);
 assert.equal(archived.textures,2);
 assert.ok(unpacked['texture_001_armor.png']);
 assert.ok(unpacked['texture_002_cape.png']);
 assert.equal(mesh.material[0],material1);
 assert.equal(mesh.material[1],material2);
});
test('OBJ with texture that cannot be encoded fails instead of dropping PNG',async()=>{
 const texture=new THREE.Texture(); texture.name='MissingTexture';
 const scene=new THREE.Group();
 scene.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1),
   new THREE.MeshStandardMaterial({map:texture})));
 await assert.rejects(exportAdditional('obj',scene,[],{name:'test'}),/нет изображения/);
});
test('OBJ no longer incorrectly warns that texture images are dropped',()=>{
 const warnings=getExportWarnings('obj',{skinned:1,bones:3,animations:1,textures:2});
 assert.ok(!warnings.some(s=>s.includes('Изображения текстур не будут сохранены')));
 assert.ok(warnings.some(s=>s.includes('PBR')));
 assert.equal(outputNameExtForTest('obj'),'.zip');
});


test('Mixamo ZIP is only OBJ, MTL, Albedo PNG with simple color material',async()=>{
 const rgba=new THREE.DataTexture(
   new Uint8Array([220,100,20,255,22,110,40,255,55,60,230,255,80,90,100,255]),
   2,2,THREE.RGBAFormat);
 rgba.name='Albedo_Goblin';rgba.flipY=false;rgba.needsUpdate=true;
 const normals=new THREE.DataTexture(new Uint8Array(16).fill(127),2,2,THREE.RGBAFormat);
 normals.name='Normal_Goblin';normals.flipY=false;normals.needsUpdate=true;
 normals.repeat.set(3,3);
 rgba.repeat.set(16,16);
 const scene=new THREE.Group();
 scene.add(new THREE.Mesh(new THREE.BoxGeometry(),
   new THREE.MeshStandardMaterial({name:'GreenSkin',map:rgba,normalMap:normals})));
 const archive=await exportAdditional('obj-mixamo',scene,[],{name:'goblin'});
 const files=unzipSync(archive.content),names=Object.keys(files).sort();
 assert.deepEqual(names,['goblin.mtl','goblin.obj','texture_001_Albedo_Goblin.png']);
 assert.equal(archive.profile,'mixamo');
 const mtl=strFromU8(files['goblin.mtl']),obj=strFromU8(files['goblin.obj']);
 assert.match(mtl,/^map_Kd texture_001_Albedo_Goblin\.png$/m);
 assert.match(mtl,/^illum 1$/m);
 assert.match(mtl,/^Ks 0 0 0$/m);
 assert.doesNotMatch(mtl,/^(?:norm|map_Pr|map_Pm|map_Bump)\s/m);
 assert.match(obj,/^mtllib goblin\.mtl$/m);
 assert.match(obj,/^usemtl Mat_001_GreenSkin$/m);
 assert.equal(rgba.repeat.x,16,'source UV transformation is unchanged');
 assert.equal(normals.repeat.x,3,'PBR normal transformation is unchanged');
});
test('Mixamo profile warns, but does not reject meshes over 350k',async()=>{
 const {mixamoQualityAdvice,countMixamoTriangles,MIXAMO_RECOMMENDED_FACES} =
   await import('../src/obj-zip.js');
 const scene=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),
   new THREE.MeshBasicMaterial());
 mesh.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(350001*3),1));
 scene.add(mesh);
 assert.equal(countMixamoTriangles(scene),350001);
 assert.equal(MIXAMO_RECOMMENDED_FACES,350000);
 assert.ok(mixamoQualityAdvice(countMixamoTriangles(scene),2048)
   .some(w=>w.includes('треугольников')));
 assert.deepEqual(mixamoQualityAdvice(313718,1024),[]);
});
test('selectable max Albedo: 512 vs 2048 preserves real source resolution',async()=>{
 const pixels=new Uint8Array(1024*512*4).fill(155);
 const texture=new THREE.DataTexture(pixels,1024,512,THREE.RGBAFormat);
 texture.name='Albedo_Quality';texture.needsUpdate=true;texture.flipY=false;
 const scene=new THREE.Group();
 scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1,1),
   new THREE.MeshBasicMaterial({map:texture})));
 const lo=await exportAdditional('obj-mixamo',scene,[],{name:'low',mixamoTextureSize:512});
 const hi=await exportAdditional('obj-mixamo',scene,[],{name:'high',mixamoTextureSize:2048});
 const zLow=unzipSync(lo.content),zHigh=unzipSync(hi.content);
 const filename='texture_001_Albedo_Quality.png';
 const width=png=>new DataView(png.buffer,png.byteOffset+16).getUint32(0,false);
 assert.equal(width(zLow[filename]),512);
 assert.equal(width(zHigh[filename]),1024);
 assert.ok(lo.content.byteLength>0&&hi.content.byteLength>0);
 assert.equal(texture.image.width,1024,'source texture should be unmodified');
});

test('Mixamo profile keeps material color for untextured geometry',async()=>{
 const scene=new THREE.Group();
 scene.add(new THREE.Mesh(new THREE.PlaneGeometry(),
   new THREE.MeshStandardMaterial({color:0x558855})));
 const result=await exportAdditional('obj-mixamo',scene,[],{name:'simple'});
 const z=unzipSync(result.content);
 assert.deepEqual(Object.keys(z).sort(),['simple.mtl','simple.obj']);
 assert.match(strFromU8(z['simple.mtl']),/Kd 0\.\d+ 0\.\d+ 0\.\d+/);
 assert.ok(getExportWarnings('obj-mixamo',{skinned:1,bones:3,animations:1,textures:2})
   .some(w=>w.includes('Albedo')));
});

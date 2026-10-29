import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {unzipSync,zipSync,strToU8,strFromU8} from 'fflate';
import {extractModelZip} from '../src/model-archive.js';
import {exportTextured3mf} from '../src/three-mf.js';
import {makeVrm1,addVrm1Extension,detectHumanoidBones} from '../src/vrm-export.js';
import {inspectGlb} from '../src/format.js';
import {SUPPORTED_INPUTS,SUPPORTED_OUTPUTS,getExportWarnings} from '../src/model-formats.js';

function glb(doc){
 const raw=new TextEncoder().encode(JSON.stringify(doc));
 const len=Math.ceil(raw.length/4)*4,b=new Uint8Array(20+len),dv=new DataView(b.buffer);
 dv.setUint32(0,0x46546c67,true);dv.setUint32(4,2,true);
 dv.setUint32(8,b.length,true);dv.setUint32(12,len,true);
 dv.setUint32(16,0x4e4f534a,true);b.fill(32,20);b.set(raw,20);
 return b;
}
function humanoid(){
 const names=['Hips','Spine','Head',
 'LeftArm','LeftForeArm','LeftHand','RightArm','RightForeArm','RightHand',
 'LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'];
 const children={
 Hips:['Spine','LeftUpLeg','RightUpLeg'],Spine:['Head','LeftArm','RightArm'],
 LeftArm:['LeftForeArm'],LeftForeArm:['LeftHand'],RightArm:['RightForeArm'],
 RightForeArm:['RightHand'],LeftUpLeg:['LeftLeg'],LeftLeg:['LeftFoot'],
 RightUpLeg:['RightLeg'],RightLeg:['RightFoot']
 };
 return {asset:{version:'2.0'},nodes:names.map(n=>({name:'mixamorig:'+n,
   children:(children[n]||[]).map(child=>names.indexOf(child))})),
   meshes:[{primitives:[{attributes:{POSITION:0,JOINTS_0:1,WEIGHTS_0:2}}]}],
   skins:[{joints:names.map((_,i)=>i)}]};
}
test('VRM export rejects ordinary static mesh instead of lying about humanoid support',()=>{
 assert.throws(()=>addVrm1Extension({nodes:[],skins:[]}),/скелетом/);
});
test('VRM export maps exactly the required Mixamo bones, with new glTF extension',()=>{
 const doc=humanoid(),input=glb(doc),before=JSON.stringify(doc);
 const result=makeVrm1(input,{name:'Wolf Guardian',author:'Creator'});
 const out=inspectGlb(result).json,ext=out.extensions.VRMC_vrm;
 assert.equal(ext.specVersion,'1.0');
 assert.equal(ext.meta.name,'Wolf Guardian');
 assert.equal(ext.meta.authors[0],'Creator');
 assert.equal(ext.meta.licenseUrl,'https://vrm.dev/licenses/1.0/');
 assert.equal(ext.humanoid.humanBones.hips.node,0);
 assert.equal(ext.humanoid.humanBones.leftUpperArm.node,3);
 assert.equal(ext.humanoid.humanBones.rightLowerLeg.node,13);
 assert.ok(out.extensionsUsed.includes('VRMC_vrm'));
 assert.equal(JSON.stringify(doc),before,'source JSON must remain unchanged');
});
test('VRM rejects incomplete and invalid hierarchy instead of writing mislabeled GLB',()=>{
 const missing=humanoid();missing.nodes.find(n=>n.name.endsWith('LeftHand')).name='Unmapped';
 assert.ok(detectHumanoidBones(missing).missing.includes('leftHand'));
 assert.throws(()=>addVrm1Extension(missing),/leftHand/);
 const broken=humanoid();broken.nodes[4].children=[];
 assert.throws(()=>addVrm1Extension(broken),/иерархия/);
});
test('ZIP import finds OBJ and MTL and rejects malicious traversal and duplicates',async()=>{
 const zip=zipSync({'hero.obj':strToU8('v 0 0 0'),'hero.mtl':strToU8('newmtl hero'),
  'texture.png':new Uint8Array([137,80,78,71])});
 const archive=extractModelZip(zip);
 assert.equal(archive.format,'obj');
 assert.equal(archive.files.length,3);
 assert.ok(await archive.file.text());
 assert.throws(()=>extractModelZip(zipSync({'../evil.obj':strToU8('test')})),/Небезопасный/);
 assert.throws(()=>extractModelZip(zipSync({'a/model.obj':strToU8('v 1'),
  'b/model.obj':strToU8('v 2')})),/одинаковыми именами/);
});
test('3MF package embeds PNG, UV texture group, triangle indices and image relationships',async()=>{
 const map=new THREE.DataTexture(new Uint8Array([
   255,0,0,255,0,255,0,255,0,0,255,255,255,255,0,255
 ]),2,2,THREE.RGBAFormat);
 map.flipY=false;map.needsUpdate=true;
 const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),
  new THREE.MeshStandardMaterial({map}));
 const scene=new THREE.Group();scene.add(mesh);
 const exported=await exportTextured3mf(scene,{name:'Color Cube',unitScale:1000});
 const files=unzipSync(exported.content);
 const xml=strFromU8(files['3D/3dmodel.model']);
 const rels=strFromU8(files['3D/_rels/3dmodel.model.rels']);
 assert.ok(files['[Content_Types].xml']);
 assert.match(strFromU8(files['[Content_Types].xml']),/3dmanufacturing-3dmodeltexture/);
 assert.ok(files['_rels/.rels']);
 assert.ok(files['3D/Textures/texture_001.png']);
 assert.deepEqual([...files['3D/Textures/texture_001.png'].slice(0,8)],
  [137,80,78,71,13,10,26,10]);
 assert.match(xml,/unit="millimeter"/);
 assert.doesNotMatch(xml,/requiredextensions=/,'texture extension is optional for non-texture-aware viewers');
 assert.match(xml,/<m:texture2d /);
 assert.match(xml,/<m:texture2dgroup /);
 assert.match(xml,/<m:tex2coord /);
 assert.match(xml,/<triangle [^>]+pid="[0-9]+" p1="\d+" p2="\d+" p3="\d+"/);
 assert.match(rels,/3dtexture/);
 assert.equal(exported.textures,1);
 assert.equal(exported.triangles,12);
 assert.equal(mesh.geometry.getAttribute('position').count,24);
});
test('3MF scale 1m->1000mm and 1mm->1mm are different',async()=>{
 const scene=new THREE.Group();
 scene.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1),
  new THREE.MeshBasicMaterial({color:0x884422})));
 const a=strFromU8(unzipSync((await exportTextured3mf(scene,{unitScale:1000})).content)['3D/3dmodel.model']);
 const b=strFromU8(unzipSync((await exportTextured3mf(scene,{unitScale:1})).content)['3D/3dmodel.model']);
 assert.match(a,/x="-500"/);
 assert.match(b,/x="-0.5"/);
 assert.match(a,/<basematerials /);
 assert.doesNotMatch(a,/requiredextensions=/,'untextured 3MF must not demand materials support');
 assert.doesNotMatch(a,/<m:texture2d /);
});
test('catalog/UI advertise VRM and 3MF and warn about unavoidable loss of animation',async()=>{
 const fs=await import('node:fs');
 const html=fs.readFileSync('index.html','utf8');
 const main=fs.readFileSync('src/main.js','utf8');
 for(const name of ['3mf','vrm'])assert.ok(SUPPORTED_OUTPUTS.includes(name));
 assert.ok(SUPPORTED_INPUTS.includes('3mf'));
 assert.match(html,/value="3mf"/);
 assert.match(html,/value="vrm"/);
 assert.ok(main.includes("makeVrm1(glb,"));
 assert.ok(main.includes("printTextureSize:target==='3mf'"));
 const warning=getExportWarnings('3mf',{skinned:1,bones:20,animations:3,textures:1});
 assert.ok(warning.some(s=>s.includes('Скелет')));
 assert.ok(warning.some(s=>s.includes('Анимации')));
 assert.ok(warning.some(s=>s.includes('Albedo')));
});

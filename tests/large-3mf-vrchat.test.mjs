import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {unzipSync,strFromU8} from 'fflate';
import {exportTextured3mf} from '../src/three-mf.js';
import {inspectVRChatAvatar,assertVRChatReady} from '../src/vrchat-preflight.js';
import {modelStats} from '../src/format.js';

// User's FoxGi has 1,936,208 triangles; the old arbitrary 650k cap rejected it.
// Huge index buffer, few unique vertices, to keep synthetic test practical.
test('3MF exports 1,936,208 triangles without reducing or refusing geometry',async()=>{
 const triangles=1_936_208;
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.Float32BufferAttribute([
  0,0,0, 1,0,0, 0,1,0, 1,1,0
 ],3));
 const indices=new Uint32Array(triangles*3);
 for(let i=0;i<triangles;i++){
  indices[3*i]=0;indices[3*i+1]=1;indices[3*i+2]=i%2?2:3;
 }
 geometry.setIndex(new THREE.BufferAttribute(indices,1));
 const root=new THREE.Group();
 root.add(new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:0x49aaff})));
 const seen=[];
 const result=await exportTextured3mf(root,{unitScale:1000,onProgress:p=>seen.push(p)});
 assert.equal(result.triangles,triangles);
 const parts=unzipSync(result.content);
 const xml=strFromU8(parts['3D/3dmodel.model']);
 assert.equal((xml.match(/<triangle /g)||[]).length,triangles,'every triangle is actually exported');
 assert.ok(seen.includes(100));
 assert.match(xml,/unit="millimeter"/);
 assert.match(xml,/v1="0" v2="1" v3="3"/);
 assert.ok(result.content.length>1000);
});
test('3MF keeps embedded albedo texture and UV with new streaming writer',async()=>{
 const tex=new THREE.DataTexture(new Uint8Array([255,0,0,255,0,0,255,255,0,255,0,255,255,255,0,255]),2,2,THREE.RGBAFormat);
 tex.flipY=false;tex.needsUpdate=true;
 const root=new THREE.Group();
 root.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({map:tex})));
 const out=await exportTextured3mf(root);
 const archive=unzipSync(out.content);
 const model=strFromU8(archive['3D/3dmodel.model']);
 assert.ok(archive['3D/Textures/texture_001.png']);
 assert.match(model,/<m:tex2coord /);
 assert.match(model,/<m:texture2dgroup /);
 assert.match(model,/<triangle [^>]+ p1="\d+" p2="\d+" p3="\d+"/);
 assert.match(strFromU8(archive['[Content_Types].xml']),/3dmanufacturing-3dmodeltexture/);
});
function makeRig(){
 const root=new THREE.Group();
 const names=['Hips','Spine','Head','LeftArm','LeftForeArm','LeftHand',
 'RightArm','RightForeArm','RightHand','LeftUpLeg','LeftLeg','LeftFoot',
 'RightUpLeg','RightLeg','RightFoot'];
 const hips=new THREE.Bone();hips.name='mixamorigHips';root.add(hips);
 for(const n of names.slice(1)){const b=new THREE.Bone();b.name='mixamorig'+n;hips.add(b);}
 return root;
}
test('VRChat mode never labels unrigged FoxGi as ready avatar',()=>{
 const root=new THREE.Group();
 root.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial()));
 const report=inspectVRChatAvatar(root,modelStats(root,[]));
 assert.equal(report.rigged,false);
 assert.ok(report.missing.includes('hips'));
 assert.throws(()=>assertVRChatReady(report),/гуманоидный скелет/);
});
test('VRChat mode recognizes humanoid Mixamo rig and warns but never blocks high triangle counts',()=>{
 const root=makeRig();
 const r=inspectVRChatAvatar(root,{triangles:1_936_208,skinned:1,bones:15,materials:1,textures:3});
 assert.equal(r.rigged,true);
 assert.ok(r.pcHeavy);
 assert.ok(r.androidHighPoly);
 assert.equal(assertVRChatReady(r),true);
 assert.ok(r.recommendations.some(x=>x.includes('Unity')));
});
test('VRChat UI and 3MF progress are wired into converter',async()=>{
 const {readFileSync}=await import('node:fs');
 const html=readFileSync('index.html','utf8');
 const js=readFileSync('src/main.js','utf8');
 const fmt=readFileSync('src/model-formats.js','utf8');
 assert.match(html,/value="vrchat-fbx"/);
 assert.match(html,/id="vrchat-settings"/);
 assert.match(js,/target==='vrchat-fbx'/);
 assert.match(js,/inspectVRChatAvatar\(state.root,current\)/);
 assert.match(js,/printProgress:/);
 assert.match(fmt,/onProgress:options.printProgress/);
});

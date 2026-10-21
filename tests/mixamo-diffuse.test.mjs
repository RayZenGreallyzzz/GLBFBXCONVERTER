import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { inspectFbx } from '../src/format.js';
import { prepareMixamoDiffuse, exportMixamoDiffuse,
 inspectDiffuseExportPlan } from '../src/mixamo-diffuse.js';

function fixture() {
 const root=new THREE.Group();
 const geometry=new THREE.BoxGeometry(1,2,1);
 const albedo=new THREE.DataTexture(new Uint8Array([
   22,120,33,255, 16,77,200,255,
   200,160,9,255, 10,66,24,255
 ]),2,2,THREE.RGBAFormat);
 albedo.colorSpace=THREE.SRGBColorSpace;
 albedo.name='Tree_Albedo';
 albedo.flipY=false;albedo.needsUpdate=true;
 const normal=new THREE.DataTexture(new Uint8Array(16).fill(128),2,2,THREE.RGBAFormat);
 normal.name='Tree_Normal'; normal.flipY=false;
 const material=new THREE.MeshStandardMaterial({
   name:'TreePBR',map:albedo,normalMap:normal,
   metalness:.75,roughness:.3,color:0xffffff
 });
 const mesh=new THREE.Mesh(geometry,material);mesh.name='Tree';
 root.add(mesh);
 return {root,mesh,material,normal,albedo};
}
for(const version of [7200,7300]) {
 test('real FBX '+version+' embeds Diffuse PNG but not normal texture and restores source',async()=>{
   const {root,mesh,material,normal,albedo}=fixture();
   const sourceUV=mesh.geometry.attributes.uv.array.slice();
   const output=await exportMixamoDiffuse(root,[],version,FBXExporter,
     {maxTextureSize:2048});
   const info=inspectFbx(output.bytes);
   assert.equal(info.version,version);
   assert.equal(output.manifest.embeddedPNG,1);
   assert.equal(output.manifest.diffuseConnections,1);
   assert.equal(output.sourceMaps,1);
   const raw=output.bytes;
   const signature=[137,80,78,71,13,10,26,10];
   let pngFound=false;
   for(let i=0;i<raw.length-signature.length;i++){
     if(signature.every((x,j)=>raw[i+j]===x)){pngFound=true;break}
   }
   assert.ok(pngFound,'PNG bytes must be inside FBX');
   const asText=new TextDecoder('latin1').decode(raw);
   assert.ok(asText.includes('Tree_Albedo'),'FBX must refer to albedo image');
   assert.ok(!asText.includes('Tree_Normal'),'FBX must not embed normal map');
   assert.equal(mesh.material,material,'original material must be restored');
   assert.equal(material.normalMap,normal);
   assert.equal(material.map,albedo);
   assert.deepEqual(Array.from(mesh.geometry.attributes.uv.array),Array.from(sourceUV));
 });
}
test('temporary Diffuse material contains map only, no PBR maps, and can be restored',()=>{
 const {root,mesh,material}=fixture();
 const session=prepareMixamoDiffuse(root,{maxTextureSize:512});
 assert.ok(mesh.material.isMeshPhongMaterial);
 assert.ok(mesh.material.normalMap == null);
 assert.ok(mesh.material.metalnessMap == null);
 assert.equal(mesh.material.map,material.map);
 assert.equal(session.maps,1);
 session.restore();
 assert.equal(mesh.material,material);
});
test('conversion refuses to leave an untextured FBX when source had Albedo',async()=>{
 const {root,mesh,material}=fixture();
 class BrokenExporter {
   register(callback){this.callback=callback;return this}
   async parseAsync(){
     this.callback({textures:{textures:new Map()},connections:[]});
     return new Uint8Array(200);
   }
 }
 await assert.rejects(
   exportMixamoDiffuse(root,[],7200,BrokenExporter),
   /потерял цветные текстуры/
 );
 assert.equal(mesh.material,material,'restore must run even on failure');
});

test('bakes 16x atlas transform into mesh UVs and emits identity texture transform',async()=>{
 const {root,mesh,material,albedo}=fixture();
 const originalUV=mesh.geometry.getAttribute('uv');
 const before=Array.from(originalUV.array);
 // Simulates exact issue from uploaded FBX: U=0..1/16, V=15/16..1
 // while FBX Texture.Scaling is (16,16), ignored by Mixamo.
 for(let i=0;i<originalUV.count;i++){
   originalUV.setXY(i,originalUV.getX(i)/16,(15+originalUV.getY(i))/16);
 }
 albedo.repeat.set(16.0028954,15.9872437);
 albedo.offset.set(.000034,.00101);
 albedo.updateMatrix();
 const source=mesh.geometry;
 const session=prepareMixamoDiffuse(root,{maxTextureSize:2048});
 try {
   assert.notEqual(mesh.geometry,source,'temporary geometry clone must be used');
   assert.notEqual(mesh.material,material,'temporary material must be used');
   assert.equal(mesh.material.map.repeat.x,1,'FBX texture must have identity scale');
   assert.equal(mesh.material.map.repeat.y,1);
   assert.equal(mesh.material.map.offset.y,0,'no offset is left on exported texture');
   const uv=mesh.geometry.getAttribute('uv');
   const xs=[],ys=[];
   for(let i=0;i<uv.count;i++){xs.push(uv.getX(i));ys.push(uv.getY(i))}
   assert.ok(Math.max(...xs)-Math.min(...xs)>.9,'U range fills whole atlas, not tiny tile');
   assert.ok(Math.max(...ys)-Math.min(...ys)>.9,'V range fills whole atlas');
   assert.ok(Math.max(...ys)<1.02 && Math.min(...ys)>-.02,'integer tile offset removed');
   assert.equal(session.uvBaked,1);
 } finally { session.restore(); }
 assert.equal(mesh.geometry,source,'restore exact original geometry');
 assert.equal(mesh.material,material,'restore exact original material');
 assert.equal(albedo.repeat.x,16.0028954,'original texture remains unchanged');
 // Restore the fixture attribute for consistency, not needed elsewhere.
 originalUV.array.set(before);
});
test('incompatible UV transforms on a multi-material mesh fail safely',()=>{
 const {root,mesh,material,albedo}=fixture();
 const second=material.clone();
 second.map=albedo.clone();second.map.offset.x=.25;
 mesh.material=[material,second];
 const originalGeometry=mesh.geometry,originalMaterials=mesh.material;
 assert.throws(()=>prepareMixamoDiffuse(root),/разные преобразования Albedo/);
 assert.equal(mesh.geometry,originalGeometry);
 assert.equal(mesh.material,originalMaterials);
});

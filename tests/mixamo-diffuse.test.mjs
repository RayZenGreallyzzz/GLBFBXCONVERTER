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
 assert.equal(mesh.material.normalMap,undefined);
 assert.equal(mesh.material.metalnessMap,undefined);
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

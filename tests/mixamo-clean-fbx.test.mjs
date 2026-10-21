import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {FBXExporter} from '@comfyorg/fbx-exporter-three';
import {inspectFbx} from '../src/format.js';
import {createMixamoAutorigInput,exportMixamoDiffuse} from '../src/mixamo-diffuse.js';

function character(){
 const root=new THREE.Group();root.name='Null';
 const wrapper=new THREE.Group();wrapper.name='Null';
 wrapper.position.set(2,0,4);
 root.add(wrapper);
 const png=new Uint8Array([20,70,170,255, 90,140,80,255,
   65,55,35,255, 140,120,90,255]);
 const image=new THREE.DataTexture(png,2,2,THREE.RGBAFormat);
 image.colorSpace=THREE.SRGBColorSpace;image.needsUpdate=true;
 image.name='Character_Albedo';
 const material=new THREE.MeshStandardMaterial({map:image,normalMap:null,color:0xffffff});
 const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,2,1),material);
 mesh.name='Character_Goblin';mesh.position.set(.5,1.1,0);
 wrapper.add(mesh);
 return {root,wrapper,mesh,material};
}
test('autorig flatten removes nested Null objects and preserves world transforms',()=>{
 const {root,mesh}=character();
 root.updateMatrixWorld(true);
 const world=mesh.getWorldPosition(new THREE.Vector3()).clone();
 const originalParent=mesh.parent,originalGeometry=mesh.geometry;
 const plan=createMixamoAutorigInput(root,[]);
 assert.equal(plan.flat,true);
 assert.equal(plan.meshes,1);
 assert.equal(plan.input.children.length,0,'mesh passed without fake hierarchy');
 assert.equal(plan.input.isMesh,true);
 assert.equal(plan.input.getWorldPosition(new THREE.Vector3()).distanceTo(world)<1e-6,true);
 assert.equal(mesh.parent,originalParent,'source hierarchy must not be edited');
 assert.equal(mesh.geometry,originalGeometry);
});
test('real FBX 2013 has no Null-model hierarchy and one embedded diffuse PNG',async()=>{
 const {root,wrapper,mesh,material}=character();
 const sourceUV=mesh.geometry.getAttribute('uv').array.slice();
 const output=await exportMixamoDiffuse(root,[],7300,FBXExporter,{maxTextureSize:2048});
 assert.equal(inspectFbx(output.bytes).version,7300);
 assert.equal(output.flatMeshHierarchy,true);
 assert.equal(output.manifest.embeddedPNG,1);
 assert.equal(output.manifest.diffuseConnections,1);
 const raw=Buffer.from(output.bytes).toString('latin1');
 assert.equal(raw.includes('Null\x00\x01Model'),false,
   'FBX should not contain empty Null model nodes');
 assert.ok(raw.includes('Character_Goblin\x00\x01Model'),
   'FBX should contain mesh model');
 assert.equal(mesh.parent,wrapper,'original tree stays unchanged');
 assert.equal(mesh.material,material,'material restored');
 assert.deepEqual(Array.from(mesh.geometry.getAttribute('uv').array),Array.from(sourceUV));
});
test('existing skinned meshes are not flattened',()=>{
 const root=new THREE.Group();
 const bones=new THREE.Bone();root.add(bones);
 const mesh=new THREE.SkinnedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
 root.add(mesh);
 const plan=createMixamoAutorigInput(root,[]);
 assert.equal(plan.flat,false);
 assert.equal(plan.input,root);
});

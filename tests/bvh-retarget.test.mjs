import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
// Three r170 expects browser FileReader. Only the Node regression test needs a
// polyfill; production Android WebView already supplies this API.
if(typeof globalThis.FileReader==='undefined'){
  globalThis.FileReader=class {
    readAsArrayBuffer(blob){
      blob.arrayBuffer().then(ab=>{
        this.result=ab;
        this.onloadend?.({target:this});
      });
    }
    readAsDataURL(blob){
      blob.arrayBuffer().then(ab=>{
        this.result='data:application/octet-stream;base64,'+
          Buffer.from(ab).toString('base64');
        this.onloadend?.({target:this});
      });
    }
  };
}
import { inspectGlb } from '../src/format.js';
import {
  canonicalBone,characterBones,isRiggedCharacter,
  parseBvhForRetarget,suggestBoneMappings,retargetBvhClip
} from '../src/animation-retarget.js';

const bvh=[
'HIERARCHY','ROOT Hips','{',
'  OFFSET 0 0 0',
'  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation',
'  JOINT Chest','  {',
'    OFFSET 0 1 0',
'    CHANNELS 3 Zrotation Xrotation Yrotation',
'    End Site','    {','      OFFSET 0 1 0','    }',
'  }','}',
'MOTION','Frames: 3','Frame Time: 0.0333333',
'0 0 0 0 0 0 0 0 0','0 0.2 0 20 0 0 5 0 0','0 0.4 0 40 0 0 10 0 0'
].join('\n')+'\n';
function character(){
 const root=new THREE.Group();
 const hips=new THREE.Bone();hips.name='mixamorigHips';
 const spine=new THREE.Bone();spine.name='mixamorigChest';spine.position.y=1;
 hips.add(spine);
 const mesh=new THREE.SkinnedMesh(
   new THREE.BoxGeometry(.5,1,.3),
   new THREE.MeshStandardMaterial({color:0x887744})
 );
 mesh.name='OrcBody';
 root.add(hips);root.add(mesh);
 hips.updateMatrixWorld(true);
 mesh.bind(new THREE.Skeleton([hips,spine]));
 return {root,hips,spine,mesh};
}
test('name mapping recognizes common Mixamo bone prefixes and aliases',()=>{
 assert.equal(canonicalBone('mixamorig:Hips'),canonicalBone('pelvis'));
 assert.equal(canonicalBone('mixamorigLeftUpperArm'),canonicalBone('LeftArm'));
 assert.equal(canonicalBone('mixamorigChest'),canonicalBone('Spine2'));
});
test('BVH to rigged humanoid: map bones and build a valid position-preserving clip',()=>{
 const model=character(),source=parseBvhForRetarget(bvh,'Orc_Run');
 assert.equal(isRiggedCharacter(model.root),true);
 const mapping=suggestBoneMappings(source.skeleton,model.root);
 assert.equal(mapping.matched,2);
 assert.equal(mapping.total,2);
 const beforeQuat=model.hips.quaternion.clone();
 const beforePos=model.hips.position.clone();
 const clip=retargetBvhClip({
   targetRoot:model.root,sourceSkeleton:source.skeleton,sourceClip:source.clip,
   mappings:mapping.mappings,name:'Run',rootMotion:false
 });
 assert.equal(clip.name,'Run');
 assert.equal(clip.tracks.length,2);
 assert.ok(clip.tracks.every(t=>t.name.endsWith('.quaternion')));
 assert.ok(clip.tracks.every(t=>t.times.length===3));
 assert.ok(model.hips.quaternion.equals(beforeQuat));
 assert.ok(model.hips.position.equals(beforePos));
});
test('root motion is optional and can be scaled without modifying source BVH',()=>{
 const model=character(),source=parseBvhForRetarget(bvh,'Orc_Walk');
 const mapping=suggestBoneMappings(source.skeleton,model.root);
 const clip=retargetBvhClip({
  targetRoot:model.root,sourceSkeleton:source.skeleton,sourceClip:source.clip,
  mappings:mapping.mappings,name:'Run',rootMotion:true,scale:.5
 });
 const move=clip.tracks.find(t=>t.name==='mixamorigHips.position');
 assert.ok(move);
 assert.ok(move.values[4]>0,'second hip frame must contain Y movement');
 assert.ok(move.values[4]<.2,'movement should be scaled');
});
test('GLB export binds BVH retargeted tracks to existing bones with skin intact',async()=>{
 const model=character(),source=parseBvhForRetarget(bvh,'Attack');
 const mapping=suggestBoneMappings(source.skeleton,model.root);
 const clip=retargetBvhClip({
   targetRoot:model.root,sourceSkeleton:source.skeleton,sourceClip:source.clip,
   mappings:mapping.mappings,name:'Attack',rootMotion:true
 });
 const saved=await new GLTFExporter().parseAsync(model.root,{
    binary:true,trs:true,animations:[clip],onlyVisible:false
 });
 const meta=inspectGlb(saved);
 assert.equal(meta.skins,1);
 assert.equal(meta.animations,1);
 assert.equal(meta.json.animations[0].name,'Attack');
 assert.equal(meta.json.animations[0].channels.length,3);
 assert.equal(meta.json.skins[0].joints.length,2);
 const boneNames=new Set(meta.json.nodes.map(n=>n.name));
 assert.ok(boneNames.has('mixamorigHips'));
 assert.ok(boneNames.has('mixamorigChest'));
});
test('reject BVH that cannot be matched and duplicate manual bone targets',()=>{
 const model=character(),source=parseBvhForRetarget(bvh);
 assert.throws(()=>retargetBvhClip({
  targetRoot:model.root,sourceSkeleton:source.skeleton,sourceClip:source.clip,
  mappings:[{source:'Hips',target:'MissingBone'}]
 }),/Некорректное соответствие/);
 assert.throws(()=>retargetBvhClip({
  targetRoot:model.root,sourceSkeleton:source.skeleton,sourceClip:source.clip,
  mappings:[{source:'Hips',target:'mixamorigHips'},{source:'Chest',target:'mixamorigHips'}]
 }),/Некорректное соответствие/);
 assert.ok(characterBones(model.root).length===2);
 assert.throws(()=>parseBvhForRetarget('bad content'),/Повреждённый BVH/);
});

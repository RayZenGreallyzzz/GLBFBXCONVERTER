import test from 'node:test';import assert from 'node:assert/strict';import * as THREE from 'three';
import {canonicalBone,suggestBoneMappings,findCanonicalBone} from '../src/animation-retarget.js';
import {autoAdaptBvhClip} from '../src/bvh-auto-adapt.js';
function rig(names){const root=new THREE.Group(),bones=names.map(name=>{const b=new THREE.Bone();b.name=name;root.add(b);return b});const mesh=new THREE.SkinnedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());root.add(mesh);root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones));return {root,bones}}
test('KayKit, Unreal and Mesh2Motion suffixes map body joints and separate all three spine levels',()=>{
 const aliases={'upperarm.l':'LeftArm','lowerarm.r':'RightForeArm','upperleg.l':'LeftUpLeg','lowerleg.r':'RightLeg','toes.l':'LeftToeBase','clavicle_r':'RightShoulder','thigh_l':'LeftUpLeg','calf_r':'RightLeg','ball_l':'LeftToeBase','neck_01':'Neck','spine_01':'Spine','spine_02':'Spine1','spine_03':'Spine2','index_01_l':'LeftHandIndex1','thumb_03_r':'RightHandThumb3'};
 for(const [source,target]of Object.entries(aliases))assert.equal(canonicalBone(source),canonicalBone('mixamorig'+target),source);
 const source=rig(['spine_01','spine_02','spine_03']),target=rig(['mixamorigSpine','mixamorigSpine1','mixamorigSpine2']);assert.deepEqual(suggestBoneMappings({bones:source.bones},target.root).mappings.map(m=>m.target),['mixamorigSpine','mixamorigSpine1','mixamorigSpine2']);
});
test('root and wrist helpers do not take the pelvis and hand aliases from the actual joints',()=>{
 const source=rig(['root','pelvis','wrist.l','hand.l','wrist.r','hand.r']),target=rig(['mixamorigHips','mixamorigLeftHand','mixamorigRightHand']),map=suggestBoneMappings({bones:source.bones},target.root).mappings;
 assert.equal(map.find(m=>m.source==='root').target,'');assert.equal(map.find(m=>m.source==='pelvis').target,'mixamorigHips');assert.equal(map.find(m=>m.source==='wrist.l').target,'');assert.equal(map.find(m=>m.source==='hand.l').target,'mixamorigLeftHand');assert.equal(findCanonicalBone(source.bones,'hips').name,'pelvis');
 assert.equal(suggestBoneMappings({bones:[source.bones[0]]},target.root).mappings[0].target,'mixamorigHips','a root-only skeleton keeps its fallback');
});
test('pelvis root motion includes the helper root and pelvis movement exactly once',()=>{
 const source=rig(['root','pelvis']);source.bones[0].add(source.bones[1]);source.bones[1].position.y=1;
 const target=rig(['root','mixamorigHips']);target.bones[0].add(target.bones[1]);target.bones[1].position.y=1;
 const clip=new THREE.AnimationClip('Move',1,[new THREE.QuaternionKeyframeTrack('pelvis.quaternion',[0,1],[0,0,0,1,0,0,0,1]),new THREE.VectorKeyframeTrack('root.position',[0,1],[0,0,0,1,0,0]),new THREE.VectorKeyframeTrack('pelvis.position',[0,1],[0,1,0,2,1,0])]),m=suggestBoneMappings({bones:source.bones},target.root),out=autoAdaptBvhClip({targetRoot:target.root,sourceSkeleton:{bones:source.bones},sourceClip:clip,mappings:m.mappings,referencePose:'rest',rootMotion:true,autoScale:false,alignAxes:false});
 const p=out.tracks.find(t=>t.name==='mixamorigHips.position');assert.ok(p);assert.ok(Math.abs(p.values.at(-3)-3)<1e-6);assert.ok(!out.tracks.some(t=>t.name==='root.position'));
});

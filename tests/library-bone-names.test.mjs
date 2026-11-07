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
function branchingRig({reversed=false,aPose=false,socket=false}={}){
 const root=new THREE.Group(),bones=[],make=(name,parent,position)=>{const b=new THREE.Bone();b.name=name;b.position.fromArray(position);(parent||root).add(b);bones.push(b);return b};
 const hips=make('Hips',null,[0,1,0]),spine=make('Spine',hips,[0,.3,0]),chest=make('Spine2',spine,[0,.3,0]),neck=make('Neck',chest,[0,.2,0]);make('Head',neck,[0,.2,0]);
 for(const [side,s]of [['Left',1],['Right',-1]]){const arm=make(side+'Arm',chest,[s*.3,0,0]);if(aPose)arm.rotation.z=-s*.4;const forearm=make(side+'ForeArm',arm,[s*.4,0,0]),hand=make(side+'Hand',forearm,[s*.3,0,0]);make(socket?'handslot.'+(s===1?'l':'r'):side+'HandEnd',hand,socket?[0,0,.2]:[s*.1,0,0]);const thigh=make(side+'UpLeg',hips,[s*.1,-.1,0]),leg=make(side+'Leg',thigh,[0,-.4,0]);make(side+'Foot',leg,[0,-.4,0])}
 if(reversed){hips.children.reverse();chest.children.reverse()}root.updateMatrixWorld(true);const mesh=new THREE.SkinnedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());root.add(mesh);mesh.bind(new THREE.Skeleton(bones));return {root,bones};
}
function branchMotion(){const q=(axis,angle)=>new THREE.Quaternion().setFromAxisAngle(axis,angle).toArray();return new THREE.AnimationClip('Body',1,[new THREE.QuaternionKeyframeTrack('Hips.quaternion',[0,1],[0,0,0,1,...q(new THREE.Vector3(0,1,0),.4)]),new THREE.QuaternionKeyframeTrack('Spine2.quaternion',[0,1],[0,0,0,1,...q(new THREE.Vector3(1,0,0),.3)]),new THREE.QuaternionKeyframeTrack('LeftForeArm.quaternion',[0,1],[0,0,0,1,...q(new THREE.Vector3(0,1,0),.5)])])}
test('body correction is independent of whether legs or arms are listed before torso children',()=>{
 const target=branchingRig({aPose:true}),out=[];for(const reversed of [false,true]){const source=branchingRig({reversed,socket:true}),mapping=suggestBoneMappings({bones:source.bones},target.root);out.push(autoAdaptBvhClip({targetRoot:target.root,sourceSkeleton:{bones:source.bones},sourceClip:branchMotion(),mappings:mapping.mappings,referencePose:'rest'}))}
 assert.deepEqual(out[0].tracks.map(t=>t.values),out[1].tracks.map(t=>t.values));
});
test('a hand inherits forearm alignment instead of using an arbitrary weapon socket',()=>{
 const source=branchingRig({socket:true}),target=branchingRig({aPose:true}),m=suggestBoneMappings({bones:source.bones},target.root),out=autoAdaptBvhClip({targetRoot:target.root,sourceSkeleton:{bones:source.bones},sourceClip:branchMotion(),mappings:m.mappings,referencePose:'rest'}),hand=out.tracks.find(t=>t.name==='LeftHand.quaternion');
 for(let i=0;i<hand.values.length;i+=4)assert.ok(new THREE.Quaternion().fromArray(hand.values,i).normalize().angleTo(new THREE.Quaternion())<1e-6,'static hand must not compensate for a mismatched socket direction');
});
test('unanimated arm joints retain their local pose when torso motion is adapted from T pose to A pose',()=>{
 const source=branchingRig({socket:true}),target=branchingRig({aPose:true}),motion=branchMotion();motion.tracks=motion.tracks.filter(t=>!t.name.includes('ForeArm'));const m=suggestBoneMappings({bones:source.bones},target.root),out=autoAdaptBvhClip({targetRoot:target.root,sourceSkeleton:{bones:source.bones},sourceClip:motion,mappings:m.mappings,referencePose:'rest'});
 for(const name of ['LeftArm','LeftForeArm','LeftHand','RightArm','RightForeArm','RightHand']){const rest=target.root.getObjectByName(name).quaternion.clone().normalize(),track=out.tracks.find(t=>t.name===name+'.quaternion');for(let i=0;i<track.values.length;i+=4)assert.ok(new THREE.Quaternion().fromArray(track.values,i).normalize().angleTo(rest)<1e-6,name+' must inherit torso motion without compensating local rotation')}
});

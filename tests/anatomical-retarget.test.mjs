import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {autoAdaptBvhClip} from '../src/bvh-auto-adapt.js';
import {suggestBoneMappings} from '../src/animation-retarget.js';
import {anatomicalFrames,constrainAnatomicalJoint} from '../src/anatomical-frames.js';

function rig({aPose=0,roll=0,scale=1}={}){
 const root=new THREE.Group(),bones=[],world=new Map();
 const make=(name,parent,p,direction=new THREE.Vector3(0,1,0))=>{
  const b=new THREE.Bone();b.name=name;
  const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction.clone().normalize());
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),roll));
  const pos=new THREE.Vector3(...p).multiplyScalar(scale),parentWorld=parent?world.get(parent):null;
  b.position.copy(pos);b.quaternion.copy(q);
  if(parentWorld){b.position.sub(parentWorld.p).applyQuaternion(parentWorld.q.clone().invert());b.quaternion.premultiply(parentWorld.q.clone().invert())}
  (parent||root).add(b);bones.push(b);world.set(b,{p:pos,q});return b;
 };
 const hips=make('Hips',null,[0,1,0]),chest=make('Spine2',hips,[0,1.6,0]),head=make('Head',chest,[0,1.9,0]);
 for(const [side,s] of [['Left',1],['Right',-1]]){
  const direction=new THREE.Vector3(s*Math.cos(aPose),-Math.sin(aPose),0);
  const shoulder=make(side+'Shoulder',chest,[s*.1,1.6,0],new THREE.Vector3(s,0,0));
  const arm=make(side+'Arm',shoulder,[s*.25,1.6,0],direction);
  const elbow=new THREE.Vector3(s*.25,1.6,0).addScaledVector(direction,.4);
  const forearm=make(side+'ForeArm',arm,elbow.toArray(),direction);
  const wrist=elbow.clone().addScaledVector(direction,.3);
  make(side+'Hand',forearm,wrist.toArray(),direction);
  const thigh=make(side+'UpLeg',hips,[s*.1,.9,0],new THREE.Vector3(0,-1,0));
  const calf=make(side+'Leg',thigh,[s*.1,.5,0],new THREE.Vector3(0,-1,0));
  make(side+'Foot',calf,[s*.1,.1,0],new THREE.Vector3(0,0,1));
 }
 const mesh=new THREE.SkinnedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
 root.add(mesh);root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones));
 const ref=new Map();ref.positions=new Map();for(const b of bones){ref.set(b,b.getWorldQuaternion(new THREE.Quaternion()));ref.positions.set(b,b.getWorldPosition(new THREE.Vector3()))}
 return {root,bones,ref,find:name=>root.getObjectByName(name)};
}
function makeClip(source,poses){
 const tracks=[];
 for(const [name,rotation] of Object.entries(poses)){
  const bone=source.find(name),end=bone.quaternion.clone().multiply(rotation);
  tracks.push(new THREE.QuaternionKeyframeTrack(name+'.quaternion',[0,1],[...bone.quaternion.toArray(),...end.toArray()]));
 }
 return new THREE.AnimationClip('Motion',1,tracks);
}
function transfer(source,target,clip,options={}){
 return autoAdaptBvhClip({targetRoot:target.root,sourceSkeleton:{bones:source.bones},sourceClip:clip,
  mappings:suggestBoneMappings({bones:source.bones},target.root).mappings,referencePose:'rest',matchLimbPose:true,...options});
}
function pose(target,clip,t){
 const old=target.bones.map(b=>b.quaternion.clone());
 for(const track of clip.tracks)if(track.name.endsWith('.quaternion'))target.find(track.name.slice(0,-11)).quaternion.fromArray(track.createInterpolant().evaluate(t));
 target.root.updateMatrixWorld(true);
 const p=new Map(target.bones.map(b=>[b.name,b.getWorldPosition(new THREE.Vector3())]));
 target.bones.forEach((b,i)=>b.quaternion.copy(old[i]));target.root.updateMatrixWorld(true);return p;
}
test('a donor lowering T-pose arms does not add the target A-pose drop twice',()=>{
 const source=rig(),target=rig({aPose:Math.PI/3,roll:1.1,scale:.6});
 const poses={};for(const side of ['Left','Right']){
  const upper=source.find(side+'Arm'),worldAxis=new THREE.Vector3(0,0,side==='Left'?-1:1);
  const localAxis=worldAxis.applyQuaternion(source.ref.get(upper).clone().invert());
  poses[side+'Arm']=new THREE.Quaternion().setFromAxisAngle(localAxis,Math.PI/2);
 }
 const clip=makeClip(source,poses),out=transfer(source,target,clip),positions=pose(target,out,1);
 for(const side of ['Left','Right']){
  const arm=positions.get(side+'ForeArm').clone().sub(positions.get(side+'Arm')).normalize();
  assert.ok(arm.distanceTo(new THREE.Vector3(0,-1,0))<1e-5,side+' arm must point down rather than cross the torso');
 }
 assert.ok(out.userData.anatomicalFrames>=10);
 assert.equal(out.userData.matchLimbPose,true);
});
test('elbows and knees flex in the same anatomical plane despite unrelated bone roll and limb lengths',()=>{
 const source=rig({roll:-.7}),target=rig({aPose:.6,roll:1.9,scale:.7});
 const frames=anatomicalFrames(source.bones,source.ref),poses={};
 for(const side of ['Left','Right'])for(const part of ['ForeArm','Leg']){
  const hinge=frames.get(source.find(side+part)).hinge;
  poses[side+part]=new THREE.Quaternion().setFromAxisAngle(hinge.axis,Math.PI/2);
 }
 const before=target.bones.map(b=>b.quaternion.toArray()),out=transfer(source,target,makeClip(source,poses)),p=pose(target,out,1);
 for(const side of ['Left','Right']){
  const arm=p.get(side+'Hand').clone().sub(p.get(side+'ForeArm')).normalize();
  const leg=p.get(side+'Foot').clone().sub(p.get(side+'Leg')).normalize();
  assert.ok(arm.distanceTo(new THREE.Vector3(0,0,1))<1e-5,'elbow flexes forward');
  assert.ok(leg.distanceTo(new THREE.Vector3(0,0,-1))<1e-5,'knee flexes backwards');
 }
 assert.deepEqual(target.bones.map(b=>b.quaternion.toArray()),before,'retargeting must not mutate the bind pose');
});
test('hinge constraints remove side swing and backwards flexion while preserving forearm twist',()=>{
 const source=rig(),frames=anatomicalFrames(source.bones,source.ref),bone=source.find('LeftForeArm'),hinge=frames.get(bone).hinge;
 const rotation=new THREE.Quaternion().setFromAxisAngle(hinge.axis,1.1),twist=new THREE.Quaternion().setFromAxisAngle(hinge.longitudinal,.8);
 const valid=hinge.rest.clone().multiply(rotation).multiply(twist);
 assert.ok(constrainAnatomicalJoint(valid,hinge).angleTo(valid)<1e-6);
 const backwards=hinge.rest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(hinge.axis,-.4));
 assert.ok(constrainAnatomicalJoint(backwards,hinge).angleTo(hinge.rest)<1e-6);
 const sideways=hinge.axis.clone().cross(hinge.longitudinal).normalize();
 const bad=hinge.rest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(sideways,.6));
 assert.ok(constrainAnatomicalJoint(bad,hinge).angleTo(hinge.rest)<1e-6);
});
test('intentional donor arm crossing survives pose matching; no automatic left/right spreading',()=>{
 const source=rig(),target=rig({aPose:.8,roll:1.7}),upper=source.find('LeftArm');
 const axis=new THREE.Vector3(0,0,-1).applyQuaternion(source.ref.get(upper).clone().invert());
 const out=transfer(source,target,makeClip(source,{LeftArm:new THREE.Quaternion().setFromAxisAngle(axis,2.2)}));
 const p=pose(target,out,1),arm=p.get('LeftForeArm').clone().sub(p.get('LeftArm')).normalize();
 assert.ok(arm.x<-.5,'an intentional inward donor shoulder pose must be preserved');
});

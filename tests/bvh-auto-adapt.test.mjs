import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { inspectGlb } from '../src/format.js';
import {parseBvhForRetarget,suggestBoneMappings} from '../src/animation-retarget.js';
import {autoAdaptBvhClip,estimateRigScale,detectCmuCalibration} from '../src/bvh-auto-adapt.js';

if(typeof globalThis.FileReader==='undefined'){
 globalThis.FileReader=class {
   readAsArrayBuffer(blob){blob.arrayBuffer().then(x=>{this.result=x;this.onloadend?.({target:this})})}
   readAsDataURL(blob){blob.arrayBuffer().then(x=>{this.result='data:application/octet-stream;base64,'+Buffer.from(x).toString('base64');this.onloadend?.({target:this})})}
 };
}
const n=(name,offset,children=[])=>({name,offset,children});
const sourceTree=n('Hips',[0,0,0],[
 n('LHipJoint',[0,0,0],[n('LeftUpLeg',[0,-2,0],[n('LeftLeg',[0,-15,0],[n('LeftFoot',[0,-15,0])])])]),
 n('RHipJoint',[0,0,0],[n('RightUpLeg',[0,-2,0],[n('RightLeg',[0,-15,0],[n('RightFoot',[0,-15,0])])])]),
 n('LowerBack',[0,0,0]),
 n('Spine',[0,10,0],[n('LeftArm',[4,4,0],[n('LeftForeArm',[8,0,0])])])
]);
function makeCmu(){
 const order=[];
 function emit(b,depth=0){
   order.push(b.name);
   const prefix=' '.repeat(depth*2);
   const base=[prefix+(depth?'JOINT ':'ROOT ')+b.name,prefix+'{',
     prefix+'  OFFSET '+b.offset.join(' '),
     prefix+'  CHANNELS '+(depth?'3 Zrotation Yrotation Xrotation':'6 Xposition Yposition Zposition Zrotation Yrotation Xrotation')];
   for(const child of b.children)base.push(...emit(child,depth+1));
   if(!b.children.length)base.push(prefix+'  End Site',prefix+'  {',prefix+'    OFFSET 0 1 0',prefix+'  }');
   return [...base,prefix+'}'];
 }
 const hierarchy=emit(sourceTree);
 function frame(idx){
   const channels=[];
   for(const name of order){
     if(name==='Hips')channels.push(idx===0?9:idx===1?100:110,17,0);
     channels.push(name==='LeftArm'&&idx===2?45:0,0,0);
   }
   return channels.join(' ');
 }
 return ['HIERARCHY',...hierarchy,'MOTION','Frames: 3','Frame Time: .0083333',frame(0),frame(1),frame(2)].join('\n')+'\n';
}
function targetRig(){
 const root=new THREE.Group(),hips=new THREE.Bone();hips.name='mixamorigHips';
 const spine=new THREE.Bone();spine.name='mixamorigSpine';spine.position.y=.2;hips.add(spine);
 const arm=new THREE.Bone();arm.name='mixamorigLeftUpperArm';arm.position.set(.1,.1,0);
 arm.rotation.z=-.45;spine.add(arm);
 const forearm=new THREE.Bone();forearm.name='mixamorigLeftForeArm';
 forearm.position.x=.1;arm.add(forearm);
 const thigh=new THREE.Bone();thigh.name='mixamorigLeftUpLeg';thigh.position.y=-.02;hips.add(thigh);
 const calf=new THREE.Bone();calf.name='mixamorigLeftLeg';calf.position.y=-.2;thigh.add(calf);
 const foot=new THREE.Bone();foot.name='mixamorigLeftFoot';foot.position.y=-.2;calf.add(foot);
 const mesh=new THREE.SkinnedMesh(new THREE.BoxGeometry(.2,.4,.2),new THREE.MeshStandardMaterial());
 root.add(mesh,hips);root.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([hips,spine,arm,forearm,thigh,calf,foot]));
 return {root,hips,spine,arm,calf};
}
const near=(a,b,epsilon=.0001)=>assert.ok(Math.abs(a-b)<epsilon,'Expected '+a+' near '+b);
test('CMU detector recognizes 120 FPS synthetic calibration and rejects generic sample rates',()=>{
 const source=parseBvhForRetarget(makeCmu());
 assert.equal(detectCmuCalibration(source.skeleton,source.clip),true);
 const generic=parseBvhForRetarget(makeCmu().replace('.0083333','.0333333'));
 assert.equal(detectCmuCalibration(generic.skeleton,generic.clip),false);
});
test('exact match reserves Spine before a CMU LowerBack alias',()=>{
 const source=parseBvhForRetarget(makeCmu()),rig=targetRig();
 const mapping=suggestBoneMappings(source.skeleton,rig.root);
 assert.equal(mapping.mappings.find(x=>x.source==='Spine').target,'mixamorigSpine');
 assert.equal(mapping.mappings.find(x=>x.source==='LowerBack').target,'');
});
test('CMU frame zero calibrates A-pose, is removed, and creates no first-frame root jump',()=>{
 const source=parseBvhForRetarget(makeCmu()),rig=targetRig();
 const mapping=suggestBoneMappings(source.skeleton,rig.root);
 const old=rig.arm.quaternion.clone(),oldPos=rig.hips.position.clone();
 const clip=autoAdaptBvhClip({targetRoot:rig.root,
   sourceSkeleton:source.skeleton,sourceClip:source.clip,mappings:mapping.mappings,
   rootMotion:true,autoScale:true,trimCalibration:true,name:'Climb'});
 assert.equal(clip.name,'Climb');
 assert.equal(clip.userData.calibrationFrameRemoved,true);
 assert.equal(clip.tracks[0].times.length,2);
 near(clip.tracks[0].times[0],0);
 const arm=clip.tracks.find(t=>t.name==='mixamorigLeftUpperArm.quaternion');
 assert.ok(arm,'A-pose arm must be mapped');
 const beginning=new THREE.Quaternion().fromArray(arm.values,0);
 assert.ok(beginning.angleTo(old)<.0002,'source pose must preserve A-pose, delta='+beginning.angleTo(old).toFixed(6)+' start='+beginning.toArray()+' rest='+old.toArray()+' map='+JSON.stringify(mapping.mappings.filter(x=>x.target)) );
 const rotated=new THREE.Quaternion().fromArray(arm.values,4);
 assert.ok(rotated.angleTo(old)>.1,'last frame must animate arm');
 const hipMove=clip.tracks.find(t=>t.name==='mixamorigHips.position');
 assert.ok(hipMove);
 near(hipMove.values[0],0);
 near(hipMove.values[3],10*(.4/30),.005);
 assert.ok(rig.arm.quaternion.equals(old),'target rig must not mutate');
 assert.ok(rig.hips.position.equals(oldPos),'target hip must not move before preview');
});
test('manual scale and calibration switch avoid deleting generic BVH start pose',()=>{
 const source=parseBvhForRetarget(makeCmu()),rig=targetRig();
 const map=suggestBoneMappings(source.skeleton,rig.root).mappings;
 const old=autoAdaptBvhClip({targetRoot:rig.root,sourceSkeleton:source.skeleton,
   sourceClip:source.clip,mappings:map,rootMotion:true,autoScale:false,trimCalibration:false,scale:.5});
 const move=old.tracks.find(x=>x.name==='mixamorigHips.position');
 assert.equal(move.times.length,3);
 near(move.values[0],0);
 near(move.values[3],(100-9)*.5,.01);
 near(estimateRigScale(source.skeleton,rig.root).ratio,.4/30,.00001);
});
test('export of automatically adapted clip keeps animation and GLB skeleton',async()=>{
 const source=parseBvhForRetarget(makeCmu()),rig=targetRig();
 const map=suggestBoneMappings(source.skeleton,rig.root).mappings;
 const clip=autoAdaptBvhClip({targetRoot:rig.root,sourceSkeleton:source.skeleton,
   sourceClip:source.clip,mappings:map,rootMotion:true,name:'Orc_Climb'});
 const bytes=await new GLTFExporter().parseAsync(rig.root,{
   binary:true,trs:true,onlyVisible:false,animations:[clip]
 });
 const result=inspectGlb(bytes);
 assert.equal(result.skins,1);
 assert.equal(result.animations,1);
 assert.ok(result.json.animations[0].channels.length>=4);
});

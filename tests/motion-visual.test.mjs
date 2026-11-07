import test from 'node:test';import assert from 'node:assert/strict';import * as THREE from 'three';
import {createMotionVisual} from '../src/motion-visual.js';
function source({travel=false,zUp=false,duration=1}={}){
 const root=new THREE.Group(),bones=[],add=(name,parent,p)=>{const b=new THREE.Bone();b.name=name;b.position.fromArray(p);(parent||root).add(b);bones.push(b);return b};
 const hips=add('Hips',null,[0,1,0]),spine=add('Spine',hips,[0,.3,0]),chest=add('Spine2',spine,[0,.3,0]),neck=add('Neck',chest,[0,.2,0]);add('Head',neck,[0,.2,0]);
 for(const [side,s]of [['Left',1],['Right',-1]]){const arm=add(side+'Arm',chest,[s*.25,0,0]),forearm=add(side+'ForeArm',arm,[s*.3,0,0]);add(side+'Hand',forearm,[s*.25,0,0]);const thigh=add(side+'UpLeg',hips,[s*.12,-.1,0]),leg=add(side+'Leg',thigh,[0,-.4,0]),foot=add(side+'Foot',leg,[0,-.4,0]);add(side+'ToeBase',foot,[0,-.05,.12])}
 if(zUp)root.rotation.x=-Math.PI/2;root.updateMatrixWorld(true);
 const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),.8).toArray(),tracks=[new THREE.QuaternionKeyframeTrack('LeftArm.quaternion',[0,duration],[0,0,0,1,...q])];if(travel)tracks.push(new THREE.VectorKeyframeTrack('Hips.position',[0,duration],[0,1,0,100,1.6,-120]));const clip=new THREE.AnimationClip('Wave',duration,tracks);return {root,skeleton:new THREE.Skeleton(bones),clip,clips:[clip],kind:'glb'};
}
test('visual sampling animates a humanoid while leaving source bones, clip keys and file state unchanged',()=>{
 const s=source(),poses=s.skeleton.bones.map(b=>({p:b.position.toArray(),q:b.quaternion.toArray(),m:b.matrixWorld.toArray()})),keys=s.clip.tracks.map(t=>t.values.slice()),visual=createMotionVisual(s);
 assert.equal(visual.humanoid,true);assert.equal(visual.name,'Wave');assert.ok(visual.edges.length>12);assert.ok(visual.values.every(Number.isFinite));assert.notDeepEqual(visual.values.slice(0,visual.points*3),visual.values.slice(-visual.points*3));
 assert.deepEqual(s.skeleton.bones.map(b=>({p:b.position.toArray(),q:b.quaternion.toArray(),m:b.matrixWorld.toArray()})),poses);assert.deepEqual(s.clip.tracks.map(t=>t.values),keys);assert.ok(!('root' in visual));
});
test('thumbnail removes horizontal root travel, keeps a jump visible and fits a consistent source axis frame',()=>{
 const a=createMotionVisual(source({travel:true})),b=createMotionVisual(source({travel:true,zUp:true})),i=a.pointNames.indexOf('hips'),first=i*3,last=((a.frames-1)*a.points+i)*3;
 assert.ok(Math.abs(a.values[last])<1e-6&&Math.abs(a.values[last+2])<1e-6);assert.ok(a.values[last+1]>a.values[first+1]+.1);assert.ok(a.bounds.maxX-a.bounds.minX<3);
 assert.equal(a.values.length,b.values.length);let error=0;for(let k=0;k<a.values.length;k++)error=Math.max(error,Math.abs(a.values[k]-b.values[k]));assert.ok(error<1e-5,'axis-normalized previews differ: '+error);
});
test('long clips produce a bounded eight-second fragment and BVH skeletons need no source mesh',()=>{
 const s=source({duration:40}),visual=createMotionVisual(s);assert.equal(visual.duration,8);assert.equal(visual.fullDuration,40);assert.ok(visual.frames<=97);assert.ok(visual.values.byteLength<=97*72*3*4);
 const bvh=source();delete bvh.root;bvh.kind='bvh';assert.ok(createMotionVisual(bvh).frames>1);
});

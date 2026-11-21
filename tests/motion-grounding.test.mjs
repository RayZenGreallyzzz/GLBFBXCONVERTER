import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {bakeGroundContact} from '../src/motion-grounding.js';
import {autoAdaptBvhClip} from '../src/bvh-auto-adapt.js';
import {suggestBoneMappings} from '../src/animation-retarget.js';

function body(){
  const root=new THREE.Group(),bones=[];
  const joint=(name,parent,x,y,z)=>{
    const b=new THREE.Bone();b.name=name;b.position.set(x,y,z);parent.add(b);bones.push(b);return b;
  };
  const hips=joint('Hips',root,0,1.1,0),chest=joint('Spine2',hips,0,.65,0);
  joint('Neck',chest,0,.25,0);
  const patches=[[hips,[0,1.09,-.08]],[chest,[0,1.72,-.10]]];
  for(const [side,sign]of [['Left',1],['Right',-1]]){
    const thigh=joint(side+'UpLeg',hips,.2*sign,0,0);
    const knee=joint(side+'Leg',thigh,0,-.48,.10);
    const foot=joint(side+'Foot',knee,0,-.49,-.10);
    joint(side+'ToeBase',foot,0,-.03,.12);
    patches.push([foot,[.2*sign,.03,.13]]);
  }
  const xyz=[],index=[],weights=[];
  for(const [bone,p]of patches){
    xyz.push(...p,p[0]+.08,p[1],p[2],p[0],p[1],p[2]+.08);
    for(let i=0;i<3;i++){index.push(bones.indexOf(bone),0,0,0);weights.push(1,0,0,0)}
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(xyz,3));
  g.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(index,4));
  g.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const mesh=new THREE.SkinnedMesh(g);root.add(mesh);root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  return {root,bones,hips,mesh};
}
const times=new Float32Array([0,.25,.5,.75,1]);
const q=(axis,r)=>new THREE.Quaternion().setFromAxisAngle(axis,r).toArray();
const yMin=(mesh,start=0,end=mesh.geometry.attributes.position.count)=>{
  let y=Infinity;const v=new THREE.Vector3();
  for(let n=start;n<end;n++)y=Math.min(y,mesh.getVertexPosition(n,v).applyMatrix4(mesh.matrixWorld).y);
  return y;
};
const playback=(rig,clip,t)=>{
  const mix=new THREE.AnimationMixer(rig.root),action=mix.clipAction(clip);
  action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();
  mix.setTime(t);rig.root.updateMatrixWorld(true);return mix;
};

test('grounded retarget writes a vertical track independently of planar root motion and uses body support after falling',()=>{
  const rig=body(),source=body();
  const turn=new THREE.Vector3(1,0,0);
  const sourceClip=new THREE.AnimationClip('fall',1,[
    new THREE.QuaternionKeyframeTrack('Hips.quaternion',[0,1],[...q(turn,0),...q(turn,-Math.PI/2)]),
    new THREE.VectorKeyframeTrack('Hips.position',[0,1],[0,1.1,0,.6,.9,-.2])
  ]);
  const skeleton={bones:source.bones},mappings=suggestBoneMappings(skeleton,rig.root).mappings;
  const options={targetRoot:rig.root,sourceSkeleton:skeleton,sourceClip,mappings,referencePose:'rest'};
  const base=autoAdaptBvhClip(options),grounded=autoAdaptBvhClip({...options,groundMotion:true});
  const walking=autoAdaptBvhClip({...options,groundMotion:true,rootMotion:true,autoScale:false});
  assert.ok(!base.tracks.some(t=>t.name==='Hips.position'));
  assert.equal(grounded.userData.grounded,true);
  assert.equal(walking.userData.grounded,true);
  assert.equal(rig.hips.position.y,1.1);
  for(const [clip,x,z]of [[grounded,0,0],[walking,.6,-.2]]){
    const m=playback(rig,clip,1);
    assert.ok(Math.abs(rig.hips.getWorldPosition(new THREE.Vector3()).x-x)<1e-5);
    assert.ok(Math.abs(rig.hips.getWorldPosition(new THREE.Vector3()).z-z)<1e-5);
    assert.ok(Math.abs(yMin(rig.mesh))<1e-5);
    assert.ok(yMin(rig.mesh,0,6)<1e-5,'fallen torso is the support');
    m.stopAllAction();
  }
});

test('two-foot correction keeps an authored lifted foot when the source does not request both contacts',()=>{
  const rig=body(),axis=new THREE.Vector3(0,0,1),tracks=[];
  for(const side of ['Left','Right'])for(const stem of ['UpLeg','Leg','Foot']){
    const values=[];
    for(const _ of times)values.push(...q(axis,side==='Left'&&stem==='UpLeg'?.95:0));
    tracks.push(new THREE.QuaternionKeyframeTrack(side+stem+'.quaternion',times.slice(),values));
  }
  const sample=(contact,name)=>{
    const clip=new THREE.AnimationClip(name,1,tracks);
    const result=bakeGroundContact(rig.root,'Hips',clip,times,Float32Array.from(times,()=>contact),()=>{});
    assert.equal(result.grounded,true);
    assert.equal(result.stance,contact===1);
    const mix=playback(rig,clip,.5);
    const gap=Math.abs(yMin(rig.mesh,6,9)-yMin(rig.mesh,9,12));
    mix.stopAllAction();rig.root.updateMatrixWorld(true);
    return gap;
  };
  assert.ok(sample(0,'raised')>.25);
  const gap=sample(1,'grounded');assert.ok(gap<.02,'gap '+gap);
});

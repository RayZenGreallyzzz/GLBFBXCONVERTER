import {WebIO,Accessor} from '@gltf-transform/core';
import {Quaternion,Vector3,Matrix4} from 'three';
import {rigFixture} from './rig-fixture.mjs';
import {buildGuidedRig} from '../../src/guided-rig.js';
export async function armRepairFixture(){
 const f=await rigFixture(),built=await buildGuidedRig(f.bytes,{guides:f.guides,resolution:32}),io=new WebIO(),doc=await io.readBinary(built.bytes),root=doc.getRoot(),skin=root.listSkins()[0],joints=skin.listJoints(),names=new Map(joints.map((b,i)=>[b.getName(),i]));
 const extras=structuredClone(root.getExtras());delete extras.phoenixRig.armLocalWeights;extras.phoenixRig.version=2;root.setExtras(extras);
 for(const mesh of root.listMeshes())for(const p of mesh.listPrimitives()){
  const positions=p.getAttribute('POSITION').getArray(),indices=p.getAttribute('JOINTS_0').getArray(),weights=p.getAttribute('WEIGHTS_0').getArray();
  for(const side of ['Left','Right']){
   const ids=['Shoulder','Arm','ForeArm','Hand'].map(part=>names.get('mixamorig'+side+part)),wrist=new Vector3().setFromMatrixPosition(new Matrix4().fromArray(joints[ids[3]].getWorldMatrix())),sign=side==='Left'?1:-1;
   for(let n=0;n<positions.length/3;n++){let sum=0;for(let k=0;k<4;k++)if(ids.includes(indices[n*4+k]))sum+=weights[n*4+k];if(sum>.95&&sign*(positions[n*3]-wrist.x)>-.25){for(let k=0;k<4;k++)indices[n*4+k]=ids[k];weights.set([.05,.15,.35,.45],n*4)}}
  }
 }
 const buffer=root.listBuffers()[0],times=doc.createAccessor().setBuffer(buffer).setType(Accessor.Type.SCALAR).setArray(new Float32Array([0,1,2])),animation=doc.createAnimation('Punch');
 for(const [name,angle]of [['mixamorigLeftForeArm',1.9],['mixamorigRightHand',1.8]]){
  const bone=joints[names.get(name)],rest=new Quaternion().fromArray(bone.getRotation()),axis=new Vector3(0,0,1),values=[];for(const a of [0,angle,0])rest.clone().multiply(new Quaternion().setFromAxisAngle(axis,a)).toArray(values,values.length);
  const output=doc.createAccessor().setBuffer(buffer).setType(Accessor.Type.VEC4).setArray(new Float32Array(values)),sampler=doc.createAnimationSampler().setInput(times).setOutput(output);animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(bone).setTargetPath('rotation').setSampler(sampler));
 }
 return {bytes:await io.writeBinary(doc)};
}

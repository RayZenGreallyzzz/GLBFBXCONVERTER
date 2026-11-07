import * as THREE from 'three';
import {Document,Accessor,WebIO} from '@gltf-transform/core';
export const motionBvh=['HIERARCHY','ROOT Hips','{','OFFSET 0 0 0','CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation','JOINT Arm','{','OFFSET 0 1 0','CHANNELS 3 Zrotation Xrotation Yrotation','End Site','{','OFFSET 0 1 0','}','}','}','MOTION','Frames: 3','Frame Time: .0333333','0 0 0 0 0 0 0 0 0','0 0 0 0 0 0 15 0 0','0 0 0 0 0 0 30 0 0'].join('\n')+'\n';
export function namedBlob(name,bytes){const file=new Blob([bytes]);Object.defineProperty(file,'name',{value:name});return file}
export async function motionFixture(){
 const doc=new Document(),buffer=doc.createBuffer('Data'),acc=(array,type)=>doc.createAccessor().setBuffer(buffer).setType(type).setArray(array);
 const q=a=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),a).toArray();
 const hips=doc.createNode('Hips'),arm=doc.createNode('Arm').setTranslation([0,1,0]).setRotation(q(.2));hips.addChild(arm);const group=doc.createNode('Armature').addChild(hips);doc.createScene().addChild(group);
 const skin=doc.createSkin().addJoint(hips).addJoint(arm),prim=doc.createPrimitive().setAttribute('POSITION',acc(new Float32Array([0,0,0,1,0,0,0,1,0]),Accessor.Type.VEC3)).setAttribute('JOINTS_0',acc(new Uint16Array(12),Accessor.Type.VEC4)).setAttribute('WEIGHTS_0',acc(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0]),Accessor.Type.VEC4));doc.getRoot().listScenes()[0].addChild(doc.createNode('Body').setMesh(doc.createMesh().addPrimitive(prim)).setSkin(skin));
 for(const [name,a]of [['Idle',.7],['Walk',1]]){const sampler=doc.createAnimationSampler().setInput(acc(new Float32Array([0,.37,1]),Accessor.Type.SCALAR)).setOutput(acc(new Float32Array([...q(a),...q(a+.2),...q(a+.4)]),Accessor.Type.VEC4)),channel=doc.createAnimationChannel().setSampler(sampler).setTargetNode(arm).setTargetPath('rotation');doc.createAnimation(name).addSampler(sampler).addChannel(channel)}
 return {doc,bytes:await new WebIO().writeBinary(doc)};
}

import * as THREE from 'three';
import {Document,WebIO} from '@gltf-transform/core';
export async function morphFixture({rigged=true,tangents=false,sparse=false,texture=null,segments=36,instance=false}={}){
 const doc=new Document(),buffer=doc.createBuffer(),g=new THREE.PlaneGeometry(2,2,segments,segments),count=g.attributes.position.count,acc=(v,t)=>doc.createAccessor().setBuffer(buffer).setType(t).setArray(v);
 for(let i=0;i<count;i++){g.attributes.position.setY(i,g.attributes.position.getY(i)+1);g.attributes.position.setZ(i,.03*Math.cos(g.attributes.position.getX(i)*2))}g.computeVertexNormals();g.computeTangents();
 const prim=doc.createPrimitive().setAttribute('POSITION',acc(g.attributes.position.array,'VEC3')).setAttribute('NORMAL',acc(g.attributes.normal.array,'VEC3')).setAttribute('TANGENT',acc(g.attributes.tangent.array,'VEC4')).setAttribute('TEXCOORD_0',acc(g.attributes.uv.array,'VEC2')).setIndices(acc(g.index.array,'SCALAR'));
 for(const [name,x0,y0,axis]of [['Smile',0,1.35,1],['Blink',-.32,1.7,2]]){
  const changed=g.clone(),delta=new Float32Array(count*3);
  for(let i=0;i<count;i++){const x=g.attributes.position.getX(i),y=g.attributes.position.getY(i),f=Math.max(0,1-((x-x0)/.38)**2-((y-y0)/.22)**2);delta[i*3+axis]=f*(axis===1?.12:.08);changed.attributes.position.setXYZ(i,x+delta[i*3],y+delta[i*3+1],g.attributes.position.getZ(i)+delta[i*3+2])}
  changed.computeVertexNormals();changed.computeTangents();const target=doc.createPrimitiveTarget(name).setAttribute('POSITION',acc(delta,'VEC3').setSparse(sparse)).setAttribute('NORMAL',acc(Float32Array.from(changed.attributes.normal.array,(v,i)=>v-g.attributes.normal.array[i]),'VEC3').setSparse(sparse));
  if(tangents){const t=new Float32Array(count*3);for(let i=0;i<count;i++)for(let k=0;k<3;k++)t[i*3+k]=changed.attributes.tangent.array[i*4+k]-g.attributes.tangent.array[i*4+k];target.setAttribute('TANGENT',acc(t,'VEC3').setSparse(sparse))}prim.addTarget(target);changed.dispose();
 }
 if(texture)prim.setMaterial(doc.createMaterial('NPC').setBaseColorTexture(doc.createTexture('FaceColor').setImage(texture).setMimeType('image/png')));
 const mesh=doc.createMesh('NPC').addPrimitive(prim).setWeights([.15,.1]),node=doc.createNode('Face').setMesh(mesh).setWeights([.2,.05]),scene=doc.createScene().addChild(node);
 if(rigged){
  const hips=doc.createNode('Hips'),head=doc.createNode('Head').setTranslation([0,1.2,0]);hips.addChild(head);scene.addChild(hips);
  const joints=new Uint16Array(count*4),weights=new Float32Array(count*4);for(let i=0;i<count;i++){const w=Math.max(0,Math.min(1,(g.attributes.position.getY(i)-.8)/.6));joints[i*4+1]=1;weights[i*4]=1-w;weights[i*4+1]=w}
  prim.setAttribute('JOINTS_0',acc(joints,'VEC4')).setAttribute('WEIGHTS_0',acc(weights,'VEC4'));const matrices=new Float32Array(32);matrices.set(new THREE.Matrix4().elements);matrices.set(new THREE.Matrix4().makeTranslation(0,-1.2,0).elements,16);node.setSkin(doc.createSkin('Rig').addJoint(hips).addJoint(head).setInverseBindMatrices(acc(matrices,'MAT4')));
  const sampler=doc.createAnimationSampler().setInput(acc(new Float32Array([0,.1,.2,.4,.6,.8,1]),'SCALAR')).setOutput(acc(new Float32Array([0,1.2,0,0,1.2,0,0,1.2,0,0,1.25,0,0,1.2,0,0,1.2,0,0,1.2,0]),'VEC3'));doc.createAnimation('HeadMotion').addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(head).setTargetPath('translation').setSampler(sampler));
 }
 const hold=doc.createAnimationSampler().setInput(acc(new Float32Array([0,.2,.4,1]),'SCALAR')).setOutput(acc(new Float32Array([.2,.05,.2,.05,.2,.05,.2,.05]),'SCALAR'));
 doc.createAnimation('Face_Static').addSampler(hold).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath('weights').setSampler(hold));
 for(const interpolation of ['LINEAR','STEP','CUBICSPLINE']){
  const values=interpolation==='CUBICSPLINE'?new Float32Array([0,0,.2,.05,0,0,0,0,.7,.8,0,0,0,0,.2,.05,0,0]):new Float32Array([.2,.05,.7,.8,.2,.05]),sampler=doc.createAnimationSampler().setInput(acc(new Float32Array([0,.4,1]),'SCALAR')).setOutput(acc(values,'SCALAR')).setInterpolation(interpolation);
  doc.createAnimation('Face_'+interpolation).addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath('weights').setSampler(sampler));
 }
 if(instance)scene.addChild(doc.createNode('SecondNPC').setMesh(mesh).setTranslation([3,0,0]).setWeights([0,.75]));return new WebIO().writeBinary(doc);
}

import {BoxGeometry,CylinderGeometry,Matrix4,Quaternion,Vector3} from 'three';
import {Document,WebIO} from '@gltf-transform/core';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {rigBoneSpec,suggestRigGuides} from '../../src/rig-guides.js';
import {DIGITS} from '../../src/finger-rig.js';

export async function fingerFixture() {
  const bounds={min:[-1,0,-.23],max:[1,2,.23]}, guides=suggestRigGuides(bounds), bones=rigBoneSpec(guides,bounds);
  const doc=new Document(), buffer=doc.createBuffer(), scene=doc.createScene();
  const nodes=bones.map(b=>doc.createNode(b.name).setTranslation(b.translation.toArray()).setRotation(b.rotation.toArray()));
  const index=new Map(bones.map((b,i)=>[b.name,i]));
  for (const [i,bone] of bones.entries()) if (bone.parent) nodes[index.get(bone.parent)].addChild(nodes[i]);
  scene.addChild(nodes[0]);
  const acc=(values,type)=>doc.createAccessor().setType(type).setBuffer(buffer).setArray(values);
  const skin=doc.createSkin('Forge test').setSkeleton(nodes[0]).setInverseBindMatrices(acc(new Float32Array(bones.flatMap(b=>b.inverseBind)),'MAT4'));
  for (const n of nodes) skin.addJoint(n);
  const geos=[new BoxGeometry(.28,2,.20).translate(0,1,0)], hips=[0], draft={height:2,hands:{}};
  const cylinder=(a,b,r,joint)=>{
    const length=a.distanceTo(b), rotation=new Quaternion().setFromUnitVectors(new Vector3(0,1,0),b.clone().sub(a).normalize());
    const geometry=new CylinderGeometry(r,r,length,12,9).applyQuaternion(rotation).translate(...a.clone().lerp(b,.5).toArray());
    geos.push(geometry);hips.push(joint);
  };
  for (const side of ['left','right']) {
    const prefix=side[0].toUpperCase()+side.slice(1), wrist=new Vector3(...guides[side+'Wrist']);
    const along=wrist.clone().sub(new Vector3(...guides[side+'Elbow'])).normalize(), spread=new Vector3(0,0,1);
    const palmDown=along.clone().cross(spread).normalize();
    if (palmDown.y>0) palmDown.negate();
    const at=(t,s)=>wrist.clone().addScaledVector(along,t).addScaledVector(spread,s);
    const palm=new BoxGeometry(.096,.035,.144);
    const basis=new Matrix4().makeBasis(along,palmDown,spread);
    palm.applyMatrix4(basis).translate(...at(.047,0).toArray());
    geos.push(palm);hips.push(index.get('mixamorig'+prefix+'Hand'));
    const fingers={};
    for (const [i,[digit]] of DIGITS.entries()) {
      const length=.19, base=at(length*[.25,.51,.54,.50,.46][i],[.052,.038,.008,-.022,-.051][i]);
      const end=at(length*[.66,.97,1,.94,.83][i],[.081,.045,.010,-.025,-.058][i]);
      cylinder(base,end,.0095,index.get('mixamorig'+prefix+'Hand'));
      fingers[digit]={enabled:true,radius:.074,points:[base,base.clone().lerp(end,.44),base.clone().lerp(end,.73),end].map(p=>p.toArray())};
    }
    draft.hands[side]={palmDown:palmDown.toArray(),length:.19,fingers};
  }
  const merged=mergeGeometries(geos), positions=merged.attributes.position.array;
  const joints=new Uint16Array(positions.length/3*4), weights=new Float32Array(joints.length);
  let at=0;
  for (const [i,g] of geos.entries()) {
    for (let k=0;k<g.attributes.position.count;k++,at++) {joints[at*4]=hips[i];weights[at*4]=1}
    g.dispose();
  }
  const p=doc.createPrimitive().setAttribute('POSITION',acc(positions,'VEC3')).setAttribute('NORMAL',acc(merged.attributes.normal.array,'VEC3'))
    .setAttribute('JOINTS_0',acc(joints,'VEC4')).setAttribute('WEIGHTS_0',acc(weights,'VEC4')).setIndices(acc(merged.index.array,'SCALAR'));
  scene.addChild(doc.createNode('Fingerless').setMesh(doc.createMesh().addPrimitive(p)).setSkin(skin));
  const hand=index.get('mixamorigLeftHand'), old=bones[hand].rotation;
  const turn=old.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.71));
  const sampler=doc.createAnimationSampler().setInput(acc(new Float32Array([0,1]),'SCALAR'))
    .setOutput(acc(new Float32Array([...old.toArray(),...turn.toArray()]),'VEC4'));
  const channel=doc.createAnimationChannel().setTargetNode(nodes[hand]).setTargetPath('rotation').setSampler(sampler);
  doc.createAnimation('Wrist test').addSampler(sampler).addChannel(channel);
  doc.getRoot().setExtras({phoenixRig:{profile:'humanoid-body',joints:27,armLocalWeights:1}});
  merged.dispose();
  return {bytes:await new WebIO().writeBinary(doc),draft};
}

import {Quaternion,Vector3,Matrix4,MathUtils} from 'three';
import {findCanonicalBone} from './animation-retarget.js';

const EPS=1e-8;
const descendant=(child,parent)=>{for(let p=child?.parent;p;p=p.parent)if(p===parent)return true;return false};
const position=(ref,bone)=>ref.positions.get(bone);

// A longitudinal direction alone leaves bone roll unconstrained. Construct a
// second axis from the shoulder/elbow/wrist or hip/knee/ankle bend plane.
// Straight limbs use the body's forward axis rather than arbitrary local XYZ.
export function anatomicalFrames(bones,ref){
 const result=new Map(),find=id=>findCanonicalBone(bones,id);
 const hips=find('hips'),head=find('head')||find('neck');
 const left=find('leftarm')||find('leftshoulder'),right=find('rightarm')||find('rightshoulder');
 let forward=null,up=null;
 if([hips,head,left,right].every(b=>b&&position(ref,b))){
  const across=position(ref,left).clone().sub(position(ref,right));
  up=position(ref,head).clone().sub(position(ref,hips));
  if(across.lengthSq()>EPS&&up.lengthSq()>EPS){
   across.normalize();up.addScaledVector(across,-up.dot(across)).normalize();
   forward=across.cross(up);if(forward.lengthSq()>EPS)forward.normalize();else forward=null;
  }
 }
 function frame(axis,normal){
  const x=axis.clone().normalize(),y=normal.clone().addScaledVector(x,-normal.dot(x));
  if(y.lengthSq()<EPS)return null;y.normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x,y,x.clone().cross(y).normalize()));
 }
 for(const side of ['left','right'])for(const type of ['arm','leg']){
  const ids=type==='arm'?['arm','forearm','hand']:['upleg','leg','foot'];
  const [upper,middle,end]=ids.map(id=>find(side+id));
  if(![upper,middle,end].every(b=>b&&position(ref,b))||!descendant(middle,upper)||!descendant(end,middle))continue;
  const incoming=position(ref,middle).clone().sub(position(ref,upper));
  const outgoing=position(ref,end).clone().sub(position(ref,middle));
  if(incoming.lengthSq()<EPS||outgoing.lengthSq()<EPS)continue;
  incoming.normalize();outgoing.normalize();
  const observed=incoming.clone().cross(outgoing);
  const pole=forward?.clone().multiplyScalar(type==='leg'?-1:1);
  let expected=pole&&incoming.clone().cross(pole);
  if(expected&&expected.lengthSq()<EPS)expected=incoming.clone().cross(up);
  if(expected&&expected.lengthSq()>EPS)expected.normalize();else expected=null;
  // Tiny pre-bends are numerically ambiguous. Use observed geometry only when
  // it provides a stable plane, with its sign anchored to the body landmarks.
  let normal=observed.lengthSq()>.0025?observed.normalize():expected;
  if(!normal)continue;
  if(expected&&normal.dot(expected)<0)normal.negate();
  const upperFrame=frame(incoming,normal),lowerFrame=frame(outgoing,normal);
  if(!upperFrame||!lowerFrame)continue;
  const rest=ref.get(middle),inverse=rest.clone().invert();
  const restFlex=Math.atan2(normal.dot(incoming.clone().cross(outgoing)),MathUtils.clamp(incoming.dot(outgoing),-1,1));
  result.set(upper,{frame:upperFrame});
  result.set(middle,{frame:lowerFrame,hinge:{
   axis:normal.clone().applyQuaternion(inverse).normalize(),
   longitudinal:outgoing.clone().applyQuaternion(inverse).normalize(),
   rest:middle.quaternion.clone(),restFlex,
   min:0,max:MathUtils.degToRad(type==='arm'?155:160),
   maxTwist:type==='arm'?Math.PI:MathUtils.degToRad(25),type
  }});
  if(type==='arm'){
   const shoulder=find(side+'shoulder');
   if(shoulder&&descendant(upper,shoulder)&&position(ref,shoulder)){
    const axis=position(ref,upper).clone().sub(position(ref,shoulder));
    if(axis.lengthSq()>EPS){const value=frame(axis,normal);if(value)result.set(shoulder,{frame:value})}
   }
  }
 }
 return result;
}

const signedAngle=(q,axis)=>{
 let angle=2*Math.atan2(new Vector3(q.x,q.y,q.z).dot(axis),q.w);
 while(angle>Math.PI)angle-=2*Math.PI;while(angle< -Math.PI)angle+=2*Math.PI;
 return angle;
};

// Keep forearm pronation, while removing lateral hinge swing and backwards
// flexion. Work relative to the character's own bind pose, not Euler XYZ.
export function constrainAnatomicalJoint(local,hinge){
 const delta=hinge.rest.clone().invert().multiply(local).normalize();
 if(delta.w<0)delta.set(-delta.x,-delta.y,-delta.z,-delta.w);
 const along=new Vector3(delta.x,delta.y,delta.z).dot(hinge.longitudinal);
 const vector=hinge.longitudinal.clone().multiplyScalar(along);
 const twist=new Quaternion(vector.x,vector.y,vector.z,delta.w);
 if(twist.lengthSq()<EPS)twist.identity();else twist.normalize();
 const swing=delta.clone().multiply(twist.clone().invert());
 const angle=signedAngle(swing,hinge.axis);
 const flex=MathUtils.clamp(hinge.restFlex+angle,hinge.min,hinge.max)-hinge.restFlex;
 const twistAngle=MathUtils.clamp(signedAngle(twist,hinge.longitudinal),-hinge.maxTwist,hinge.maxTwist);
 return hinge.rest.clone()
  .multiply(new Quaternion().setFromAxisAngle(hinge.axis,flex))
  .multiply(new Quaternion().setFromAxisAngle(hinge.longitudinal,twistAngle)).normalize();
}

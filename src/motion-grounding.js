import {AnimationMixer, LoopOnce, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack} from 'three';
import {clone as cloneSkeleton} from 'three/addons/utils/SkeletonUtils.js';
import {characterBones, findCanonicalBone} from './animation-retarget.js';

const sides = ['left', 'right'];
const axisComponents = [-1,0,1];
const axes = axisComponents.flatMap(x=>axisComponents.flatMap(y=>axisComponents.map(z=>[x,y,z])))
  .filter(([x,y,z])=>x||y||z);
const point = node => node.getWorldPosition(new Vector3());
const rotation = node => node.getWorldQuaternion(new Quaternion());
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const smooth = x => { const t = clamp(x,0,1); return t*t*(3-2*t); };
const below = (node, ancestor) => {
  for (let p=node; p; p=p.parent) if (p===ancestor) return true;
  return false;
};

export function makeSourceFootContact(skeleton, reference) {
  const find = role => findCanonicalBone(skeleton.bones, role);
  const hips = find('hips'), top = find('neck') || find('head') || find('spine2');
  const legs = sides.map(side => ['upleg','leg','foot','toebase'].map(part => find(side+part)));
  if (!hips || !top || legs.some(chain => chain.slice(0,3).some(bone => !bone))) return () => 0;
  const legSize = legs.reduce((sum,[thigh,knee,foot]) => sum+
    reference.positions.get(thigh).distanceTo(reference.positions.get(knee))+
    reference.positions.get(knee).distanceTo(reference.positions.get(foot)),0)/2;
  if (legSize<1e-6) return () => 0;
  const torso = new Vector3();
  return ({positions}) => {
    torso.subVectors(positions.get(top),positions.get(hips)).normalize();
    const feet = legs.map(([, ,foot,toe]) => Math.min(positions.get(foot).y, toe ? positions.get(toe).y : Infinity));
    const support = legs.map(([,knee],i)=>(positions.get(knee).y-feet[i])/legSize);
    const gap = Math.abs(feet[0]-feet[1])/legSize;
    return smooth((torso.y-.62)/.20) * smooth((Math.min(...support)-.06)/.15) * smooth((.075-gap)/.045);
  };
}

// Keep extrema along the axes and diagonals for each main bone influence.
// This samples the soles while standing and the torso/limbs when lying down.
function supportVertices(mesh, hips, feet) {
  const {position,skinIndex,skinWeight} = mesh.geometry.attributes;
  const joints = mesh.skeleton.bones;
  const movable = joints.map(bone=>below(bone,hips));
  if (!position || !skinIndex || !skinWeight || !movable.includes(true)) return [];
  const part = joints.map(bone=>feet.findIndex(foot=>foot&&below(bone,foot)));
  const groups = new Map();
  const indexed = mesh.geometry.index;
  const referenced = indexed ? new Uint8Array(position.count) : null;
  if (referenced) for (let i=0;i<indexed.count;i++) referenced[indexed.getX(i)]=1;
  for (let n=0; n<position.count; n++) {
    if (referenced && !referenced[n]) continue;
    let total=0, main=-1, highest=0;
    for (let k=0;k<4;k++){
      const joint=skinIndex.getComponent(n,k),weight=skinWeight.getComponent(n,k);
      if (movable[joint]) total+=weight;
      if (weight>highest){highest=weight;main=joint}
    }
    if (total<.995 || main<0) continue;
    let group=groups.get(main);
    if (!group){
      group={dots:new Float64Array(axes.length).fill(-Infinity),indices:new Int32Array(axes.length).fill(-1)};
      groups.set(main,group);
    }
    const x=position.getX(n),y=position.getY(n),z=position.getZ(n);
    for (let i=0;i<axes.length;i++){
      const [a,b,c]=axes[i],dot=a*x+b*y+c*z;
      if(dot>group.dots[i]){group.dots[i]=dot;group.indices[i]=n}
    }
  }
  return [...groups].flatMap(([joint,{indices}])=>[...new Set(indices)].filter(i=>i>=0).map(index=>({mesh,index,foot:part[joint]})));
}

function minimumSurface(points) {
  const p = new Vector3(), feet=[Infinity,Infinity];
  let body=Infinity;
  for (const {mesh,index,foot} of points) {
    const y=mesh.getVertexPosition(index,p).applyMatrix4(mesh.matrixWorld).y;
    body=Math.min(body,y);
    if (foot>=0) feet[foot]=Math.min(feet[foot],y);
  }
  return {body,feet};
}

function setWorldRotation(bone, worldQuaternion) {
  bone.quaternion.copy(rotation(bone.parent).invert().multiply(worldQuaternion).normalize());
  bone.updateMatrixWorld(true);
}

// Preserve the knee's bend plane and the foot's world orientation. If the
// vertical target is outside reach, shorten the horizontal step as needed.
function shiftFootHeight([thigh,knee,foot], deltaY) {
  const a=point(thigh),b=point(knee),c=point(foot),footRotation=rotation(foot);
  const thighLength=a.distanceTo(b), calfLength=b.distanceTo(c);
  if(Math.min(thighLength,calfLength)<1e-7)return false;
  const maxReach=(thighLength+calfLength)*.9999, minReach=Math.abs(thighLength-calfLength)+maxReach*1e-4;
  const offset=c.clone().sub(a);
  offset.y=clamp(offset.y+deltaY,-maxReach,maxReach);
  const currentXZ=Math.hypot(offset.x,offset.z);
  const allowedXZ=Math.sqrt(Math.max(0,maxReach*maxReach-offset.y*offset.y));
  if(currentXZ>allowedXZ){offset.x*=allowedXZ/currentXZ;offset.z*=allowedXZ/currentXZ}
  const distance=offset.length();
  if(distance<minReach)return false;
  const aim=offset.clone().normalize();
  const pole=b.clone().sub(a).addScaledVector(aim,-b.clone().sub(a).dot(aim));
  if(pole.lengthSq()<1e-10){
    pole.set(0,0,1).applyQuaternion(footRotation);
    pole.addScaledVector(aim,-pole.dot(aim));
    if(pole.lengthSq()<1e-10)return false;
  }
  const along=(thighLength*thighLength-calfLength*calfLength+distance*distance)/(2*distance);
  const kneeTarget=a.clone().addScaledVector(aim,along).addScaledVector(pole.normalize(),Math.sqrt(Math.max(0,thighLength*thighLength-along*along)));
  const twist = new Quaternion().setFromUnitVectors(b.sub(a).normalize(),kneeTarget.sub(a).normalize());
  setWorldRotation(thigh,twist.multiply(rotation(thigh)));
  const newKnee=point(knee);
  twist.setFromUnitVectors(point(foot).sub(newKnee).normalize(),a.add(offset).sub(newKnee).normalize());
  setWorldRotation(knee,twist.multiply(rotation(knee)));
  setWorldRotation(foot,footRotation);
  return true;
}

function play(root, clip, sample) {
  const mixer=new AnimationMixer(root), action=mixer.clipAction(clip);
  action.setLoop(LoopOnce,1);action.clampWhenFinished=true;action.play();
  try{
    sample(t=>{mixer.setTime(t);root.updateMatrixWorld(true)});
  }finally{
    mixer.stopAllAction();mixer.uncacheRoot(root);root.updateMatrixWorld(true);
  }
}

export function bakeGroundContact(targetRoot, hipsName, clip, times, contacts, refreshHelpers) {
  const root=cloneSkeleton(targetRoot),bones=characterBones(root),hips=bones.find(bone=>bone.name===hipsName);
  if(!hips?.parent)return {grounded:false,stance:false};
  const legs=sides.map(side=>['upleg','leg','foot'].map(part=>findCanonicalBone(bones,side+part)));
  const points=[];
  root.traverse(mesh=>{if(mesh.isSkinnedMesh&&mesh.skeleton)for(const p of supportVertices(mesh,hips,legs.map(chain=>chain[2])))points.push(p)});
  if(!points.length)return {grounded:false,stance:false};

  let stance=false;
  const canLevel=contacts?.some(value=>value>0)&&legs.every(([thigh,knee,foot])=>{
    if(!thigh||knee?.parent!==thigh||foot?.parent!==knee||!below(thigh,hips))return false;
    const scale=foot.getWorldScale(new Vector3());
    return Math.min(scale.x,scale.y,scale.z)>0&&Math.max(scale.x,scale.y,scale.z)<1.002*Math.min(scale.x,scale.y,scale.z);
  });
  if(canLevel){
    const tracks=legs.flat().map(bone=>({bone,name:bone.name+'.quaternion',values:new Float32Array(times.length*4)}));
    if(tracks.every(out=>clip.tracks.some(track=>track.name===out.name))){
      const stature=legs.reduce((sum,[thigh,knee,foot])=>sum+point(thigh).distanceTo(point(knee))+point(knee).distanceTo(point(foot)),0)/2;
      play(root,clip,at=>{
        for(let i=0;i<times.length;i++){
          at(times[i]);
          let originalPose;
          if(contacts[i]>.001){
            const {feet}=minimumSurface(points),difference=feet[0]-feet[1];
            if(Number.isFinite(difference)&&Math.abs(difference)>stature*.006){
              const higher=difference>0?0:1, lower=1-higher;
              const gap=Math.abs(difference), amount=gap*contacts[i];
              originalPose=tracks.map(({bone})=>bone.quaternion.clone());
              if(shiftFootHeight(legs[higher],-amount)){
                stance=true;
                // At full leg extension, level the other foot to the
                // reachable height; the following pass drops the pelvis.
                const corrected=minimumSurface(points).feet;
                const remaining=corrected[higher]-corrected[lower]-(gap-amount);
                if(remaining>stature*.006)shiftFootHeight(legs[lower],remaining);
              }
            }
          }
          for(const track of tracks)track.bone.quaternion.toArray(track.values,i*4);
          // The mixer may skip reapplying an identical sample on the next
          // frame. Restore the source pose after capturing the corrected keys.
          if(originalPose)tracks.forEach(({bone},k)=>bone.quaternion.copy(originalPose[k]));
        }
      });
      if(stance){
        const updates=new Map(tracks.map(t=>[t.name,new QuaternionKeyframeTrack(t.name,times.slice(),t.values)]));
        clip.tracks=clip.tracks.map(track=>updates.get(track.name)||track);
        refreshHelpers(clip);
      }
    }
  }
  // Sample between rotation keys as well. The lowest point can switch from
  // one limb to another before either of the next rotation keys.
  const groundTimes=times.length<9000
    ? Float32Array.from(Array.from(times).flatMap((t,i)=>i+1<times.length?[t,(t+times[i+1])/2]:[t]))
    : times;
  const sampledTimes=groundTimes.filter((t,i)=>i===0||t>groundTimes[i-1]);
  const name=hips.name+'.position',values=new Float32Array(sampledTimes.length*3);
  let grounded=true;
  play(root,clip,at=>{
    for(let i=0;i<sampledTimes.length;i++){
      at(sampledTimes[i]);
      const {body}=minimumSurface(points);
      if(!Number.isFinite(body)){grounded=false;break}
      const shifted=point(hips);shifted.y-=body;
      hips.parent.worldToLocal(shifted).toArray(values,i*3);
    }
  });
  if(grounded){
    clip.tracks=clip.tracks.filter(track=>track.name!==name);
    clip.tracks.push(new VectorKeyframeTrack(name,sampledTimes,values));
  }
  return {grounded,stance};
}

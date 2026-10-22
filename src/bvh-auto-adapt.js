/**
 * Pose-aware BVH retargeting for already-skinned humanoids.
 * Does NOT create a rig or repair skin weights. No source/target mutation.
 *
 * CMU MotionBuilder BVH files add a synthetic T pose at frame zero.
 * Calibrate from frame zero and begin the exported clip at the first real
 * capture frame. Source world-space orientation deltas are reconstructed
 * through the complete BVH hierarchy, then translated into target-local
 * bone animation, respecting unmapped parent bones.
 */
import * as THREE from 'three';
import { canonicalBone,characterBones,isRiggedCharacter } from './animation-retarget.js';

const EPS=1e-7;
const Q=()=>new THREE.Quaternion();
function byCanonical(skeleton){
 const m=new Map();
 for(const bone of skeleton.bones||[]){
   const id=canonicalBone(bone.name);
   if(!m.has(id))m.set(id,bone);
 }
 return m;
}
function limbLength(lookup,side){
 const joints=[side+'upleg',side+'leg',side+'foot'].map(k=>lookup.get(k));
 if(joints.some(x=>!x))return null;
 // Bone offsets are the physical lengths from the preceding joint.
 return joints[1].position.length()+joints[2].position.length();
}
export function estimateRigScale(sourceSkeleton,targetRoot){
 const src=byCanonical(sourceSkeleton),dst=byCanonical({bones:characterBones(targetRoot)});
 const a=[limbLength(src,'left'),limbLength(src,'right')].filter(x=>x&&Number.isFinite(x));
 const b=[limbLength(dst,'left'),limbLength(dst,'right')].filter(x=>x&&Number.isFinite(x));
 if(!a.length||!b.length)return {ratio:1,measured:false};
 const avg=arr=>arr.reduce((x,y)=>x+y,0)/arr.length;
 const ratio=avg(b)/avg(a);
 if(!Number.isFinite(ratio)||ratio<=0||ratio>10000||ratio<.00001)
   return {ratio:1,measured:false};
 return {ratio,measured:true};
}
function sourceSamples(skeleton,clip){
 const tracks=new Map(clip.tracks.filter(t=>t.name.endsWith('.quaternion')).map(t=>[
   t.name.slice(0,-'.quaternion'.length),t.createInterpolant()
 ]));
 const bones=skeleton.bones.filter(b=>b.isBone);
 const boneSet=new Set(bones);
 function at(time){
   const global=new Map();
   function rotation(b){
     if(global.has(b))return global.get(b);
     let local=b.quaternion.clone();
     const ip=tracks.get(b.name);
     if(ip){
       const sample=ip.evaluate(time);
       local.fromArray(sample).normalize();
       if(!Number.isFinite(local.x+local.y+local.z+local.w))
         throw Error('Повреждённые вращения BVH у кости '+b.name);
     }
     if(boneSet.has(b.parent))local.premultiply(rotation(b.parent));
     global.set(b,local);return local;
   }
   for(const bone of bones)rotation(bone);
   return global;
 }
 return at;
}
function targetReference(root){
 const world=new Map([[root,Q()]]);
 const nodes=[];
 root.traverse(obj=>{
   if(obj===root)return;
   const parent=world.get(obj.parent);
   if(!parent)throw Error('Некорректная иерархия модели');
   world.set(obj,parent.clone().multiply(obj.quaternion));
   nodes.push(obj);
 });
 return {world,nodes};
}
function direction(bone,ref){
 // Real joint direction, not the bone's arbitrary local Euler axes.
 // Ignore zero-length helper joints in the CMU skeleton.
 for(const child of bone.children){
   if(child.isBone && child.position.lengthSq()>EPS){
     return child.position.clone().applyQuaternion(ref.get(bone)).normalize();
   }
 }
 return null;
}
function mapPairs(sourceSkeleton,targetRoot,mappings){
 if(!isRiggedCharacter(targetRoot))throw Error('У персонажа нет привязанного скелета');
 const s=new Map(sourceSkeleton.bones.map(b=>[b.name,b]));
 const t=new Map(characterBones(targetRoot).map(b=>[b.name,b]));
 const used=new Set(),pairs=[];
 for(const row of mappings||[]){
   if(!row.target)continue;
   const from=s.get(row.source),to=t.get(row.target);
   if(!from||!to||used.has(row.target))
     throw Error('Некорректное соответствие костей: '+row.source+' → '+row.target);
   used.add(row.target);pairs.push({from,to});
 }
 if(!pairs.length)throw Error('Сопоставь хотя бы одну кость BVH');
 return pairs;
}
export function autoAdaptBvhClip({
 targetRoot,sourceSkeleton,sourceClip,mappings,name='BVH Motion',
 rootMotion=false,scale=1,autoScale=true,alignAxes=true,
 trimCalibration=true
}){
 if(!Number.isFinite(scale)||scale<=0||scale>100)
   throw Error('Масштаб движения должен быть больше 0 и не более 100');
 const pairs=mapPairs(sourceSkeleton,targetRoot,mappings);
 const sampler=sourceSamples(sourceSkeleton,sourceClip);
 const ref=targetReference(targetRoot);
 const quatTracks=sourceClip.tracks.filter(t=>t.name.endsWith('.quaternion'));
 const timeTrack=quatTracks[0];
 if(!timeTrack||timeTrack.times.length<2)throw Error('В BVH слишком мало кадров');
 const times=timeTrack.times;
 // CMU 2010 BVH's frame 0 is calibration; frame 1 is capture.
 const first=trimCalibration?1:0;
 const origin=times[first];
 const timeline=new Float32Array(times.length-first);
 for(let i=first;i<times.length;i++)timeline[i-first]=times[i]-origin;
 const sourceRef=sampler(times[0]);
 const targetRef=ref.world;
 const fromForTarget=new Map(pairs.map(pair=>[pair.to,pair.from]));
 const corrections=new Map();
 const identity=Q();
 for(const {from,to} of pairs){
   const sDir=direction(from,sourceRef),tDir=direction(to,targetRef);
   const correct=(alignAxes&&sDir&&tDir)?
     Q().setFromUnitVectors(sDir,tDir):identity.clone();
   corrections.set(to,correct);
 }
 const outputs=new Map(pairs.map(({to})=>[to,new Float32Array(timeline.length*4)]));
 const animated=new Map();
 const tempInverse=Q(),delta=Q(),local=Q();
 for(let frame=0;frame<timeline.length;frame++){
   const sourceFrame=sampler(times[frame+first]);
   animated.clear();animated.set(targetRoot,identity);
   for(const node of ref.nodes){
     const parent=animated.get(node.parent);
     const from=fromForTarget.get(node);
     if(from){
       const correct=corrections.get(node);
       // Global delta of the source bone relative to its reference T pose.
       delta.copy(sourceFrame.get(from)).multiply(
         tempInverse.copy(sourceRef.get(from)).invert()
       );
       // Reorient the delta into the target bone's limb frame.
       if(alignAxes)delta.premultiply(correct).multiply(Q().copy(correct).invert());
       const desired=delta.multiply(targetRef.get(node));
       local.copy(parent).invert().multiply(desired).normalize();
       if(!Number.isFinite(local.x+local.y+local.z+local.w))
         throw Error('Ошибка расчёта движения: '+node.name);
       local.toArray(outputs.get(node),frame*4);
       animated.set(node,desired.clone());
     }else{
       animated.set(node,parent.clone().multiply(node.quaternion));
     }
   }
 }
 const tracks=[];
 for(const {to} of pairs){
   const vals=outputs.get(to);
   if(!vals)continue;
   tracks.push(new THREE.QuaternionKeyframeTrack(
     to.name+'.quaternion',timeline.slice(),vals
   ));
 }
 const sizing=autoScale?estimateRigScale(sourceSkeleton,targetRoot):{ratio:1,measured:false};
 if(rootMotion){
   const hips=pairs.find(({from})=>canonicalBone(from.name)==='hips');
   if(hips){
     const p=sourceClip.tracks.find(t=>t.name===hips.from.name+'.position');
     if(p&&p.values.length===p.times.length*3){
       const interp=p.createInterpolant();
       const start=Array.from(interp.evaluate(origin));
       const values=new Float32Array(timeline.length*3);
       const factor=scale*sizing.ratio;
       for(let i=0;i<timeline.length;i++){
         const xyz=interp.evaluate(times[i+first]);
         for(let axis=0;axis<3;axis++){
           values[i*3+axis]=hips.to.position.getComponent(axis)+
             (xyz[axis]-start[axis])*factor;
         }
       }
       tracks.push(new THREE.VectorKeyframeTrack(
         hips.to.name+'.position',timeline.slice(),values
       ));
     }
   }
 }
 const title=String(name||'BVH Motion').replace(/[^a-zA-Z0-9_ -]/g,'_').slice(0,60)||'BVH Motion';
 const clip=new THREE.AnimationClip(title,-1,tracks);
 clip.userData={
   poseAware:true,calibrationFrameRemoved:trimCalibration,
   autoScaleRatio:sizing.ratio,autoScaleMeasured:sizing.measured,
   matchedBones:pairs.length
 };
 return clip;
}

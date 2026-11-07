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
import { canonicalBone,characterBones,isRiggedCharacter,findCanonicalBone,boneMatchPriority } from './animation-retarget.js';

const EPS=1e-7;

/** Detect Bruce Hahne's CMU MotionBuilder-friendly conversion, not arbitrary BVH.
 * That conversion uses a synthetic T pose at frame zero and 120 fps.
 */
export function detectCmuCalibration(skeleton,clip){
 const names=new Set((skeleton?.bones||[]).map(b=>b.name.toLowerCase()));
 const hasMarker=names.has('lhipjoint')&&names.has('rhipjoint')&&names.has('lowerback');
 const track=clip?.tracks?.find(t=>t.times?.length>2);
 if(!hasMarker||!track)return false;
 const dt=track.times[1]-track.times[0];
 return Number.isFinite(dt)&&Math.abs(dt-1/120)<0.00012;
}
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
 const tracks=new Map((clip?.tracks||[]).filter(t=>t.name.endsWith('.quaternion')).map(t=>[
   t.name.slice(0,-'.quaternion'.length),t.createInterpolant()
 ]));
 const bones=skeleton.bones.filter(b=>b.isBone);
 const boneSet=new Set(bones);
 const positions=new Map((clip?.tracks||[]).filter(t=>t.name.endsWith('.position')).map(t=>[t.name.slice(0,-9),t.createInterpolant()]));
 function at(time,rest=false){
   const global=new Map();global.positions=new Map();global.scales=new Map();
   function rotation(b){
     if(global.has(b))return global.get(b);
     let local=b.quaternion.clone();
     const ip=tracks.get(b.name);
     if(ip&&!rest){
       const sample=ip.evaluate(time);
       local.fromArray(sample).normalize();
       if(!Number.isFinite(local.x+local.y+local.z+local.w))
         throw Error('Повреждённые вращения BVH у кости '+b.name);
     }
     const p=b.position.clone(),position=positions.get(b.name);if(position&&!rest)p.fromArray(position.evaluate(time));
     const s=b.scale.clone();
     if(boneSet.has(b.parent)){const parent=rotation(b.parent);p.multiply(global.scales.get(b.parent)).applyQuaternion(parent).add(global.positions.get(b.parent));s.multiply(global.scales.get(b.parent));local.premultiply(parent)}
     global.positions.set(b,p);global.scales.set(b,s);
     global.set(b,local);return local;
   }
   for(const bone of bones)rotation(bone);
   return global;
 }
 return at;
}
function targetReference(root){
 const world=new Map([[root,Q()]]);
 world.positions=new Map([[root,new THREE.Vector3()]]);world.scales=new Map([[root,new THREE.Vector3(1,1,1)]]);
 const nodes=[];
 root.traverse(obj=>{
   if(obj===root)return;
   const parent=world.get(obj.parent);
   if(!parent)throw Error('Некорректная иерархия модели');
   world.set(obj,parent.clone().multiply(obj.quaternion));
   world.positions.set(obj,obj.position.clone().multiply(world.scales.get(obj.parent)).applyQuaternion(parent).add(world.positions.get(obj.parent)));world.scales.set(obj,obj.scale.clone().multiply(world.scales.get(obj.parent)));
   nodes.push(obj);
 });
 return {world,nodes};
}
function modelTimeline(clip){
 const values=new Set([0,clip.duration]);for(let t=1/60;t<clip.duration;t+=1/60){values.add(t);if(values.size>18000)throw Error('Движение слишком длинное: до 18 тысяч кадров переноса')}
 for(const track of clip.tracks)for(const t of track.times){values.add(t);if(track.getInterpolation()===THREE.InterpolateDiscrete&&t>0)values.add(Math.max(0,t-.0001))}
 const sorted=[...values].sort((a,b)=>a-b),times=[];for(const t of sorted)if(!times.length||t-times.at(-1)>1e-5)times.push(t);if(times.length>18000)throw Error('В движении больше 18 тысяч моментов времени');return new Float32Array(times);
}
function bodyAlignment(source,target,skeleton,targetRoot){
 const basis=(ref,bones)=>{const find=id=>findCanonicalBone(bones,id),hips=find('hips'),top=find('head')||find('neck'),left=find('leftarm')||find('leftshoulder'),right=find('rightarm')||find('rightshoulder');if(![hips,top,left,right].every(Boolean))return null;
  const x=ref.positions.get(left).clone().sub(ref.positions.get(right)),y=ref.positions.get(top).clone().sub(ref.positions.get(hips));if(x.lengthSq()<EPS||y.lengthSq()<EPS)return null;x.normalize();y.addScaledVector(x,-y.dot(x));if(y.lengthSq()<EPS)return null;y.normalize();const z=x.clone().cross(y).normalize();return Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z))};
 const a=basis(source,skeleton.bones),b=basis(target,characterBones(targetRoot));return a&&b?b.multiply(a.invert()):Q();
}
function modelScale(source,target,skeleton,targetRoot){
 const length=(ref,bones,side)=>{const ids=[side+'upleg',side+'leg',side+'foot'],points=ids.map(id=>bones.find(b=>canonicalBone(b.name)===id)).map(b=>b&&ref.positions.get(b));return points.every(Boolean)?points[0].distanceTo(points[1])+points[1].distanceTo(points[2]):null};
 const ratios=['left','right'].map(s=>{const a=length(source,skeleton.bones,s),b=length(target,characterBones(targetRoot),s);return a&&b?b/a:null}).filter(r=>Number.isFinite(r)&&r>.00001&&r<10000);return ratios.length?{ratio:ratios.reduce((a,b)=>a+b,0)/ratios.length,measured:true}:{ratio:1,measured:false};
}
function direction(bone,ref,semantic=false){
 const id=canonicalBone(bone.name),next={hips:['spine','spine1','spine2','neck','head'],spine:['spine1','spine2','neck','head'],spine1:['spine2','neck','head'],spine2:['neck','head'],neck:['head'],head:['headend','headtopend','headleaf']};
 for(const side of ['left','right'])Object.assign(next,{[side+'shoulder']:[side+'arm'],[side+'arm']:[side+'forearm'],[side+'forearm']:[side+'hand'],[side+'hand']:[side+'handmiddle1',side+'handindex1'],[side+'upleg']:[side+'leg'],[side+'leg']:[side+'foot'],[side+'foot']:[side+'toebase'],[side+'toebase']:[]});
 const finger=id.match(/^(left|right)hand(thumb|index|middle|ring|pinky)([123])$/);if(finger)next[id]=Number(finger[3])<3?[finger[1]+'hand'+finger[2]+(Number(finger[3])+1)]:[];
 if(semantic&&next[id]&&ref.positions){const descendants=[];bone.traverse(n=>{if(n!==bone&&n.isBone)descendants.push(n)});for(const role of next[id])for(const child of descendants.filter(n=>canonicalBone(n.name)===role).sort((a,b)=>boneMatchPriority(a.name)-boneMatchPriority(b.name))){const v=ref.positions.get(child).clone().sub(ref.positions.get(bone));if(v.lengthSq()>EPS)return v.normalize()}return null;}
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
 trimCalibration=true,referencePose='first-frame'
}){
 if(!Number.isFinite(scale)||scale<=0||scale>100)
   throw Error('Масштаб движения должен быть больше 0 и не более 100');
 const pairs=mapPairs(sourceSkeleton,targetRoot,mappings);
 const sampler=sourceSamples(sourceSkeleton,sourceClip);
 const ref=targetReference(targetRoot);
 const quatTracks=sourceClip.tracks.filter(t=>t.name.endsWith('.quaternion'));
 const model=referencePose==='rest',timeTrack=quatTracks.find(t=>t.times.length>=2)||quatTracks[0];
 if(!timeTrack||!model&&timeTrack.times.length<2)throw Error('В движении слишком мало кадров');
 const times=model?modelTimeline(sourceClip):timeTrack.times;
 // CMU 2010 BVH's frame 0 is calibration; frame 1 is capture.
 const first=!model&&trimCalibration?1:0;
 const origin=times[first];
 const timeline=new Float32Array(times.length-first);
 for(let i=first;i<times.length;i++)timeline[i-first]=times[i]-origin;
 const sourceRef=sampler(times[0],model);
 const targetRef=ref.world;
 const fromForTarget=new Map(pairs.map(pair=>[pair.to,pair.from]));
 const corrections=new Map();
 const identity=Q();
 const alignment=model&&alignAxes?bodyAlignment(sourceRef,targetRef,sourceSkeleton,targetRoot):Q();
 for(const to of ref.nodes){const from=fromForTarget.get(to);if(!from)continue;
   const sDir=direction(from,sourceRef,model),tDir=direction(to,targetRef,model);
   let inherited=alignment;for(let p=to.parent;p;p=p.parent)if(corrections.has(p)){inherited=corrections.get(p);break}
   const correct=(alignAxes&&sDir&&tDir)?
     Q().setFromUnitVectors(sDir.applyQuaternion(alignment),tDir).multiply(alignment):(model?inherited:alignment).clone();
   corrections.set(to,correct);
 }
 const outputs=new Map(pairs.map(({to})=>[to,new Float32Array(timeline.length*4)]));
 // Model clips use motion relative to their nearest corresponding ancestor.
 // Reorienting an entire inherited world delta per limb would make a static
 // arm counter-rotate when the torso moves between different T/A reference poses.
 const chains=new Map();if(model)for(const {from,to}of pairs){let ancestor=null,sourceAncestor=null;for(let p=to.parent;p;p=p.parent){const candidate=fromForTarget.get(p);if(!candidate)continue;let found=false;for(let q=from.parent;q;q=q.parent)if(q===candidate){found=true;break}if(found){ancestor=p;sourceAncestor=candidate;break}}
  const sourceRest=sourceRef.get(from).clone(),targetRest=targetRef.get(to).clone();if(sourceAncestor)sourceRest.premultiply(sourceRef.get(sourceAncestor).clone().invert());if(ancestor)targetRest.premultiply(targetRef.get(ancestor).clone().invert());
  const axis=targetRef.get(to).clone().invert().multiply(corrections.get(to)).multiply(sourceRef.get(from)).normalize();chains.set(to,{ancestor,sourceAncestor,sourceRestInverse:sourceRest.invert(),targetRest,axis,axisInverse:axis.clone().invert()});
 }
 const animated=new Map();
 const tempInverse=Q(),delta=Q(),local=Q();
 const hipsPair=pairs.filter(({from})=>canonicalBone(from.name)==='hips').sort((a,b)=>boneMatchPriority(a.from.name)-boneMatchPriority(b.from.name))[0],hipPositions=model&&rootMotion&&hipsPair?new Float32Array(timeline.length*3):null;
 for(let frame=0;frame<timeline.length;frame++){
   const sourceFrame=sampler(times[frame+first]);
   if(hipPositions)sourceFrame.positions.get(hipsPair.from).toArray(hipPositions,frame*3);
   animated.clear();animated.set(targetRoot,identity);
   for(const node of ref.nodes){
     const parent=animated.get(node.parent);
     const from=fromForTarget.get(node);
     if(from){
       let desired;
       if(model){const chain=chains.get(node);delta.copy(sourceFrame.get(from));if(chain.sourceAncestor)delta.premultiply(tempInverse.copy(sourceFrame.get(chain.sourceAncestor)).invert());delta.premultiply(chain.sourceRestInverse).premultiply(chain.axis).multiply(chain.axisInverse);desired=chain.targetRest.clone().multiply(delta);if(chain.ancestor)desired.premultiply(animated.get(chain.ancestor));desired.normalize();}
       else{
       const correct=corrections.get(node);
       // Global delta of the source bone relative to its reference T pose.
       delta.copy(sourceFrame.get(from)).multiply(
         tempInverse.copy(sourceRef.get(from)).invert()
       );
       // Reorient the delta into the target bone's limb frame.
       if(alignAxes)delta.premultiply(correct).multiply(Q().copy(correct).invert());
       desired=delta.multiply(targetRef.get(node));
       }
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
 const sizing=autoScale?(model?modelScale(sourceRef,targetRef,sourceSkeleton,targetRoot):estimateRigScale(sourceSkeleton,targetRoot)):{ratio:1,measured:false};
 if(rootMotion){
   const hips=hipsPair;
   if(hips){
    if(model&&hipPositions){const values=new Float32Array(hipPositions.length),start=new THREE.Vector3().fromArray(hipPositions),parent=hips.to.parent,parentRotation=(targetRef.get(parent)||Q()).clone().invert(),parentScale=targetRef.scales.get(parent)||new THREE.Vector3(1,1,1);for(let i=0;i<timeline.length;i++){const v=new THREE.Vector3().fromArray(hipPositions,i*3).sub(start).applyQuaternion(alignment).multiplyScalar(scale*sizing.ratio).applyQuaternion(parentRotation).divide(parentScale).add(hips.to.position);v.toArray(values,i*3)}tracks.push(new THREE.VectorKeyframeTrack(hips.to.name+'.position',timeline.slice(),values));}
    else{
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
 }
 const title=String(name||'Motion').replace(/[^\p{L}\p{N}_ -]/gu,'_').slice(0,60)||'Motion';
 const clip=new THREE.AnimationClip(title,-1,tracks);
 clip.userData={
   poseAware:true,calibrationFrameRemoved:first>0,referencePose,
   autoScaleRatio:sizing.ratio,autoScaleMeasured:sizing.measured,
   matchedBones:pairs.length
 };
 return clip;
}


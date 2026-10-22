/**
 * BVH → existing humanoid skeleton, conservative first stage.
 *
 * Requires an already-skinned character, never generates weights or bones.
 * Maps bone rotations by name (including common Mixamo aliases) and expresses
 * changes relative to each target bone's *current local rest rotation*.
 * Source and target must share local coordinate conventions; a name match is
 * NOT proof of compatible joint axes or reference pose. Always preview before
 * accepting/exporting an animation.
 */
import * as THREE from 'three';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';

function tidy(name){
  return String(name||'').toLowerCase()
    .replace(/^.*[:|]/,'')
    .replace(/^(mixamorig|armature|bip001|rigify)/,'')
    .replace(/[^a-z0-9]/g,'');
}
const ALIASES={
 hips:['hips','hip','pelvis','root'],
 spine:['spine','spine1','lowerback','abdomen'],
 spine2:['spine2','chest','upperchest','spine3','upperback'],
 neck:['neck','neck1'],head:['head'],
 leftshoulder:['leftshoulder','leftclavicle','lclavicle'],
 rightshoulder:['rightshoulder','rightclavicle','rclavicle'],
 leftarm:['leftarm','leftupperarm','leftuparm','lupperarm'],
 rightarm:['rightarm','rightupperarm','rightuparm','rupperarm'],
 leftforearm:['leftforearm','leftlowerarm','leftelbow','llowerarm'],
 rightforearm:['rightforearm','rightlowerarm','rightelbow','rlowerarm'],
 lefthand:['lefthand','leftwrist','lhand'],righthand:['righthand','rightwrist','rhand'],
 leftupleg:['leftupleg','leftthigh','leftupperleg','lthigh'],
 rightupleg:['rightupleg','rightthigh','rightupperleg','rthigh'],
 leftleg:['leftleg','leftcalf','leftlowerleg','leftshin','lcalf'],
 rightleg:['rightleg','rightcalf','rightlowerleg','rightshin','rcalf'],
 leftfoot:['leftfoot','leftankle','lfoot'],
 rightfoot:['rightfoot','rightankle','rfoot'],
 lefttoebase:['lefttoebase','lefttoe','ltoe'],
 righttoebase:['righttoebase','righttoe','rtoe']
};
const REVERSE=new Map(Object.entries(ALIASES).flatMap(([key,names])=>names.map(n=>[n,key])));
export function canonicalBone(name){const n=tidy(name);return REVERSE.get(n)||n;}
export function characterBones(root){
  const bones=[];
  root?.traverse(obj=>{if(obj.isBone)bones.push(obj)});
  return bones;
}
export function isRiggedCharacter(root){
  let skinned=false;
  root?.traverse(obj=>{if(obj.isSkinnedMesh && obj.skeleton?.bones?.length)skinned=true});
  return skinned;
}
export function parseBvhForRetarget(text,name='BVH Motion'){
  if(typeof text!=='string'||text.length>20*1048576)
    throw Error('BVH не должен превышать 20 МБ');
  const frame=text.match(/\bFrames:\s*(\d+)/i);
  if(!/^\s*HIERARCHY\b/.test(text)||!/\bMOTION\b/.test(text)||
     !frame||Number(frame[1])<2||Number(frame[1])>18000)
    throw Error('Повреждённый BVH или неподдерживаемое количество кадров (2–18000)');
  const data=new BVHLoader().parse(text);
  if(!data.skeleton?.bones?.length||!data.clip?.tracks?.length||data.clip.duration<=0)
    throw Error('В BVH не найдено движения скелета');
  data.clip.name=String(name||'BVH Motion').replace(/[^a-zA-Z0-9_ -]/g,'_').slice(0,60);
  return data;
}
export function suggestBoneMappings(sourceSkeleton,targetRoot){
  if(!sourceSkeleton?.bones||!isRiggedCharacter(targetRoot))
    throw Error('Для переноса BVH сначала загрузи персонажа со скелетом (SkinnedMesh)');
  const targets=characterBones(targetRoot);
  const canonicalGroups=new Map();
  for(const bone of targets){
    const id=canonicalBone(bone.name),group=canonicalGroups.get(id)||[];
    group.push(bone);canonicalGroups.set(id,group);
  }
  const exact=new Map();
  for(const bone of targets){
    const name=tidy(bone.name),group=exact.get(name)||[];
    group.push(bone);exact.set(name,group);
  }
  // Reserve exact-name matches globally before using aliases. This prevents
  // CMU helper joints (such as LowerBack) from stealing Mixamo Spine from
  // the real BVH Spine node, leaving the main torso unmapped.
  const assigned=new Set(),sources=sourceSkeleton.bones.filter(b=>b.isBone && b.name!=='ENDSITE');
  const destinations=new Map();
  for(const source of sources){
    const candidate=(exact.get(tidy(source.name))||[]).find(t=>!assigned.has(t.name));
    if(candidate){assigned.add(candidate.name);destinations.set(source.name,candidate.name)}
  }
  for(const source of sources){
    if(destinations.has(source.name))continue;
    const candidate=(canonicalGroups.get(canonicalBone(source.name))||[]).find(t=>!assigned.has(t.name));
    if(candidate){assigned.add(candidate.name);destinations.set(source.name,candidate.name)}
  }
  const mappings=sources.map(source=>({source:source.name,target:destinations.get(source.name)||''}));
  return {targets:targets.map(b=>b.name),mappings,
    matched:mappings.filter(x=>x.target).length,
    total:mappings.length};
}
function validatedMap(mapping,targetRoot,sourceSkeleton){
  const target=characterBones(targetRoot),targetByName=new Map(target.map(b=>[b.name,b]));
  const srcByName=new Map(sourceSkeleton.bones.map(b=>[b.name,b]));
  const results=[],used=new Set();
  for(const row of mapping){
    if(!row.target)continue;
    const from=srcByName.get(row.source),to=targetByName.get(row.target);
    if(!from||!to||used.has(row.target))
      throw Error('Некорректное соответствие костей: '+row.source+' → '+row.target);
    used.add(row.target);
    results.push({from,to});
  }
  if(!results.length)throw Error('Сопоставь хотя бы одну кость в настройках BVH');
  // Require actual animation on a mapped bone, not just a name coincidence.
  return results;
}
/**
 * Build tracks using local rest-relative rotations. We write target-bone
 * direct tracks ("BoneName.quaternion") because GLTFExporter can resolve
 * them to glTF nodes, unlike some .bones[] animation bindings.
 *
 * For hips: optional in-place (default) or root motion scaled by factor.
 * We never change source skeleton or target mesh while creating a clip.
 */
export function retargetBvhClip({
 targetRoot, sourceSkeleton, sourceClip,mappings,
 name='BVH Motion',rootMotion=false,scale=1
}){
 if(!Number.isFinite(scale)||scale<=0||scale>100)
   throw Error('Масштаб BVH должен быть от 0 до 100 (не включая 0)');
 if(!isRiggedCharacter(targetRoot))throw Error('У выбранного персонажа нет привязанного скелета');
 const pairs=validatedMap(mappings,targetRoot,sourceSkeleton);
 const srcTracks=new Map(sourceClip.tracks.map(t=>[t.name,t]));
 const out=[];
 const temp=new THREE.Quaternion(),baseline=new THREE.Quaternion();
 for(const {from,to} of pairs){
   const q=srcTracks.get(from.name+'.quaternion');
   if(q && q.times.length>0){
     if(q.values.length!==4*q.times.length)throw Error('Некорректная дорожка BVH '+from.name);
     // BVHLoader rest orientation is typically identity. Include rest
     // rotation to handle arbitrary (nonidentity) BVH source bones safely.
     baseline.copy(from.quaternion).invert();
     const rest=to.quaternion.clone();
     const values=new Float32Array(q.values.length);
     for(let i=0;i<q.times.length;i++){
       temp.fromArray(q.values,i*4).premultiply(baseline).premultiply(rest).normalize();
       if(!Number.isFinite(temp.x+temp.y+temp.z+temp.w))
         throw Error('Некорректные углы BVH: '+from.name);
       temp.toArray(values,i*4);
     }
     out.push(new THREE.QuaternionKeyframeTrack(to.name+'.quaternion',q.times.slice(),values));
   }
   if(rootMotion && canonicalBone(from.name)==='hips'){
     const p=srcTracks.get(from.name+'.position');
     if(p && p.values.length===3*p.times.length){
       const values=new Float32Array(p.values.length);
       for(let i=0;i<p.times.length;i++)for(let axis=0;axis<3;axis++)
         values[i*3+axis]=to.position.getComponent(axis)+
           (p.values[i*3+axis]-p.values[axis])*scale;
       out.push(new THREE.VectorKeyframeTrack(to.name+'.position',p.times.slice(),values));
     }
   }
 }
 if(!out.length)throw Error('Сопоставленные кости не содержат поддерживаемых анимационных каналов');
 const finalName=String(name).replace(/[^a-zA-Z0-9_ -]/g,'_').slice(0,60)||'BVH Motion';
 return new THREE.AnimationClip(finalName,-1,out);
}

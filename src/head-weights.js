import {canonicalBone} from './animation-retarget.js';
import {smooth} from './skin-weights.js';

const named=(bones,role)=>bones.find(bone=>canonicalBone(bone.name)===role);

export function headWeightRegion(bones, height, pivot) {
  const head = named(bones,'head');
  const neck = named(bones,'neck');
  if (!head || !neck || !(height > 0)) return null;
  const center = pivot || head.position;
  const rise = center[1]-neck.position[1];
  if (!(rise>height*.004)) return null;

  const left=named(bones,'leftarm')||named(bones,'leftshoulder');
  const right=named(bones,'rightarm')||named(bones,'rightshoulder');
  const dx=left&&right?left.position[0]-right.position[0]:1;
  const dz=left&&right?left.position[2]-right.position[2]:0;
  const width=Math.hypot(dx,dz);
  const side=width>1e-7?[dx/width,dz/width]:[1,0];
  const byId=new Map(bones.map(bone=>[bone.id,bone]));
  const descendants=new Set(bones.filter(bone=>{
    for(let parent=byId.get(bone.parent),remaining=bones.length;parent&&remaining>0;parent=byId.get(parent.parent),remaining--){
      if(parent===head)return true;
    }
    return false;
  }).map(bone=>bone.id));

  return {
    head: head.id,
    neck: neck.id,
    center,
    side,
    height,
    descendants,
    below: Math.max(height*.013,Math.min(height*.036,rise*.44)),
    above: Math.max(height*.013,Math.min(height*.028,rise*.30))
  };
}

// A snout can sit below the head pivot. The forward reach protects it while
// the back and sides still fade around the neckline.
export function headWeightTargets(part, region, strength) {
  const targets = new Float32Array(part.positions.length / 3).fill(NaN);
  if (!region || strength === 0) return targets;
  const {head,neck,center,side,height,descendants,below,above}=region;
  for (let n = 0; n < targets.length; n++) {
    const x = part.positions[n * 3] - center[0];
    const y = part.positions[n * 3 + 1] - center[1];
    const z = part.positions[n * 3 + 2] - center[2];
    if(y < -height*.16)continue;
    const lateral=Math.abs(x*side[0]+z*side[1]), forward=-x*side[1]+z*side[0];
    const reach=height*.135*smooth((forward/height-.079)/.021);
    const cheek=Math.min(height*.034,Math.max(0,forward-height*.02)*1.1)*smooth((y/height+.038)/.017);
    const level=y+reach+cheek, goal=smooth((level+below)/(below+above));
    let old=0,neckWeight=0,locked=0,lockedCount=0;
    for(let k=0;k<4;k++){
      const bone=part.indices[n*4+k], weight=part.weights[n*4+k];
      if(bone===head)old+=weight;
      else if(bone===neck)neckWeight+=weight;
      else if(weight>0&&descendants.has(bone)){locked+=weight;lockedCount++}
    }
    const followsHead=old+locked;
    // Weight ownership keeps raised arms and nearby clothing from joining the
    // head. Existing jaw/ear weights count as ownership and remain intact.
    const width=height*(.15+.10*smooth((followsHead-.25)/.55));
    const breadth=1-smooth((lateral-width)/(height*.065));
    const depth=1-smooth((Math.abs(forward)-height*.22)/(height*.10));
    if(goal>followsHead){
      const owned=smooth((followsHead+neckWeight-.12)/.24);
      const weight=old+(goal-followsHead)*strength*owned*breadth*depth;
      if(weight-old>1e-6&&(lockedCount<3||old>0||weight>=1-locked-1e-6))targets[n]=weight;
    }else if(old>0&&level<0){
      const neckMask=smooth(-level/below);
      const weight=old- Math.min(old,followsHead-goal)*strength*neckMask*breadth*depth;
      if(old-weight>1e-6&&(lockedCount<3||weight<1e-6))targets[n]=weight<1e-6?0:weight;
    }
  }
  return targets;
}

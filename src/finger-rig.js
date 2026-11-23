import {Matrix4, Quaternion, Vector3} from 'three';
import {canonicalBone, findCanonicalBone} from './animation-retarget.js';
import {inspectGlb} from './format.js';
import {jointGlb} from './joint-glb.js';
import {openSkinDocument, skinEditEligibility} from './skin-document.js';
import {boneWeight} from './skin-weights.js';

export const DIGITS=[['Thumb','Большой'],['Index','Указательный'],['Middle','Средний'],['Ring','Безымянный'],['Pinky','Мизинец']];
export const HANDS=[['left','Левая кисть'],['right','Правая кисть']];
const vector=xyz=>new Vector3().fromArray(xyz);
const up=new Vector3(0,1,0), front=new Vector3(0,0,1);
const unitScale=new Vector3(1,1,1);
const cap=side=>side[0].toUpperCase()+side.slice(1);
const smooth=value=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t)};
const quantile=(values,fallback,at=.5)=>values.length?values.sort((a,b)=>a-b)[Math.round(at*(values.length-1))]:fallback;

function handBones(bones,side) {
  return [findCanonicalBone(bones,side+'hand'),findCanonicalBone(bones,side+'forearm')];
}

function hasDigit(nodes,side,name) {
  const role=side+'hand'+name.toLowerCase();
  return nodes.some(({name})=>name&&[1,2,3].some(i=>canonicalBone(name)===role+i));
}

export function fingerRigEligibility(bytes) {
  const check=skinEditEligibility(bytes);
  if (!check.eligible) return check;
  const json=inspectGlb(bytes).json, bones=json.skins[0].joints.map(i=>json.nodes[i]||{});
  if (bones.length>253) return {eligible:false,reason:'В скелете уже занято больше 253 мест из 256.'};
  const available=HANDS.some(([side])=>handBones(bones,side).every(Boolean)&&
    DIGITS.some(([name])=>!hasDigit(json.nodes,side,name)));
  return available?{eligible:true,reason:''}:{eligible:false,reason:'Нужны кости предплечья и кисти со свободными цепочками пальцев.'};
}

function frameForHand(doc,side) {
  const [hand,elbow]=handBones(doc.bones,side);
  if (!hand||!elbow) return null;
  const wrist=vector(hand.position), along=wrist.clone().sub(vector(elbow.position));
  const forearm=along.length();
  if (forearm<doc.height*.008) return null;
  along.normalize();
  const all=[], point=new Vector3(), relative=new Vector3();
  for (const part of doc.parts) for (let n=0;n<part.positions.length/3;n++) {
    if (boneWeight(part,n,hand.id)<.25) continue;
    relative.copy(point.fromArray(part.positions,n*3)).sub(wrist);
    const t=relative.dot(along);
    if (t>=0&&relative.lengthSq()<forearm*forearm*1.21) all.push({t,offset:relative.clone()});
  }
  if (all.length<6) return null;
  const length=quantile(all.map(p=>p.t),0,.99);
  if (length<doc.height*.022) return null;
  const a=(Math.abs(along.dot(front))<.85?front:up).clone();
  a.addScaledVector(along,-a.dot(along)).normalize();
  const b=along.clone().cross(a).normalize();
  // Estimate the spread from the plane across the palm rather than assuming
  // every model was exported with the same wrist roll.
  const palm=all.filter(p=>p.t>length*.23&&p.t<length*.82);
  let aa=0,bb=0,ab=0,meanA=0,meanB=0;
  for (const {offset} of palm) {
    const x=offset.dot(a),y=offset.dot(b);
    aa+=x*x;bb+=y*y;ab+=x*y;meanA+=x;meanB+=y;
  }
  if (palm.length) {
    aa-=meanA*meanA/palm.length;bb-=meanB*meanB/palm.length;ab-=meanA*meanB/palm.length;
  }
  const angle=.5*Math.atan2(2*ab,aa-bb);
  const spread=a.clone().multiplyScalar(Math.cos(angle)).addScaledVector(b,Math.sin(angle)).normalize();
  const palmDown=spread.clone().cross(along).normalize();
  if (Math.abs(palmDown.dot(up))>.15?palmDown.dot(up)>0:palmDown.dot(front)>0) palmDown.negate();
  for (const p of all) {p.across=p.offset.dot(spread);p.depth=p.offset.dot(palmDown)}
  return {wrist,along,spread,palmDown,all,length,forearm};
}

export function draftFingerRig(bytes,{memoryBudgetMiB=384}={}) {
  const eligible=fingerRigEligibility(bytes);
  if (!eligible.eligible) throw Error(eligible.reason);
  const doc=openSkinDocument(bytes,{memoryBudgetMiB}), draft={height:doc.height,hands:{}};
  const at=(frame,t,x,y)=>frame.wrist.clone().addScaledVector(frame.along,t)
    .addScaledVector(frame.spread,x).addScaledVector(frame.palmDown,y);
  for (const [side] of HANDS) {
    const frame=frameForHand(doc,side);
    if (!frame) continue;
    const {all,length,forearm,wrist,along,spread,palmDown}=frame;
    const handSpan=all.filter(p=>p.t>=length*.25), spreadSamples=handSpan.map(p=>p.across);
    const low=quantile(spreadSamples.slice(),-length*.23,.06), high=quantile(spreadSamples,length*.23,.94);
    const width=Math.max(length*.21,high-low), center=(low+high)*.5;
    const palmDepth=quantile(all.filter(p=>p.t>=length*.22&&p.t<=length*.63).map(p=>p.depth),0);
    const fingers={};
    for (const [i,[name]] of DIGITS.entries()) {
      const thumb=i===0, lane=center+width*[.55,.31,.08,-.15,-.39][i];
      const baseT=length*[.24,.51,.55,.52,.46][i], endGuess=length*[.65,.94,1,.93,.8][i];
      const laneSamples=all.filter(p=>Math.abs(p.across-lane)<width*.21&&p.t>=baseT+length*.13&&(!thumb||p.t<length*.84));
      const tipT=quantile(laneSamples.map(p=>p.t),endGuess,.93);
      const tipBand=laneSamples.filter(p=>p.t>tipT-length*.095);
      const end=at(frame,tipT,quantile(tipBand.map(p=>p.across),lane),quantile(tipBand.map(p=>p.depth),palmDepth));
      const start=at(frame,baseT,thumb?center+width*.35:lane*.91+center*.09,palmDepth);
      const existing=hasDigit(doc.j.nodes,side,name);
      fingers[name]={enabled:!existing,existing,radius:.10,points:[start,start.clone().lerp(end,.46),start.clone().lerp(end,.75),end].map(p=>p.toArray())};
    }
    draft.hands[side]={wrist:wrist.toArray(),along:along.toArray(),spread:spread.toArray(),palmDown:palmDown.toArray(),length,forearm,fingers};
  }
  if (!Object.values(draft.hands).some(h=>Object.values(h.fingers).some(f=>f.enabled)))
    throw Error('Не удалось найти поверхность кистей в исходной позе.');
  return draft;
}

function chainPoints(guide,doc,hand,limit,name) {
  const points=guide.points;
  if (!Array.isArray(points)||points.length!==4||points.some(p=>!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite)))
    throw Error('Проверь четыре точки пальца '+name);
  const positions=points.map(vector), wrist=vector(hand.position);
  if (positions.some(v=>v.distanceTo(wrist)>limit))
    throw Error('Точка пальца слишком далеко от кисти: '+name);
  const length=positions.slice(1).map((v,i)=>v.distanceTo(positions[i]));
  if (length.some(x=>x<doc.height*.001)) throw Error('Разнеси точки фаланг пальца '+name);
  return {positions,length};
}

function addChain(glb,doc,hand,side,name,guide,frame,inverses) {
  const {positions,length}=chainPoints(guide,doc,hand,frame.forearm*1.3,name);
  const {json}=glb, skin=json.skins[0], handWorld=doc.world[hand.node];
  const worldToHand=handWorld.clone().invert(), local=positions.map(v=>v.clone().applyMatrix4(worldToHand));
  const normal=vector(frame.palmDown).transformDirection(worldToHand);
  const bindOfHand=handWorld.clone().multiply(new Matrix4().fromArray(doc.ibm,hand.id*16));
  const chain={name:cap(side)+' '+name, hand:hand.id, bones:[], segments:[], used:[0,0,0],
    radius:frame.length*Math.min(.29,Math.max(.025,Number(guide.radius)||.1)),length};
  let parent=hand.node, parentRest=new Matrix4();
  for (let j=0;j<3;j++) {
    const y=local[j+1].clone().sub(local[j]).normalize();
    const z=normal.clone().addScaledVector(y,-normal.dot(y));
    if (z.lengthSq()<1e-6) z.copy(Math.abs(y.dot(up))<.9?up:front).addScaledVector(y,-z.dot(y));
    z.normalize();
    const x=y.clone().cross(z).normalize(), q=new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x,y,z));
    const rest=new Matrix4().compose(local[j],q,unitScale);
    const relative=parentRest.clone().invert().multiply(rest);
    const translation=new Vector3(), rotation=new Quaternion(), scale=new Vector3();
    relative.decompose(translation,rotation,scale);
    const index=json.nodes.length, bone=skin.joints.length;
    json.nodes.push({name:'mixamorig'+cap(side)+'Hand'+name+(j+1),translation:translation.toArray(),rotation:rotation.normalize().toArray()});
    (json.nodes[parent].children??=[]).push(index);skin.joints.push(index);
    const inverse=handWorld.clone().multiply(rest).invert().multiply(bindOfHand);
    inverses.set(inverse.elements,bone*16);
    chain.bones.push(bone);
    const axis=positions[j+1].clone().sub(positions[j]).multiplyScalar(1/length[j]);
    chain.segments.push({origin:positions[j],axis,length:length[j]});
    parent=index;parentRest=rest;
  }
  return chain;
}

function distributeToFingers(part,chains) {
  const point=new Vector3(), offset=new Vector3(), slots=[], source=part.indices, weights=part.weights;
  let changed=0;
  for (let i=0;i<part.positions.length/3;i++) {
    point.fromArray(part.positions,i*3);
    let best=null, bestScore=1.45, handWeight=0, segment=0, at=0;
    for (const chain of chains) {
      const mass=boneWeight(part,i,chain.hand);
      if (mass<.05) continue;
      const first=chain.segments[0];
      if (offset.copy(point).sub(first.origin).dot(first.axis)<-first.length*.17) continue;
      for (const [j,s] of chain.segments.entries()) {
        const v=offset.copy(point).sub(s.origin), t=v.dot(s.axis), u=Math.max(0,Math.min(t,s.length));
        const score=v.addScaledVector(s.axis,-u).length()/chain.radius;
        if (score>=bestScore) continue;
        best=chain;bestScore=score;handWeight=mass;segment=j;at=t/s.length;
      }
    }
    if (!best) continue;
    const alpha=smooth((1.45-bestScore)/.63);
    const start=segment===0?smooth((at+.17)/.34):1;
    const moved=alpha*start;
    if (moved<.005) continue;
    const localWeights=[[best.hand,1-moved]];
    let other=-1, blend=0;
    if (segment>0&&at<.29) {other=segment-1;blend=.5*(1-smooth(at/.29))}
    else if (segment<2&&at>.71) {other=segment+1;blend=.5*smooth((at-.71)/.29)}
    localWeights.push([best.bones[segment],moved*(1-blend)]);
    if (other>=0) localWeights.push([best.bones[other],moved*blend]);
    slots.length=0;
    const v=i*4;
    for (let k=0;k<4;k++) if (weights[v+k]>0&&source[v+k]!==best.hand) slots.push([source[v+k],weights[v+k]]);
    const retained=localWeights.filter(([,w])=>w>1e-9).sort((a,b)=>b[1]-a[1]).slice(0,4-slots.length);
    if (!retained.some(([bone])=>bone!==best.hand)) continue;
    const sum=retained.reduce((s,[,w])=>s+w,0);
    for (const [bone,w] of retained) {
      const value=w*handWeight/sum;
      slots.push([bone,value]);
      if (bone!==best.hand&&value>.015) best.used[best.bones.indexOf(bone)]++;
    }
    for (let k=0;k<4;k++) {source[v+k]=slots[k]?.[0]??0;weights[v+k]=slots[k]?.[1]??0}
    changed++;
  }
  return changed;
}

export function buildFingerRig(bytes,{draft,memoryBudgetMiB=384,onProgress=()=>{}}={}) {
  const eligible=fingerRigEligibility(bytes);
  if (!eligible.eligible) throw Error(eligible.reason);
  const doc=openSkinDocument(bytes,{memoryBudgetMiB});
  const glb=jointGlb(bytes), {json}=glb;
  const selected=[];
  for (const [side] of HANDS) {
    const frame=draft?.hands?.[side], [hand,elbow]=handBones(doc.bones,side);
    if (!frame||!hand||!elbow) continue;
    const forearm=vector(hand.position).distanceTo(vector(elbow.position));
    if (!Number.isFinite(frame.length)||frame.length<doc.height*.01||frame.length>forearm*1.3||
        !Array.isArray(frame.palmDown)||frame.palmDown.length!==3||!frame.palmDown.every(Number.isFinite))
      throw Error('Некорректный черновик кисти');
    for (const [name] of DIGITS) {
      const guide=frame.fingers?.[name];
      if (!guide?.enabled) continue;
      if (hasDigit(json.nodes,side,name)) throw Error('Этот палец уже есть в скелете: '+name);
      selected.push({hand,side,name,guide,frame:{...frame,forearm}});
    }
  }
  if (!selected.length) throw Error('Отметь хотя бы один палец');
  const total=doc.bones.length+selected.length*3;
  if (total>256) throw Error('Слишком много костей. В редакторе весов доступно до 256.');
  onProgress(20,'Добавляем фаланги к кистям…');
  const inverses=new Float32Array(total*16);
  inverses.set(doc.ibm);
  const chains=selected.map(item=>addChain(glb,doc,item.hand,item.side,item.name,item.guide,item.frame,inverses));
  let vertices=0;
  for (const [i,part] of doc.parts.entries()) {
    const count=distributeToFingers(part,chains);
    if (count) {
      const attrs=json.meshes[json.nodes[part.node].mesh].primitives[part.primitive].attributes;
      attrs.JOINTS_0=glb.append(part.indices,4);
      attrs.WEIGHTS_0=glb.append(part.weights,4);
      vertices+=count;
    }
    onProgress(26+Math.round((i+1)/doc.parts.length*58),'Распределяем веса по фалангам…');
  }
  for (const chain of chains) if (chain.used.some(count=>!count)) {
    const name=DIGITS.find(([key])=>chain.name.endsWith(' '+key))?.[1]||chain.name;
    throw Error('Не все фаланги получили веса. Уточни точки или радиус: '+name+' ('+(chain.name.startsWith('Left')?'левая':'правая')+' кисть).');
  }
  json.skins[0].inverseBindMatrices=glb.append(inverses,16);
  if (json.extras?.phoenixRig) json.extras.phoenixRig.joints=total;
  (json.extras??={}).phoenixFingers={profile:'localized-hand-weights',version:1};
  onProgress(92,'Записываем GLB с пальцами…');
  const output=glb.finish({memoryBudgetMiB});
  return {bytes:output,kind:'finger-rig',bones:total,added:selected.length*3,fingers:selected.length,vertices,
    beforeBytes:doc.bytes.length,afterBytes:output.length,sourceTriangles:doc.parts.reduce((sum,p)=>sum+p.triangles.length/3,0)};
}

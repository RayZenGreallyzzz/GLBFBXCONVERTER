import {MathUtils,Vector3} from 'three';
import {chainWeights} from './chain-weights.js';
import {tailRegion} from './detail-tail.js';
import {RIG_EXTRAS} from './rig-guides.js';

export function weightRigAppendages(part,spec,extras,height){
 const {positions,triangles,weights,indices}=part;
 const count=positions.length/3, selected=new Int8Array(count).fill(-1), strength=new Float32Array(count);
 const point=new Vector3(), delta=new Vector3(), near={};
 const chains=Object.entries(extras).map(([key,config])=>{
  const arm=spec.flatMap((bone,index)=>{
   if(bone.extra!==key)return [];
   const axis=bone.tail.clone().sub(bone.position),length=axis.length();
   return [{index,head:bone.position,axis:axis.normalize(),length}];
  });
  return {key,arm,radius:config.radius*height/100};
 });

 for(const [index,chain] of chains.entries()){
  const {key,arm,radius}=chain, first=arm[0];
  const tip=arm.at(-1), direction=tip.head.clone().addScaledVector(tip.axis,tip.length).sub(first.head).normalize();
  const tail=key==='tail'?tailRegion([{vertices:positions,indices:triangles}],arm,radius,(point,region)=>chainWeights(chain,point,region))[0]:null;
  const transition=Math.min(first.length*.64,radius*.48);
  for(let n=0;n<count;n++){
   let weight;
   if(tail)weight=tail[n];
   else{
    point.fromArray(positions,n*3);
    const ahead=delta.copy(point).sub(first.head).dot(direction);
    if(ahead<=0)continue;
    chainWeights(chain,point,near);
    if(near.distance>=radius)continue;
    const base=MathUtils.smoothstep(ahead,0,transition);
    weight=base*(1-MathUtils.smoothstep(near.distance,radius*.68,radius));
   }
   if(weight>Math.max(1e-5,strength[n])){strength[n]=weight;selected[n]=index}
  }
 }

 const affected=new Set();
 for(let n=0;n<count;n++){
  if(selected[n]<0)continue;
  const chain=chains[selected[n]], amount=strength[n], at=n*4;
  const additions=chainWeights(chain,point.fromArray(positions,n*3));
  const mixed=new Map();
  for(let k=0;k<4;k++){
   const id=indices[at+k],weight=weights[at+k]*(1-amount);
   if(weight>1e-8)mixed.set(id,(mixed.get(id)||0)+weight);
  }
  for(const [id,weight] of additions)if(weight>1e-8)mixed.set(id,(mixed.get(id)||0)+weight*amount);
  const top=[...mixed].sort((a,b)=>b[1]-a[1]).slice(0,4), total=top.reduce((sum,[,weight])=>sum+weight,0);
  for(let k=0;k<4;k++){
   const [id,weight]=top[k]||[0,0];indices[at+k]=id;weights[at+k]=weight/total;
   if(weight>1e-5)affected.add(id);
  }
 }
 for(const {key,arm} of chains)if(arm.some(bone=>!affected.has(bone.index)))
  throw Error(RIG_EXTRAS[key].label+' · одной из костей не хватило вершин. Уточни точки или увеличь радиус весов.');
}

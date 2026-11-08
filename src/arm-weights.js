// Refine only confidently identified arm surfaces. Keep geodesic separation
// from the torso/opposite arm, but confine joint blending to the joints.
const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*x*(x*(x*6-15)+10)};
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const unit=v=>{const n=Math.hypot(...v);if(!(n>1e-9))throw Error('Нулевая длина кости руки');return v.map(x=>x/n)};
export function localizeArmWeights(positions,inputIndices,inputWeights,joints){
 const count=positions.length/3;if(!Number.isSafeInteger(count)||inputIndices.length!==count*4||inputWeights.length!==count*4)throw Error('Не совпали размеры весов рук');
 const byName=new Map(joints.map((b,i)=>[b.name,i])),arms=[];
 for(const side of ['Left','Right']){
  const ids=Object.fromEntries(['Shoulder','Arm','ForeArm','Hand','HandEnd'].map(part=>[part,byName.get('mixamorig'+side+part)]));
  if(Object.values(ids).some(i=>i===undefined))throw Error('Для исправления нужен скелет тела Forge с костями кистей');
  const shoulder=joints[ids.Arm].position,elbow=joints[ids.ForeArm].position,wrist=joints[ids.Hand].position;
  const upper=sub(elbow,shoulder),lower=sub(wrist,elbow),upperLength=Math.hypot(...upper),lowerLength=Math.hypot(...lower),u=unit(upper),v=unit(lower),bisector=unit(u.map((x,i)=>x+v[i]));
  arms.push({ids,set:new Set(Object.values(ids)),shoulder,elbow,wrist,u,v,bisector,upperLength,lowerLength});
 }
 const skinIndices=new Uint16Array(inputIndices),skinWeights=new Float32Array(inputWeights);let changedVertices=0,maxDiscardedWeight=0;
 for(let n=0;n<count;n++){
  const at=n*4,p=[positions[n*3],positions[n*3+1],positions[n*3+2]];
  for(const arm of arms){
   let confidence=0;for(let k=0;k<4;k++)if(arm.set.has(inputIndices[at+k]))confidence+=inputWeights[at+k];
   const along=dot(sub(p,arm.shoulder),arm.u),alpha=smooth((confidence-.75)/.245)*smooth((along/arm.upperLength+.20)/.52);
   if(alpha<=1e-9)continue;
   const elbow=smooth((dot(sub(p,arm.elbow),arm.bisector)+arm.upperLength*.16)/(arm.upperLength*.16+arm.lowerLength*.21));
   const hand=smooth((dot(sub(p,arm.wrist),arm.v)+arm.lowerLength*.14)/(arm.lowerLength*.32));
   const values=new Map();for(let k=0;k<4;k++){const i=inputIndices[at+k];values.set(i,(values.get(i)||0)+inputWeights[at+k]*(1-alpha))}
   for(const [i,w]of [[arm.ids.Arm,(1-elbow)*(1-hand)],[arm.ids.ForeArm,elbow*(1-hand)],[arm.ids.Hand,hand]])values.set(i,(values.get(i)||0)+alpha*w);
   const sorted=[...values].filter(([,w])=>w>1e-12).sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
   const discarded=sorted.slice(4).reduce((s,x)=>s+x[1],0);maxDiscardedWeight=Math.max(maxDiscardedWeight,discarded);const sum=sorted.slice(0,4).reduce((s,x)=>s+x[1],0);
   if(!(sum>0))throw Error('Пустые веса руки');let changed=false;
   // Compare by joint, not by the ordering of the four storage slots.
   for(const [i,w]of values){let before=0;for(let k=0;k<4;k++)if(inputIndices[at+k]===i)before+=inputWeights[at+k];if(Math.abs(w-before)>1e-7)changed=true}
   if(!changed)break;
   for(let k=0;k<4;k++){skinIndices[at+k]=sorted[k]?.[0]??0;skinWeights[at+k]=(sorted[k]?.[1]??0)/sum}changedVertices++;break;
  }
 }
 return {skinIndices,skinWeights,changedVertices,maxDiscardedWeight};
}

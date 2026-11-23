import {MathUtils, Vector3} from 'three';

// Weld the triangles beyond the base of the tail. UV seams can have several
// vertex records at the same position, so they must stay in the same region.
export function tailRegion(parts, arm, radius, nearest){
  const first=arm[0], last=arm.at(-1), tip=last.head.clone().addScaledVector(last.axis,last.length);
  const direction=tip.clone().sub(first.head), length=direction.length();
  if(Math.hypot(direction.x,direction.z)>length*.55)direction.y=0;
  if(direction.lengthSq()<1e-12)direction.copy(first.axis);
  direction.normalize();
  const gate=Math.min(radius*.45,first.length*.55), fade=Math.max(gate+radius*.65,first.length*.46);
  const extent=tip.clone().sub(first.head).dot(direction);
  const positionKeys=new Map(), roots=[], sizes=[];
  const point=new Vector3(), offset=new Vector3(), cell=Math.max(length*1e-6,1e-7);

  function root(id){
    while(id!==roots[id]){roots[id]=roots[roots[id]];id=roots[id]}
    return id;
  }
  function join(a,b){
    if(a<0||b<0)return;
    a=root(a);b=root(b);
    if(a===b)return;
    if(sizes[a]<sizes[b])[a,b]=[b,a];
    roots[b]=a;sizes[a]+=sizes[b];
  }

  const records=parts.map(({vertices,indices})=>{
    const count=vertices.length/3, ids=new Int32Array(count).fill(-1), along=new Float32Array(count);
    for(let i=0;i<count;i++){
      point.fromArray(vertices,i*3);
      along[i]=offset.copy(point).sub(first.head).dot(direction);
      if(along[i]<=gate)continue;
      const key=[point.x,point.y,point.z].map(value=>Math.round(value/cell)).join(',');
      let id=positionKeys.get(key);
      if(id===undefined){id=roots.length;roots.push(id);sizes.push(1);positionKeys.set(key,id)}
      ids[i]=id;
    }
    for(let i=0;i+2<(indices?.length??count);i+=3){
      const [a,b,c]=indices?[ids[indices[i]],ids[indices[i+1]],ids[indices[i+2]]]:[ids[i],ids[i+1],ids[i+2]];
      join(a??-1,b??-1);join(b??-1,c??-1);join(c??-1,a??-1);
    }
    return {vertices,ids,along};
  });
  const stats=new Map();
  const region={};
  for(const {vertices,ids,along} of records)for(let i=0;i<ids.length;i++){
    if(ids[i]<0)continue;
    const id=root(ids[i]);
    let group=stats.get(id);
    if(!group){group={hits:0,count:0,score:0,far:0};stats.set(id,group)}
    group.count++;
    nearest(point.fromArray(vertices,i*3),region);
    if(region.distance<=radius){
      group.hits++;
      group.score+=region.segment===0?.3:1;
    }
    const pastTip=along[i]>extent-radius*.25;
    const offAxis=offset.copy(point).sub(tip).addScaledVector(direction,extent-along[i]).length();
    if(pastTip&&offAxis<radius*1.55)group.far++;
  }
  let main=-1, best=0;
  for(const [id,group] of stats)if(group.score>best){main=id;best=group.score}
  return records.map(({ids,along})=>Float32Array.from(ids,(id,i)=>{
    if(id<0||main<0)return 0;
    id=root(id);
    const {hits,count,far}=stats.get(id);
    const selected=id===main||hits/count>=.65||far/count>=.65;
    return selected?MathUtils.smoothstep(along[i],gate,fade):0;
  }));
}

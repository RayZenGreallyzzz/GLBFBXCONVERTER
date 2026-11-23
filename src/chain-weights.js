export function chainWeights(detail,point,region){
  const {arm,index}=detail;
  if(!arm?.length)return [[index,1]];
  let best=0, at=0, distance=Infinity;
  for(const [i,b] of arm.entries()){
    const offset=point.clone().sub(b.head), t=offset.dot(b.axis);
    const d=offset.addScaledVector(b.axis,-Math.max(0,Math.min(b.length,t))).lengthSq();
    if(d<distance){distance=d;best=i;at=t/b.length}
  }
  if(region){region.distance=Math.sqrt(distance);region.projected=at;region.segment=best}
  const a=arm[best].index;
  if(best>0&&at<.22){
    const k=.5*(1-Math.min(.22,Math.max(0,at))/.22);
    return [[a,1-k],[arm[best-1].index,k]];
  }
  if(best+1<arm.length&&at>.78){
    const k=.5*(Math.min(1,at)-.78)/.22;
    return [[a,1-k],[arm[best+1].index,k]];
  }
  return [[a,1]];
}

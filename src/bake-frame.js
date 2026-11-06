// Standard UV-gradient tangent basis with an explicit seam at the face edge.
// This handles a valid, needle-thin face whose corner angle rounds to zero in
// Mikk's Float32 angle-weighting. It never substitutes an unrelated direction.
export function faceTangents(p,n,uv){
 const e1=[p[3]-p[0],p[4]-p[1],p[5]-p[2]],e2=[p[6]-p[0],p[7]-p[1],p[8]-p[2]],du1=uv[2]-uv[0],dv1=uv[3]-uv[1],du2=uv[4]-uv[0],dv2=uv[5]-uv[1],det=du1*dv2-du2*dv1;
 if(!Number.isFinite(det)||Math.abs(det)<1e-20)throw Error('Вырожденная UV-грань');
 const t=e1.map((v,k)=>(v*dv2-e2[k]*dv1)/det),b=e2.map((v,k)=>(v*du1-e1[k]*du2)/det),out=new Float32Array(12);
 for(let i=0;i<3;i++){
  const normal=Array.from(n.subarray(i*3,i*3+3)),nl=Math.hypot(...normal);if(!(nl>0))throw Error('Вырожденная нормаль');for(let k=0;k<3;k++)normal[k]/=nl;
  const dot=t.reduce((v,x,k)=>v+x*normal[k],0),tangent=t.map((v,k)=>v-dot*normal[k]),length=Math.hypot(...tangent);if(!(length>0)||!Number.isFinite(length))throw Error('Вырожденная касательная');for(let k=0;k<3;k++)tangent[k]/=length;
  const cross=[normal[1]*tangent[2]-normal[2]*tangent[1],normal[2]*tangent[0]-normal[0]*tangent[2],normal[0]*tangent[1]-normal[1]*tangent[0]],orientation=cross.reduce((v,x,k)=>v+x*b[k],0);if(!Number.isFinite(orientation)||orientation===0)throw Error('Вырожденный базис');
  out.set([...tangent,orientation<0?-1:1],i*4);
 }
 return out;
}

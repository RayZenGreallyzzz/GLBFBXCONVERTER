import {MeshBVH,CENTER} from 'three-mesh-bvh';
import {Vector3} from 'three';
import {chunkedBakeHits} from './bake-hits.js';
import {valueAt} from './bake-packed.js';
import {createBakeProjector,sampleBakeTarget,surfaceBarycentric} from './bake-projection.js';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const linear=x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
const srgb=x=>x<=.0031308?x*12.92:1.055*x**(1/2.4)-.055;
const colorLut=Float64Array.from({length:256},(_,i)=>linear(i/255));
export function transformUV(info,u,v){
 const e=info?.getExtension('KHR_texture_transform'),scale=e?.getScale()||[1,1],offset=e?.getOffset()||[0,0],angle=e?.getRotation()||0,c=Math.cos(angle),s=Math.sin(angle);
 return [c*scale[0]*u-s*scale[1]*v+offset[0],s*scale[0]*u+c*scale[1]*v+offset[1]];
}
function wrapPixel(i,n,mode){
 if(mode===33071)return clamp(i,0,n-1);
 if(mode===33648){i=((i%(n*2))+n*2)%(n*2);return i<n?i:2*n-1-i;}
 return ((i%n)+n)%n;
}
export function sampleMap(map,u,v,color=false){
 const {width:w,height:h,data,wrapS=10497,wrapT=10497}=map;
 const x=u*w-.5,y=v*h-.5,x0=Math.floor(x),y0=Math.floor(y),fx=x-x0,fy=y-y0,result=[0,0,0,0];
 for(let j=0;j<2;j++)for(let i=0;i<2;i++){
  const index=(wrapPixel(y0+j,h,wrapT)*w+wrapPixel(x0+i,w,wrapS))*4,weight=(i?fx:1-fx)*(j?fy:1-fy);
  for(let k=0;k<4;k++)result[k]+=(color&&k<3?colorLut[data[index+k]]:data[index+k]/255)*weight;
 }
 if(color)for(let k=0;k<3;k++)result[k]=srgb(result[k]);return result;
}
const put3=(a,i,out)=>out.set(valueAt(a,i*3),valueAt(a,i*3+1),valueAt(a,i*3+2));
function interpolate3(a,i,j,k,w,out){return out.set(valueAt(a,i*3)*w.x+valueAt(a,j*3)*w.y+valueAt(a,k*3)*w.z,valueAt(a,i*3+1)*w.x+valueAt(a,j*3+1)*w.y+valueAt(a,k*3+1)*w.z,valueAt(a,i*3+2)*w.x+valueAt(a,j*3+2)*w.y+valueAt(a,k*3+2)*w.z)}
export function padBakeMaps(maps,mask,size,padding){
 const count=size*size,queue=new Uint32Array(count),distance=new Uint8Array(count);distance.fill(255);let end=0;
 for(let p=0;p<count;p++)if(mask[p]){
  distance[p]=0;const x=p%size,y=Math.floor(p/size);
  if(x>0&&!mask[p-1]||x<size-1&&!mask[p+1]||y>0&&!mask[p-size]||y<size-1&&!mask[p+size])queue[end++]=p;
 }
 for(let head=0;head<end;head++){
  const p=queue[head],d=distance[p];if(d>=padding)continue;const x=p%size,y=Math.floor(p/size);
  for(const q of [x?p-1:-1,x<size-1?p+1:-1,y?p-size:-1,y<size-1?p+size:-1]){
   if(q<0||distance[q]!==255)continue;distance[q]=d+1;queue[end++]=q;
   for(const map of Object.values(maps))for(let k=0;k<4;k++)map[q*4+k]=map[p*4+k];
  }
 }
}
export function projectBakePixels(source,target,{size=1024,maps={},normalScale=1,projectionDistance=.04,onProgress=()=>{},maxMissRate=.005}={}){
 const geometry=source.geometry;geometry?.computeBoundingBox();
 const extent=geometry?.boundingBox.getSize(new Vector3()),scale=source.bounds?.extent??Math.max(extent.x,extent.y,extent.z);
 if(!(scale>0))throw Error('Пустые границы исходной сетки');
 const distance=scale*projectionDistance,epsilon=scale*1e-7;
 const hits=source.packed?chunkedBakeHits(source,target,{size,distance,epsilon,onProgress:p=>onProgress(p*.6,{coverage:0,projected:0,misses:0})}):null;
 const bvh=hits?null:new MeshBVH(geometry,{strategy:CENTER,targetLeafSize:16,indirect:true});
 const projector=bvh?createBakeProjector(source,bvh,{distance,epsilon}):null;
 const output={base:new Uint8ClampedArray(size*size*4),normal:new Uint8ClampedArray(size*size*4),orm:new Uint8ClampedArray(size*size*4)};
 if(maps.emissive)output.emissive=new Uint8ClampedArray(size*size*4);
 const covered=new Uint8Array(size*size),valid=new Uint8Array(size*size);
 const point=new Vector3(),lowN=new Vector3(),cageN=new Vector3(),lowT=new Vector3(),lowB=new Vector3();
 const highN=new Vector3(),highT=new Vector3(),highB=new Vector3(),cross=new Vector3(),sampleN=new Vector3(),weights=new Vector3();
 const a=new Vector3(),b=new Vector3(),c=new Vector3(),e1=new Vector3(),e2=new Vector3(),highIds=new Uint32Array(3);
 const sourceIndex=source.indices,pos=source.positions;let coverage=0,misses=0,projected=0,normalPixels=0;
 function face(index,p,barycentric){
  const ia=sourceIndex[index*3],ib=sourceIndex[index*3+1],ic=sourceIndex[index*3+2];
  put3(pos,ia,a);put3(pos,ib,b);put3(pos,ic,c);if(barycentric)weights.copy(barycentric);else if(!surfaceBarycentric(p,a,b,c,weights))throw Error('Вырожденная грань исходника при переносе');
  interpolate3(source.normals,ia,ib,ic,weights,highN).normalize();highIds[0]=ia;highIds[1]=ib;highIds[2]=ic;return highIds;
 }
 function uvAt(map,ids){
  const values=source.uv[map.coord];if(!values)throw Error('Текстура ссылается на отсутствующий UV-канал '+map.coord);
  let u=0,v=0;for(let k=0;k<3;k++){const w=weights.getComponent(k);u+=valueAt(values,ids[k]*2)*w;v+=valueAt(values,ids[k]*2+1)*w;}
  const [m0,m1,m2,m3,m4,m5]=map.matrix;return [m0*u+m2*v+m4,m1*u+m3*v+m5];
 }
 function sample(map,ids,color=false){const uv=uvAt(map,ids);return sampleMap(map,uv[0],uv[1],color)}
 const total=target.indices.length/3;
 for(let tri=0;tri<total;tri++){
  if(tri%Math.max(1,Math.floor(total/100))===0)onProgress(hits ? .6+.4*tri/total : tri/total,{coverage,projected,misses});
  const ids=[target.indices[tri*3],target.indices[tri*3+1],target.indices[tri*3+2]],us=ids.map(i=>target.uv[i*2]*size),vs=ids.map(i=>target.uv[i*2+1]*size);
  const den=(vs[1]-vs[2])*(us[0]-us[2])+(us[2]-us[1])*(vs[0]-vs[2]);if(Math.abs(den)<1e-12)continue;
  const minX=clamp(Math.ceil(Math.min(...us)-.5),0,size-1),maxX=clamp(Math.floor(Math.max(...us)-.5),0,size-1),minY=clamp(Math.ceil(Math.min(...vs)-.5),0,size-1),maxY=clamp(Math.floor(Math.max(...vs)-.5),0,size-1);
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
   const u=x+.5,v=y+.5,w0=((vs[1]-vs[2])*(u-us[2])+(us[2]-us[1])*(v-vs[2]))/den,w1=((vs[2]-vs[0])*(u-us[2])+(us[0]-us[2])*(v-vs[2]))/den,w2=1-w0-w1;
   if(Math.min(w0,w1,w2)<-1e-7)continue;const pixel=y*size+x;if(valid[pixel]||hits&&!hits.matches(pixel,tri))continue;
   if(!covered[pixel]){covered[pixel]=1;coverage++;}
   weights.set(w0,w1,w2);interpolate3(target.normals,...ids,weights,lowN).normalize();
   sampleBakeTarget(target,ids,w1,w2,point,cageN);
   const best=hits?hits.hit(pixel):projector.project(point,cageN);
   if(!best)continue;const hi=face(best.faceIndex,best.point,best.barycentric),base=maps.base?sample(maps.base,hi,true):[1,1,1,1];
   if(source.colors)for(let k=0;k<source.colorSize;k++){
    let color=0;for(let j=0;j<3;j++)color+=valueAt(source.colors,hi[j]*source.colorSize+k)*weights.getComponent(j);base[k]=k<3?srgb(linear(base[k])*color):base[k]*color;
   }
   const orm=maps.orm?sample(maps.orm,hi):[1,1,1,1];orm[0]=maps.occlusion?sample(maps.occlusion,hi)[0]:1;
   if(maps.normal){
    const normal=sample(maps.normal,hi);
    if(source.tangents){
     const t=source.tangents;highT.set(0,0,0);let sign=0;
     for(let k=0;k<3;k++){const i=hi[k]*4,w=weights.getComponent(k);highT.x+=valueAt(t,i)*w;highT.y+=valueAt(t,i+1)*w;highT.z+=valueAt(t,i+2)*w;sign+=valueAt(t,i+3)*w;}
     highT.addScaledVector(highN,-highT.dot(highN)).normalize();highB.crossVectors(highN,highT).multiplyScalar(sign<0?-1:1);
    }else{
     const map=maps.normal,coords=source.uv[map.coord],m=map.matrix,du1=valueAt(coords,hi[1]*2)-valueAt(coords,hi[0]*2),dv1=valueAt(coords,hi[1]*2+1)-valueAt(coords,hi[0]*2+1),du2=valueAt(coords,hi[2]*2)-valueAt(coords,hi[0]*2),dv2=valueAt(coords,hi[2]*2+1)-valueAt(coords,hi[0]*2+1);
     const u1=m[0]*du1+m[2]*dv1,v1=m[1]*du1+m[3]*dv1,u2=m[0]*du2+m[2]*dv2,v2=m[1]*du2+m[3]*dv2,det=u1*v2-u2*v1;e1.subVectors(b,a);e2.subVectors(c,a);
     if(Math.abs(det)>1e-15){
      highT.copy(e1).multiplyScalar(v2).addScaledVector(e2,-v1).multiplyScalar(1/det);highB.copy(e2).multiplyScalar(u1).addScaledVector(e1,-u2).multiplyScalar(1/det);
      highT.addScaledVector(highN,-highT.dot(highN)).normalize();const sign=cross.crossVectors(highN,highT).dot(highB)<0?-1:1;highB.crossVectors(highN,highT).multiplyScalar(sign);
     }else{highT.set(0,0,0);highB.set(0,0,0);}
    }
    sampleN.copy(highN).multiplyScalar(normal[2]*2-1).addScaledVector(highT,(normal[0]*2-1)*normalScale).addScaledVector(highB,(normal[1]*2-1)*normalScale).normalize();
   }else sampleN.copy(highN);
   weights.set(w0,w1,w2);lowT.set(0,0,0);let sign=0;
   for(let k=0;k<3;k++){const i=ids[k]*4,w=weights.getComponent(k),t=target.tangents;lowT.x+=t[i]*w;lowT.y+=t[i+1]*w;lowT.z+=t[i+2]*w;sign+=t[i+3]*w;}
   lowT.addScaledVector(lowN,-lowT.dot(lowN)).normalize();lowB.crossVectors(lowN,lowT).multiplyScalar(sign<0?-1:1);
   const normal=[sampleN.dot(lowT)*.5+.5,sampleN.dot(lowB)*.5+.5,sampleN.dot(lowN)*.5+.5,1];if(!normal.every(Number.isFinite))continue;
   for(const [name,value]of [['base',base],['normal',normal],['orm',orm]])for(let k=0;k<4;k++)output[name][pixel*4+k]=Math.round(clamp(value[k],0,1)*255);
   if(output.emissive){face(best.faceIndex,best.point,best.barycentric);const color=sample(maps.emissive,hi,true);for(let k=0;k<4;k++)output.emissive[pixel*4+k]=Math.round(clamp(color[k],0,1)*255);}
   valid[pixel]=1;projected++;if(maps.normal)normalPixels++;
  }
 }
 misses=coverage-projected;
 if(!coverage||misses/coverage>maxMissRate)throw Error('Не перенесено '+(coverage?100*misses/coverage:100).toFixed(2)+'% поверхности. Сохрани больше треугольников или выбери более точное сохранение формы.');
 if(misses)throw Error('Осталось неперенесённых пикселей: '+misses+'. Выбери более точное сохранение формы.');
 padBakeMaps(output,valid,size,target.margin);return {maps:output,mask:valid,coverage,projected,misses,normalPixels};
}

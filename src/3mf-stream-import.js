// Memory-conscious importer for large Phoenix Model Forge 3MF packages.
// The standard ThreeMFLoader expands the entire 270MB+ XML into a DOM, which
// exhausts Android WebViews on ~2m-triangle characters. This path parses ZIP
// and XML incrementally into compact typed arrays. Small/complex 3MF packages
// continue using the standard ThreeMFLoader.
import * as THREE from 'three';
import {Unzip,UnzipInflate} from 'fflate';

class Grow {
 constructor(Type,capacity){this.Type=Type;this.array=new Type(capacity);this.count=0;}
 ensure(amount){
  if(this.count+amount<=this.array.length)return;
  let size=this.array.length||1024;
  while(size<this.count+amount)size=Math.max(size+1024,Math.ceil(size*1.55));
  const next=new this.Type(size);next.set(this.array.subarray(0,this.count));this.array=next;
 }
 add3(a,b,c){this.ensure(3);const i=this.count;this.array[i]=a;this.array[i+1]=b;this.array[i+2]=c;this.count+=3;}
 add2(a,b){this.ensure(2);const i=this.count;this.array[i]=a;this.array[i+1]=b;this.count+=2;}
 view(){return this.array.subarray(0,this.count)}
}
const attr=(tag,name)=>{
 const m=tag.match(new RegExp('(?:\\s|^)'+name+'="([^"]*)"'));
 return m?.[1];
};
const number=(tag,name)=>{
 const v=Number(attr(tag,name));
 if(!Number.isFinite(v))throw Error('3MF: отсутствует или некорректен атрибут '+name);
 return v;
};
function copyBytes(parts){
 const total=parts.reduce((n,p)=>n+p.byteLength,0),out=new Uint8Array(total);
 let offset=0;for(const part of parts){out.set(part,offset);offset+=part.byteLength;}
 return out;
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

export async function importLarge3mf(buffer,{onProgress=null}={}){
 const source=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);
 if(source.byteLength<22||source[0]!==80||source[1]!==75)
  throw Error('Некорректный ZIP-контейнер 3MF');
 const vertices=new Grow(Float32Array,100000),uv=new Grow(Float32Array,75000),
  faces=new Grow(Uint32Array,130000);
 const texturePaths=new Map(),textureGroups=new Map(),images=new Map(),items=[];
 let activeGroup=null,currentObject=null,activeMesh=false,insideVertices=false,insideTriangles=false;
 let totalMeshes=0,vertexOffset=0,hasModel=false,complete=false,failure=null;
 let carry='',totalDecoded=0,reported=0;
 const decoder=new TextDecoder('utf-8');
 const objects=[];
 function processTag(tag){
  const isClose=tag[1]==='/';
  const name=(tag.match(/^<\/?([\w:-]+)/)||[])[1]?.split(':').pop();
  if(!name||tag.startsWith('<?')||tag.startsWith('<!--'))return;
  if(isClose){
   if(name==='texture2dgroup')activeGroup=null;
   else if(name==='vertices')insideVertices=false;
   else if(name==='triangles')insideTriangles=false;
   else if(name==='mesh')activeMesh=false;
   else if(name==='object'&&currentObject){
    currentObject.vend=vertices.count/3;
    currentObject.iend=faces.count;
    objects.push(currentObject);
    currentObject=null;
   }
   return;
  }
  switch(name){
   case 'model':
    hasModel=true;break;
   case 'texture2d':{
    const id=number(tag,'id'),path=attr(tag,'path');
    if(!path)throw Error('3MF: текстура без пути');
    texturePaths.set(id,path.replace(/^\//,''));break;
   }
   case 'texture2dgroup':{
    const id=number(tag,'id'),texid=number(tag,'texid');
    const group={id,texid,coords:new Grow(Float32Array,100000)};
    textureGroups.set(id,group);activeGroup=group;break;
   }
   case 'tex2coord':
    if(activeGroup)activeGroup.coords.add2(number(tag,'u'),number(tag,'v'));
    break;
   case 'object':
    if(currentObject)throw Error('3MF: вложенные объекты не поддерживаются');
    currentObject={id:number(tag,'id'),name:attr(tag,'name')||'3MF Object',
      vstart:vertices.count/3,istart:faces.count,vend:0,iend:0,group:null};
    break;
   case 'mesh':activeMesh=true;totalMeshes++;break;
   case 'vertices':insideVertices=true;break;
   case 'triangles':insideTriangles=true;break;
   case 'vertex':
    if(!activeMesh||!insideVertices||!currentObject)return;
    // 3MF is Z-up millimetres; preview/GLB uses Three.js Y-up metres.
    vertices.add3(number(tag,'x')/1000,number(tag,'z')/1000,-number(tag,'y')/1000);
    break;
   case 'triangle':
    if(!activeMesh||!insideTriangles||!currentObject)return;
    const a=number(tag,'v1'),b=number(tag,'v2'),c=number(tag,'v3');
    if(![a,b,c].every(n=>Number.isInteger(n)&&n>=0))
     throw Error('3MF: неправильные индексы вершин');
    const group=attr(tag,'pid');
    if(currentObject.group===null)currentObject.group=group||'';
    if(currentObject.group!==(group||''))
     throw Error('3MF: сложные материалы треугольников требуют настольного импортёра');
    if(group&&textureGroups.has(Number(group))){
     // The Forge exporter writes UV p1/p2/p3 equal to vertex indices.
     const t1=number(tag,'p1'),t2=number(tag,'p2'),t3=number(tag,'p3');
     if(t1!==a||t2!==b||t3!==c)
      throw Error('3MF: независимые UV-индексы пока не поддерживаются в мобильном импортере');
    }
    faces.add3(currentObject.vstart+a,currentObject.vstart+b,currentObject.vstart+c);
    break;
   case 'item':
    items.push(number(tag,'objectid'));break;
  }
 }
 function feedXml(data,final=false){
  const incoming=decoder.decode(data,{stream:!final});
  const value=carry+incoming;
  let begin=0,end;
  while((end=value.indexOf('>',begin))!==-1){
   const start=value.indexOf('<',begin);
   if(start===-1||start>end){begin=end+1;continue;}
   processTag(value.slice(start,end+1));
   begin=end+1;
  }
  carry=value.slice(begin);
  if(carry.length>50000)throw Error('3MF: некорректный XML или слишком длинный тег');
  totalDecoded+=data.byteLength;
 }
 const unzip=new Unzip();
 unzip.register(UnzipInflate);
 unzip.onfile=file=>{
  const name=file.name.replace(/^\//,'');
  if(name==='3D/3dmodel.model'){
   if(complete)throw Error('3MF: повторяющийся XML модели');
   const originalSize=file.originalSize;
   if(originalSize>1100*1048576)throw Error('3MF: XML больше 1.1 ГБ — недостаточно памяти Android');
   file.ondata=(err,chunk,final)=>{
    if(err){failure=err;return}
    if(failure)return;
    try{
     feedXml(chunk,final);
     if(final){complete=true;if(carry.trim())throw Error('3MF: незавершённый XML');}
    }catch(e){failure=e}
   };
   file.start();
  }else if((name.startsWith('3D/Textures/')||name.startsWith('3D/Texture/')) &&
    ['.png','.jpg','.jpeg'].some(ext=>name.toLowerCase().endsWith(ext))){
   const chunks=[];
   file.ondata=(err,chunk,final)=>{
    if(err){failure=err;return}
    chunks.push(chunk);
    if(final)images.set(name,copyBytes(chunks));
   };
   file.start();
  }
 };
 // Only consume short compressed blocks per turn; not one huge inflate/DOM.
 for(let pos=0;pos<source.length;pos+=196608){
  unzip.push(source.subarray(pos,Math.min(pos+196608,source.length)),
    pos+196608>=source.length);
  if(failure)throw failure;
  if(onProgress&&pos-reported>source.length/55){
   reported=pos;onProgress(Math.round(90*pos/source.length));
  }
  if(pos%(196608*8)===0)await tick();
 }
 if(failure)throw failure;
 if(!complete||!hasModel)throw Error('3MF: отсутствует или не завершён XML модели');
 if(!objects.length||!faces.count)throw Error('3MF: модель не содержит треугольников');
 if(vertices.count/3>4_000_000||faces.count/3>8_000_000)
  throw Error('3MF: для просмотра такой модели на Android требуется оптимизация');
 const root=new THREE.Group(),texCache=new Map();
 for(const obj of objects){
  const count=obj.vend-obj.vstart;
  const offset=obj.istart,icount=obj.iend-obj.istart;
  if(icount===0)continue;
  const coords=vertices.view().subarray(obj.vstart*3,obj.vend*3);
  const local=faces.view().subarray(offset,obj.iend);
  // Retain source typed buffers only until slicing each object; avoid copying
  // the huge original XML, its node tree or the ZIP's uncompressed bytes.
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(coords.slice(),3));
  const localIdx=new Uint32Array(icount);
  for(let i=0;i<icount;i++){
   const v=local[i]-obj.vstart;
   if(v<0||v>=count)throw Error('3MF: треугольник ссылается на отсутствующую вершину');
   localIdx[i]=v;
  }
  geo.setIndex(new THREE.BufferAttribute(localIdx,1));
  let material=new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide});
  const group=textureGroups.get(Number(obj.group));
  if(group){
   if(group.coords.count!==count*2)
    throw Error('3MF: число UV не совпадает с числом вершин; требуется расширенный импортёр');
   geo.setAttribute('uv',new THREE.BufferAttribute(group.coords.view().slice(),2));
   const path=texturePaths.get(group.texid);
   const image=path&&images.get(path);
   if(image){
    if(!texCache.has(path)){
     if(typeof URL==='undefined'||typeof Blob==='undefined')
      throw Error('3MF: загрузка текстуры требует браузер');
     const type=/\.png$/i.test(path)?'image/png':'image/jpeg';
     const url=URL.createObjectURL(new Blob([image],{type}));
     try{
      const tex=await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace=THREE.SRGBColorSpace;
      tex.wrapS=THREE.RepeatWrapping;tex.wrapT=THREE.RepeatWrapping;
      texCache.set(path,tex);
     }finally{URL.revokeObjectURL(url)}
    }
    material.map=texCache.get(path);
    material.needsUpdate=true;
   }
  }
  // Computing normal vectors for two million triangles on the main thread
  // can take a long time; unlit preview keeps high-density meshes responsive.
  if(icount/3<120000){
   geo.computeVertexNormals();
   material=new THREE.MeshStandardMaterial({map:material.map||null,side:THREE.DoubleSide});
  }
  const mesh=new THREE.Mesh(geo,material);mesh.name=obj.name;
  root.add(mesh);
 }
 if(onProgress)onProgress(100);
 return {root,clips:[],notice:'3MF потоково загружен: '+
   (faces.count/3).toLocaleString('ru-RU')+' треугольников, '+texCache.size+
   ' текстур. Важный момент: файл печати не хранит риг или анимацию.'};
}

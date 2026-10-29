// Streaming 3MF importer for multi-million-triangle Android models.
// Avoids the ThreeMFLoader/DOMParser path for huge (200+ MB XML) archives.
// In particular, FoxGi_converted.3mf contains 1,015,827 vertices, 1,936,208
// triangles and ~275 MB of expanded XML. Parsing that as a DOM exhausts a
// 4 GB tablet, even though the compressed ZIP is only ~52 MB.
import * as THREE from 'three';
import {Unzip,UnzipInflate} from 'fflate';

const encoder=new TextDecoder('utf-8');
const EXT_MAX=800*1048576; // decompression safety, NOT a triangle limit
const CHUNK=256*1024;
const vRe=/^vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/;
const tRe=/^triangle v1="(\d+)" v2="(\d+)" v3="(\d+)" pid="(\d+)"(?: p1="(\d+)" p2="(\d+)" p3="(\d+)")?/;
const uvRe=/^m:tex2coord u="([^"]+)" v="([^"]+)"/;
const getAttr=(tag,name)=>new RegExp('(?:^|\\s)'+name+'="([^"]*)"').exec(tag)?.[1];
const asyncYield=()=>new Promise(resolve=>setTimeout(resolve,0));
class Numbers{
 constructor(ArrayType=Float32Array){this.ArrayType=ArrayType;this.data=new ArrayType(2048);this.length=0}
 push(...values){
  const len=this.length+values.length;
  if(len>this.data.length){
   let capacity=this.data.length;
   while(capacity<len)capacity*=2;
   const bigger=new this.ArrayType(capacity);
   bigger.set(this.data.subarray(0,this.length));this.data=bigger;
  }
  for(let i=0;i<values.length;i++)this.data[this.length++]=values[i];
 }
 finish(){return this.data.slice(0,this.length)}
}
const numeric=n=>{const value=Number(n);if(!Number.isFinite(value))throw Error('3MF: некорректные числа в XML');return value};
export async function importLarge3mf(data,{onProgress=()=>{},loadTextures=true}={}){
 const input=data instanceof Uint8Array?data:new Uint8Array(data);
 if(input.length<22||input[0]!==80||input[1]!==75)
  throw Error('3MF: недействительный ZIP');
 let state='other',countXML=0,modelFound=false,modelFinished=false,unit=.001;
 let activeGroup=0,activeObject=null,uvGroup=0;
 let modelData='';
 const uv=new Numbers(),colors=new Numbers(),vertices=new Numbers(),indices=new Numbers(Uint32Array);
 const materials=new Map(),textureResources=new Map(),textureGroups=new Map();
 const textureChunks=new Map(),textureLengths=new Map();
 const objects=[];
 let changedUV=false,triangleCount=0,lastPercent=-1;
 function handle(tag){
  if(tag.startsWith('/object')){
   if(activeObject){
    objects.push(activeObject);
    activeObject=null;
   }
   return;
  }
  if(tag[0]==='/'||tag[0]==='?'||tag[0]==='!')return;
  if(tag.startsWith('model ')){
   const u=getAttr(tag,'unit');
   unit={micron:.000001,millimeter:.001,centimeter:.01,meter:1,inch:.0254,foot:.3048}[u]??.001;
  }else if(tag.startsWith('m:texture2d ')){
   const id=+getAttr(tag,'id'),path=getAttr(tag,'path');
   if(Number.isInteger(id)&&path)textureResources.set(id,path.replace(/^\//,''));
  }else if(tag.startsWith('m:texture2dgroup ')){
   uvGroup=+getAttr(tag,'id');activeGroup=uvGroup;
   textureGroups.set(uvGroup,{texid:+getAttr(tag,'texid'),start:uv.length/2,count:0});
  }else if(tag.startsWith('m:tex2coord ')){
   if(!activeGroup)return;
   const m=uvRe.exec(tag);if(!m)throw Error('3MF: неправильный UV');
   uv.push(numeric(m[1]),numeric(m[2]));
   textureGroups.get(activeGroup).count++;
  }else if(tag.startsWith('m:colorgroup ')){
   activeGroup=+getAttr(tag,'id');
   materials.set(activeGroup,{mode:'colors',start:colors.length/3});
  }else if(tag.startsWith('m:color ')){
   const hex=getAttr(tag,'color');
   if(!hex||!/^#[0-9a-fA-F]{6,8}$/.test(hex))throw Error('3MF: неверный цвет');
   const c=new THREE.Color(hex.slice(0,7));
   colors.push(c.r,c.g,c.b);
  }else if(tag.startsWith('basematerials ')){
   activeGroup=+getAttr(tag,'id');
  }else if(tag.startsWith('base ')){
   const hex=getAttr(tag,'displaycolor');
   materials.set(activeGroup,{mode:'base',hex:hex||'#ffffff'});
  }else if(tag.startsWith('object ')){
   if(activeObject)throw Error('3MF: неожиданное вложение объектов');
   activeObject={id:+getAttr(tag,'id'),name:getAttr(tag,'name')||'3MF Object',
    vertexStart:vertices.length/3,indexStart:indices.length,materialIds:new Set()};
  }else if(tag.startsWith('vertex ')){
   if(!activeObject)return;
   const m=vRe.exec(tag);if(!m)throw Error('3MF: некорректная вершина');
   // 3MF Z-up in millimetres -> Three.js Y-up in metres
   const x=numeric(m[1])*unit,y=numeric(m[2])*unit,z=numeric(m[3])*unit;
   vertices.push(x,z,-y);
  }else if(tag.startsWith('triangle ')){
   if(!activeObject)return;
   const m=tRe.exec(tag);if(!m)throw Error('3MF: некорректный треугольник');
   const a=+m[1],b=+m[2],c=+m[3],pid=+m[4],base=activeObject.vertexStart;
   indices.push(base+a,base+b,base+c);
   triangleCount++;
   activeObject.materialIds.add(pid);
   if(m[5]!==undefined&&(a!==+m[5]||b!==+m[6]||c!==+m[7]))
    changedUV=true;
  }else if(tag.startsWith('item ')){
   // model <build> uses object IDs; internal single-scene grouping is enough
  }
 }
 function parse(bytes,final=false){
  const text=modelData+encoder.decode(bytes,{stream:!final});
  if(text.length>18*1048576)throw Error('3MF: непредвиденно длинный XML-элемент');
  const end=text.lastIndexOf('>');
  if(end<0){modelData=text;return}
  const upto=text.slice(0,end+1);
  const re=/<([^<>]*)>/g;
  let m,last=0;
  while((m=re.exec(upto))){handle(m[1]);last=re.lastIndex}
  modelData=text.slice(last);
  if(final&&modelData.trim())throw Error('3MF: незавершённый XML');
 }
 // We cannot easily reconstruct arbitrary third-party per-face UV seams
 // without duplicating vertex positions. Fail loudly rather than silently
 // returning a subtly corrupted textured mesh.
 let unzipError=null;
 const unzip=new Unzip(file=>{
  const path=file.name.replace(/^\/+/,''),isModel=/^3D\/[^/]+\.model$/i.test(path),
   isTexture=/^3D\/Textures\/[^/]+\.(png|jpe?g)$/i.test(path);
  if(file.originalSize>EXT_MAX){
   unzipError=Error('3MF: один распакованный файл больше безопасного лимита для Android');
   file.ondata=()=>{};return;
  }
  if(isModel){
   if(modelFound){unzipError=Error('3MF: несколько основных моделей');return;}
   modelFound=true;
   file.ondata=(err,bytes,final)=>{
    if(err){unzipError=err;return}
    try{
     countXML+=bytes.byteLength;
     if(countXML>EXT_MAX)throw Error('3MF: XML слишком большой для Android');
     // A very compressible 3MF may inflate a 256 KB ZIP chunk into tens
     // of MB in one callback. Slice expanded bytes BEFORE decoding them to
     // keep XML token buffers bounded even for repetitive huge meshes.
     for(let i=0;i<bytes.length;i+=128*1024)
      parse(bytes.subarray(i,Math.min(bytes.length,i+128*1024)),false);
     if(final){parse(new Uint8Array(0),true);modelFinished=true;}
    }catch(e){unzipError=e}
   };
   file.start();
  }else if(isTexture){
   const chunks=[];let length=0;
   file.ondata=(err,bytes,final)=>{
    if(err){unzipError=err;return}
    length+=bytes.length;
    if(length>32*1048576){unzipError=Error('3MF: PNG слишком большой');return}
    if(bytes.length)chunks.push(bytes);
    if(final){
     const out=new Uint8Array(length);let off=0;
     for(const b of chunks){out.set(b,off);off+=b.length}
     textureChunks.set(path,out);
    }
   };
   file.start();
  }else{file.ondata=()=>{};file.start();}
 });
 unzip.register(UnzipInflate);
 for(let offset=0;offset<input.length;offset+=CHUNK){
  if(unzipError)throw unzipError;
  const end=Math.min(input.length,offset+CHUNK);
  unzip.push(input.subarray(offset,end),end===input.length);
  if(unzipError)throw unzipError;
  const pct=Math.floor(end/input.length*85);
  if(pct!==lastPercent&&pct%2===0){lastPercent=pct;onProgress(pct)}
  await asyncYield();
 }
 if(!modelFound||!modelFinished)throw Error('3MF: основной XML не найден или не прочитан');
 if(changedUV)throw Error('3MF: отдельные UV индексы треугольников пока не поддерживаются при импорте больших файлов');
 const root=new THREE.Group();root.name='3MF_Imported';
 const xyz=vertices.finish(),abc=indices.finish();
 const texcoord=uv.length?uv.finish():null;
 const materialIds=objects.reduce((set,o)=>{
  for(const m of o.materialIds)set.add(m);
  return set;
 },new Set());
 if(materialIds.size>1)
  throw Error('3MF: сложные мультиматериальные объекты требуют отдельного импортёра; исходный файл не повреждён');
 const matId=[...materialIds][0];
 const matInfo=textureGroups.get(matId)||materials.get(matId);
 let material=new THREE.MeshStandardMaterial({color:0xffffff,side:THREE.DoubleSide});
 if(matInfo?.mode==='base')material.color.set(matInfo.hex);
 if(matInfo?.mode==='colors'&&colors.length/3===vertices.length/3){
  material.vertexColors=true;
 }
 if(matInfo?.texid!==undefined&&texcoord){
  const textureName=textureResources.get(matInfo.texid);
  const source=textureChunks.get(textureName);
  if(source&&loadTextures&&typeof URL!=='undefined'&&typeof document!=='undefined'){
   const url=URL.createObjectURL(new Blob([source],{type:'image/png'}));
   try{
    const map=await new THREE.TextureLoader().loadAsync(url);
    map.colorSpace=THREE.SRGBColorSpace;map.flipY=false;
    material.map=map;material.needsUpdate=true;
   }finally{URL.revokeObjectURL(url)}
  }
 }
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.BufferAttribute(xyz,3));
 geometry.setIndex(new THREE.BufferAttribute(abc,1));
 if(texcoord&&texcoord.length===xyz.length/3*2)
  geometry.setAttribute('uv',new THREE.BufferAttribute(texcoord,2));
 if(material.vertexColors)geometry.setAttribute('color',new THREE.BufferAttribute(colors.finish(),3));
 geometry.computeVertexNormals();
 // Build one unified geometry for all object sections; duplicating the entire
 // 1.9M-triangle buffer per source object would explode mobile GPU memory.
 const mesh=new THREE.Mesh(geometry,material);
 mesh.name=objects.length===1?objects[0].name:'3MF_Combined';
 mesh.frustumCulled=false;
 root.add(mesh);
 onProgress(100);
 return {root,clips:[],notice:'3MF: потоковый импорт без DOM; '+triangleCount.toLocaleString('ru-RU')+
   ' треугольников, '+(vertices.length/3).toLocaleString('ru-RU')+
   ' вершин. Геометрия не упрощена; печатная UV/Albedo-текстура перенесена.'};
}

/**
 * Portable offline OBJ package: geometry.obj + materials.mtl + PNG textures.
 * OBJ is a static format, so bones/animations/PBR fidelity cannot be retained.
 * This module makes all references explicit, instead of saving a bare OBJ.
 */
import * as THREE from 'three';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { zipSync, strToU8, zlibSync } from 'fflate';

const clean = (text, fallback='model') => String(text||fallback)
  .replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,64)||fallback;
const utf = (s)=>strToU8(s);
const finite = (n)=>Number.isFinite(n)?Number(n.toFixed(6)):0;
export const MIXAMO_MAX_FACES = 350000;
const MIXAMO_MAX_ZIP_BYTES = 65 * 1048576;
const MAPS = [
  ['map','map_Kd'],['normalMap','norm'],['bumpMap','map_Bump'],
  ['specularMap','map_Ks'],['emissiveMap','map_Ke'],['alphaMap','map_d'],
  ['roughnessMap','map_Pr'],['metalnessMap','map_Pm'],
  ['aoMap','map_AO'],['displacementMap','disp']
];

const crcTable = new Uint32Array(256);
for(let i=0;i<256;i++){let n=i;for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;crcTable[i]=n>>>0}
function crc32(b){
 let crc=0xffffffff;
 for(let i=0;i<b.length;i++)crc=crcTable[(crc^b[i])&255]^(crc>>>8);
 return (crc^0xffffffff)>>>0;
}
function chunk(type,body){
 const t=utf(type),out=new Uint8Array(body.length+12),view=new DataView(out.buffer);
 view.setUint32(0,body.length,false);out.set(t,4);out.set(body,8);
 view.setUint32(out.length-4,crc32(out.subarray(4,out.length-4)),false);
 return out;
}
function rgbaPNG(data,width,height){
 const size=width*height;
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||size>32768*32768)
   throw Error('Неверные размеры текстуры для PNG');
 const components=data.length/size;
 if(components!==4&&components!==3)
   throw Error('Для OBJ ZIP нужна цветная текстура RGBA8 или RGB8, а не HDR/Float');
 const rows=new Uint8Array(height*(1+width*4));
 for(let y=0;y<height;y++){
   let dest=y*(width*4+1)+1;
   for(let x=0;x<width;x++){
     let p=(y*width+x)*components;
     rows[dest++]=data[p];rows[dest++]=data[p+1];rows[dest++]=data[p+2];
     rows[dest++]=components===4?data[p+3]:255;
   }
 }
 const ihdr=new Uint8Array(13),dv=new DataView(ihdr.buffer);
 dv.setUint32(0,width,false);dv.setUint32(4,height,false);ihdr[8]=8;ihdr[9]=6;
 const chunks=[
   new Uint8Array([137,80,78,71,13,10,26,10]),
   chunk('IHDR',ihdr),chunk('IDAT',zlibSync(rows,{level:4})),chunk('IEND',new Uint8Array())
 ];
 const out=new Uint8Array(chunks.reduce((n,x)=>n+x.length,0));
 let offset=0;for(const b of chunks){out.set(b,offset);offset+=b.length}
 return out;
}
async function texturePNG(texture,{maxSize=Infinity}={}){
 const image=texture.image;
 if(!image)throw Error('Невозможно сохранить '+(texture.name||'текстуру')+': нет изображения');
 const w=image.width||image.naturalWidth,h=image.height||image.naturalHeight;
 if(!(w>0&&h>0))throw Error('Текстура ещё не загрузилась: '+(texture.name||'без имени'));
 const ratio=Math.min(1,maxSize/Math.max(w,h));
 const newW=Math.max(1,Math.round(w*ratio)),newH=Math.max(1,Math.round(h*ratio));
 if(image.data){
   if(!(image.data instanceof Uint8Array))
     throw Error('Для '+(texture.name||'текстуры')+' требуется преобразование HDR/Float в RGBA8');
   if(ratio===1)return rgbaPNG(image.data,w,h);
   const comps=image.data.length/(w*h);
   if(comps!==3&&comps!==4)throw Error('Неподдерживаемые каналы DataTexture');
   const scaled=new Uint8Array(newW*newH*comps);
   for(let y=0;y<newH;y++)for(let x=0;x<newW;x++){
     const srcIndex=(Math.min(h-1,Math.floor((y+.5)*h/newH))*w+
       Math.min(w-1,Math.floor((x+.5)*w/newW)))*comps;
     const destIndex=(y*newW+x)*comps;
     for(let i=0;i<comps;i++)scaled[destIndex+i]=image.data[srcIndex+i];
   }
   return rgbaPNG(scaled,newW,newH);
 }
 if(typeof document==='undefined'&&typeof OffscreenCanvas==='undefined')
   throw Error('Для текстуры требуется Android Canvas или DataTexture');
 const canvas=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(newW,newH):
   Object.assign(document.createElement('canvas'),{width:newW,height:newH});
 const ctx=canvas.getContext('2d');
 if(!ctx)throw Error('Android не поддерживает преобразование текстуры в PNG');
 ctx.drawImage(image,0,0,newW,newH);
 const blob=canvas.convertToBlob?await canvas.convertToBlob({type:'image/png'}):
   await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('PNG encoding failed')),'image/png'));
 return new Uint8Array(await blob.arrayBuffer());
}
function findMap(material){
 return MAPS.map(([slot])=>material?.[slot]).find(t=>t?.isTexture)||null;
}
function validateMaps(material){
 const all=MAPS.map(([slot])=>material?.[slot]).filter(t=>t?.isTexture);
 if(!all.length)return null;
 const tex=findMap(material);
 tex.updateMatrix();
 for(const t of all){
   t.updateMatrix();
   if((t.channel||0)!==(tex.channel||0)||
      t.flipY!==tex.flipY||
      !t.matrix.elements.every((v,i)=>Math.abs(v-tex.matrix.elements[i])<1e-5))
     throw Error('У материала '+(material.name||'без имени')+
       ' разные UV-преобразования PBR-карт. OBJ/MTL имеет только одну UV-развёртку; экспорт остановлен, чтобы текстуры не съехали.');
 }
 return tex;
}
function geometryPart(source,start,count){
 const g=new THREE.BufferGeometry();
 for(const [name,attribute] of Object.entries(source.attributes))g.setAttribute(name,attribute);
 const src=source.getIndex(),ids=new Uint32Array(count);
 for(let i=0;i<count;i++)ids[i]=src?src.getX(start+i):start+i;
 g.setIndex(new THREE.BufferAttribute(ids,1));
 return g;
}
function bakeUV(geometry,texture){
 if(!texture)return;
 const channel=texture.channel||0;
 const attrName=channel===0?'uv':channel===1?'uv1':channel===2?'uv2':channel===3?'uv3':null;
 const attr=attrName&&geometry.getAttribute(attrName);
 if(!attr||attr.itemSize!==2)throw Error('У текстурированного материала отсутствует UV-канал '+channel);
 const result=new Float32Array(attr.count*2);
 const tmp=new THREE.Vector2();
 for(let i=0;i<attr.count;i++){
   tmp.set(attr.getX(i),attr.getY(i)).applyMatrix3(texture.matrix);
   result[i*2]=tmp.x;
   // GLB uses flipY=false, OBJ/MTL uses standard bottom-origin UVs.
   result[i*2+1]=texture.flipY===false?1-tmp.y:tmp.y;
 }
 geometry.setAttribute('uv',new THREE.Float32BufferAttribute(result,2));
}
/** Render only geometry as temporary detached meshes. Does not change source. */
function makeObjScene(root,{mixamo=false}={}){
 const output=new THREE.Group(),materials=new Map(),garbage=[];
 root.updateMatrixWorld(true);
 let faceCount=0;
 root.traverse(mesh=>{
   if(!mesh.isMesh)return;
   const geo=mesh.geometry,base=geo?.getAttribute('position');
   if(!base)throw Error('У меша '+(mesh.name||'')+' нет вершин');
   const available=Array.isArray(mesh.material)?mesh.material:[mesh.material];
   const index=geo.getIndex(),length=index?index.count:base.count;
   // A single material covers all geometry groups (e.g. BoxGeometry has six
   // preset groups even though only one material was provided).
   const groups=available.length===1?[{start:0,count:length,materialIndex:0}]:
     (geo.groups.length?geo.groups:[{start:0,count:length,materialIndex:0}]);
   if(available.length>1&&!geo.groups.length)
     throw Error('У многоматериального меша отсутствуют границы групп');
   for(const [groupIndex,g] of groups.entries()){
     const count=Math.max(0,Math.min(length-g.start,g.count));
     if(count<=0)continue;
     if(count%3)throw Error('OBJ экспортирует только треугольники');
     const source=available[g.materialIndex||0];
     if(!source)throw Error('В геометрии отсутствует материал группы '+(g.materialIndex||0));
     if(!materials.has(source))materials.set(source,'Mat_'+String(materials.size+1).padStart(3,'0')+'_'+clean(source.name,'Material'));
     // Mixamo accepts a minimal Diffuse material. It does not need the
     // other GLB PBR texture transforms, which may differ and cause Picasso.
     const tex=source.map?.isTexture?source.map:null;
     if(tex)tex.updateMatrix();
     const matName=materials.get(source),texture=mixamo?tex:validateMaps(source);
     const segment=geometryPart(geo,g.start,count);
     garbage.push(segment);
     bakeUV(segment,texture);
     if(!segment.getAttribute('normal')){
       // Compute on an independent geometry (never mutate shared source).
       for(const [k,v] of Object.entries(segment.attributes)){
         if(k==='normal')continue;
         segment.setAttribute(k,v);
       }
       segment.computeVertexNormals();
     }
     const part=new THREE.Mesh(segment,new THREE.MeshBasicMaterial({name:matName}));
     garbage.push(part.material);
     part.name=clean(mesh.name||'Mesh')+'_'+groupIndex;
     part.matrixAutoUpdate=false;part.matrix.copy(mesh.matrixWorld);
     output.add(part);
     faceCount+=count/3;
   }
 });
 if(!faceCount)throw Error('OBJ не содержит треугольников');
 output.updateMatrixWorld(true);
 return {output,materials,faceCount,dispose:()=>garbage.forEach(x=>x.dispose())};
}
function materialDefinition(m,name,texNames,{mixamo=false}={}){
 const color=(m.color||new THREE.Color(1,1,1)).clone().convertLinearToSRGB();
 if(mixamo){
   const lines=['newmtl '+name,'Ka 0 0 0',
     'Kd '+[color.r,color.g,color.b].map(finite).join(' '),
     'Ks 0 0 0','Ns 0','illum 1',
     'd '+finite(m.opacity??1)];
   if(m.map?.isTexture){
     const file=texNames.get(m.map);
     if(!file)throw Error('Для Mixamo отсутствует изображение Albedo');
     lines.push('map_Kd '+file);
   }
   return lines.join('\n')+'\n';
 }
 const lines=['newmtl '+name,'Ka 0 0 0',
   'Kd '+[color.r,color.g,color.b].map(finite).join(' '),
   'Ks 0.04 0.04 0.04',
   'Ns '+finite(100*(1-(m.roughness??0.5))),
   'd '+finite(m.opacity??1),'illum 2'];
 for(const [slot,keyword] of MAPS){
   const texture=m[slot];
   if(texture?.isTexture){
     const file=texNames.get(texture);
     if(!file)throw Error('Изображение '+slot+' не подготовлено');
     lines.push(keyword+' '+file);
   }
 }
 return lines.join('\n')+'\n';
}

/**
 * Returns ZIP bytes with a portable root-level OBJ, MTL, and images.
 * PBR maps are included as supplemental (map_Pr/map_Pm/etc.) extensions:
 * old OBJ viewers may display only map_Kd.
 */
export async function exportObjZip(root,{baseName='model',profile='full'}={}){
 const mixamo=profile==='mixamo';
 const name=clean(baseName);
 if(mixamo){
   let count=0;
   root.traverse(n=>{if(n.isMesh){
     const geo=n.geometry,p=geo?.getAttribute('position'),ind=geo?.index;
     count+=Math.floor((ind?.count||p?.count||0)/3);
   }});
   if(count>MIXAMO_MAX_FACES)throw Error(
     'Для Mixamo модель слишком тяжёлая: '+count.toLocaleString('ru-RU')+
     ' треугольников. Максимум профиля '+MIXAMO_MAX_FACES.toLocaleString('ru-RU')+
     '. Сначала создай предпросмотр «Экономия» и повтори экспорт OBJ для Mixamo.');
 }
 const scene=makeObjScene(root,{mixamo});
 const files={};
 try{
   const rawOBJ=new OBJExporter().parse(scene.output);
   const texNames=new Map();
   const textures=[];
   for(const material of scene.materials.keys()){
     for(const [slot] of (mixamo?[MAPS[0]]:MAPS)){
       const t=material[slot];
       if(t?.isTexture&&!texNames.has(t)){
         const file='texture_'+String(texNames.size+1).padStart(3,'0')+'_'+clean(t.name||slot)+'.png';
         texNames.set(t,file);
         textures.push([file,t]);
       }
     }
   }
   for(const [filename,texture] of textures){
     // No fallback to an untextured archive if PNG conversion fails.
     files[filename]=[await texturePNG(texture,{maxSize:mixamo?1024:Infinity}),{level:0}];
   }
   let mtl='# Phoenix Model Forge '+(mixamo?'Mixamo Diffuse':'OBJ+MTL')+' offline archive\n';
   for(const [material,materialName] of scene.materials)
     mtl+='\n'+materialDefinition(material,materialName,texNames,{mixamo});
   const obj='mtllib '+name+'.mtl\n'+rawOBJ;
   if(!/^usemtl\s+\S+/m.test(obj))throw Error('OBJ не содержит ссылок на материалы');
   files[name+'.obj']=[utf(obj),{level:1}];
   files[name+'.mtl']=[utf(mtl),{level:1}];
   if(!mixamo)files['README.txt']=[utf(
     'Phoenix Model Forge - offline OBJ archive\n'+
     'Load '+name+'.obj and keep '+name+'.mtl and all PNG files in the same folder.\n'+
     'OBJ stores static meshes and UVs only. Bones and animations are not supported.\n'+
     'Diffuse (map_Kd) and normal maps are linked in MTL. Some viewers ignore extra PBR maps.\n'
   ),{level:1}];
   const content=zipSync(files,{level:1});
   if(mixamo && content.byteLength>MIXAMO_MAX_ZIP_BYTES)
     throw Error('Архив OBJ для Mixamo слишком большой ('+
       (content.byteLength/1048576).toFixed(1)+' МБ). Выбери более сильное упрощение модели.');
   if(content.byteLength>500*1024*1024)
     throw Error('Архив OBJ больше 500 МБ. Уменьши модель во вкладке Оптимизация.');
   return {content,mime:'application/zip',meshes:scene.output.children.length,
     textures:textures.length,faces:scene.faceCount,profile};
 }finally{
   scene.dispose();
 }
}

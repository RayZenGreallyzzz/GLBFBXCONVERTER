// 3MF Core + Materials & Properties textured surface exporter.
// Unit convention: app scene uses metres, 3MF uses millimetres; 3MF is Z-up.
// All object transforms are baked into individual mesh vertices. Animations
// and skeletons cannot be represented in print-ready 3MF.
import * as THREE from 'three';
import {zipSync,strToU8} from 'fflate';
import {texturePNG} from './obj-zip.js';

const xmlEscape=s=>String(s??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')
 .replace(/</g,'&lt;').replace(/>/g,'&gt;');
const float=n=>Number.isFinite(n)?Number(n.toFixed(7)):0;
function colorHex(color,alpha=1){
 const c=color?.isColor?color:new THREE.Color(0xffffff);
 return '#'+c.getHex(THREE.SRGBColorSpace).toString(16).padStart(6,'0').toUpperCase()+
   Math.round(Math.min(1,Math.max(0,alpha))*255).toString(16).padStart(2,'0').toUpperCase();
}
function materialForTriangle(geometry,materialList,face){
 const begin=face*3;
 const group=(geometry.groups||[]).find(g=>begin>=g.start&&begin<g.start+g.count);
 return materialList[group?.materialIndex||0]||materialList[0];
}
function collectMeshes(root){
 root.updateWorldMatrix(true,true);
 const meshes=[];
 root.traverse(node=>{
   if(node.isMesh&&node.visible&&node.geometry?.getAttribute('position'))
     meshes.push(node);
 });
 if(!meshes.length)throw Error('3MF: нет видимой геометрии для печати');
 return meshes;
}
export async function exportTextured3mf(root,{name='Model',maxTextureSize=2048,unitScale=1000}={}){
 if(!Number.isFinite(unitScale)||unitScale<=0)
   throw Error('3MF: масштаб должен быть положительным');
 const sceneMeshes=collectMeshes(root),textures={},resources=[],objects=[],items=[],rels=[];
 let id=1,totalTriangles=0,totalTextures=0;
 for(const node of sceneMeshes){
   const geo=node.geometry,attr=geo.getAttribute('position'),uv=geo.getAttribute('uv');
   const colors=geo.getAttribute('color'),index=geo.getIndex();
   const faces=Math.floor((index?index.count:attr.count)/3);
   if(!faces)continue;
   totalTriangles+=faces;
   if(totalTriangles>650000)throw Error('3MF: больше 650 000 треугольников. Сначала оптимизируй для Android.');
   const materialList=Array.isArray(node.material)?node.material:[node.material];
   const materials=[...new Set(Array.from({length:faces},(_,i)=>materialForTriangle(geo,materialList,i)))];
   const groups=new Map();
   for(const mat of materials){
     if(mat?.map&&uv){
       const texId=id++,groupId=id++,file='texture_'+String(++totalTextures).padStart(3,'0')+'.png';
       const src=await texturePNG(mat.map,{maxSize:maxTextureSize});
       const path='/3D/Textures/'+file;
       textures['3D/Textures/'+file]=src;
       resources.push('<m:texture2d id="'+texId+'" path="'+path+
         '" contenttype="image/png" tilestyleu="wrap" tilestylev="wrap"/>');
       const points=[];
       mat.map.updateMatrix();
       for(let i=0;i<attr.count;i++){
         const point=new THREE.Vector2(uv.getX(i),uv.getY(i));
         mat.map.transformUv(point);
         points.push('<m:tex2coord u="'+float(point.x)+'" v="'+float(point.y)+'"/>');
       }
       resources.push('<m:texture2dgroup id="'+groupId+'" texid="'+texId+'">'+points.join('')+'</m:texture2dgroup>');
       groups.set(mat,{id:groupId,mode:'texture'});
       rels.push('<Relationship Target="'+path+'" Id="texture'+totalTextures+
         '" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture"/>');
     }else if(colors){
       const groupId=id++,parts=[];
       for(let i=0;i<attr.count;i++){
         const col=new THREE.Color().setRGB(colors.getX(i),colors.getY(i),colors.getZ(i),THREE.LinearSRGBColorSpace);
         parts.push('<m:color color="'+colorHex(col)+'"/>');
       }
       resources.push('<m:colorgroup id="'+groupId+'">'+parts.join('')+'</m:colorgroup>');
       groups.set(mat,{id:groupId,mode:'color'});
     }else{
       const groupId=id++;
       resources.push('<basematerials id="'+groupId+'"><base name="'+xmlEscape(mat?.name||'Material')+
         '" displaycolor="'+colorHex(mat?.color,mat?.opacity??1)+'"/></basematerials>');
       groups.set(mat,{id:groupId,mode:'base'});
     }
   }
   const vertices=[],tmp=new THREE.Vector3();
   for(let i=0;i<attr.count;i++){
     tmp.fromBufferAttribute(attr,i);
     if(node.isSkinnedMesh)node.applyBoneTransform(i,tmp);
     tmp.applyMatrix4(node.matrixWorld);
     if(![tmp.x,tmp.y,tmp.z].every(Number.isFinite))
       throw Error('3MF: некорректные координаты вершин');
     // Three.js Y-up -> 3MF Z-up, app metres -> millimetres
     vertices.push('<vertex x="'+float(tmp.x*unitScale)+'" y="'+float(-tmp.z*unitScale)+
       '" z="'+float(tmp.y*unitScale)+'"/>');
   }
   const triangles=[];
   for(let face=0;face<faces;face++){
     const arr=Array.from({length:3},(_,k)=>index?index.getX(face*3+k):face*3+k);
     if(new Set(arr).size!==3)continue;
     const mat=materialForTriangle(geo,materialList,face);
     const group=groups.get(mat);
     if(!group)throw Error('3MF: не найден материал для треугольника');
     const prop=group.mode==='base'?'':(' p1="'+arr[0]+'" p2="'+arr[1]+'" p3="'+arr[2]+'"');
     triangles.push('<triangle v1="'+arr[0]+'" v2="'+arr[1]+'" v3="'+arr[2]+'" pid="'+group.id+'"'+prop+'/>');
   }
   const objectId=id++;
   objects.push('<object id="'+objectId+'" name="'+xmlEscape(node.name||name)+
     '" type="model"><mesh><vertices>'+vertices.join('')+'</vertices><triangles>'+
     triangles.join('')+'</triangles></mesh></object>');
   items.push('<item objectid="'+objectId+'"/>');
 }
 if(!objects.length)throw Error('3MF: пустая печатная модель');
 const core='http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
 const mats='http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
 const model='<?xml version="1.0" encoding="UTF-8"?>'+
  '<model unit="millimeter" xml:lang="ru-RU" xmlns="'+core+'" xmlns:m="'+mats+
  '" requiredextensions="m"><metadata name="Title">'+xmlEscape(name)+'</metadata>'+
  '<resources>'+resources.join('')+objects.join('')+'</resources><build>'+
  items.join('')+'</build></model>';
 const contentTypes='<?xml version="1.0" encoding="UTF-8"?>'+
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'+
  '<Default Extension="png" ContentType="image/png"/></Types>';
 const relationships='<?xml version="1.0" encoding="UTF-8"?>'+
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
  '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
 const parts={
  '[Content_Types].xml':strToU8(contentTypes),
  '_rels/.rels':strToU8(relationships),
  '3D/3dmodel.model':strToU8(model),
  ...textures
 };
 if(rels.length){
   parts['3D/_rels/3dmodel.model.rels']=strToU8(
     '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
     rels.join('')+'</Relationships>');
 }
 return {content:zipSync(parts,{level:5}),mime:'model/3mf',
   textures:totalTextures,meshes:objects.length,triangles:totalTriangles};
}

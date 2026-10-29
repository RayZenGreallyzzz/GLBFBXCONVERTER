// 3MF Core + Materials & Properties exporter for high-density printing.
// No arbitrary polygon-count cap. XML is written in small chunks directly to
// a streaming ZIP entry so multi-million-triangle GLBs do not build a giant
// vertices[] + triangles[] + XML string in the Android WebView heap.
import * as THREE from 'three';
import {Zip,ZipDeflate,ZipPassThrough,strToU8} from 'fflate';
import {texturePNG} from './obj-zip.js';

const xmlEscape=s=>String(s??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;')
 .replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmt=n=>Number.isFinite(n)?Number(n.toFixed(7)):0;
const colorHex=(color,alpha=1)=>{
 const c=color?.isColor?color:new THREE.Color(0xffffff);
 return '#'+c.getHex(THREE.SRGBColorSpace).toString(16).padStart(6,'0').toUpperCase()+
   Math.round(Math.min(1,Math.max(0,alpha))*255).toString(16).padStart(2,'0').toUpperCase();
};
const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,0));
function meshesIn(root){
 root.updateWorldMatrix(true,true);
 const out=[];
 root.traverse(node=>{
  if(node.isMesh&&node.visible&&node.geometry?.getAttribute('position'))out.push(node);
 });
 if(!out.length)throw Error('3MF: нет видимой геометрии для печати');
 return out;
}
function materialAt(geo,materials,face){
 const faceIndex=face*3,groups=geo.groups||[];
 // Avoid allocating a million-element material array, as the old exporter did.
 for(let i=0;i<groups.length;i++){
  const g=groups[i];
  if(faceIndex>=g.start&&faceIndex<g.start+g.count)
   return materials[g.materialIndex]||materials[0];
 }
 return materials[0];
}
function usedMaterials(geo,list){
 const groups=geo.groups||[];
 if(!groups.length)return [list[0]];
 return [...new Set(groups.map(g=>list[g.materialIndex]||list[0]))];
}
function zipWriter(){
 let zip,finished=false,total=0,failed=null;
 const chunks=[];
 const done=new Promise((resolve,reject)=>{
  zip=new Zip((err,bytes,final)=>{
   if(err){failed=err;reject(err);return}
   if(bytes?.length){chunks.push(bytes);total+=bytes.length;}
   if(final){
    finished=true;
    const all=new Uint8Array(total);
    let offset=0;
    for(const part of chunks){all.set(part,offset);offset+=part.length}
    chunks.length=0;
    resolve(all);
   }
  });
 });
 function add(name,data){
  const item=new ZipPassThrough(name);
  zip.add(item);item.push(data,true);
 }
 return {zip,done,add,check(){if(failed)throw failed},isFinished:()=>finished};
}
export async function exportTextured3mf(root,{name='Model',maxTextureSize=2048,
 unitScale=1000,onProgress=null}={}){
 if(!Number.isFinite(unitScale)||unitScale<=0)
  throw Error('3MF: масштаб должен быть положительным');
 const nodes=meshesIn(root);
 const records=nodes.map(node=>{
  const geo=node.geometry,attr=geo.getAttribute('position'),uv=geo.getAttribute('uv'),
   colors=geo.getAttribute('color'),idx=geo.getIndex();
  return {node,geo,attr,uv,colors,idx,
   faces:Math.floor((idx?idx.count:attr.count)/3),
   mats:Array.isArray(node.material)?node.material:[node.material],
   byMaterial:new Map(),objectId:0};
 }).filter(x=>x.faces>0);
 if(!records.length)throw Error('3MF: пустая печатная модель');
 const totalTriangles=records.reduce((n,r)=>n+r.faces,0);
 const totalVertices=records.reduce((n,r)=>n+r.attr.count,0);
 const work=totalTriangles+totalVertices*2;
 let completed=0,lastReport=0,id=1,totalTextures=0;
 const writer=zipWriter(),{zip}=writer;
 // 3MF uses millimetres and Z-up; input models normally use Y-up/metres.
 const core='http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
 const mats='http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
 const entry=new ZipDeflate('3D/3dmodel.model',{level:2});
 zip.add(entry);
 let buffer='';
 const flush=()=>{
  if(!buffer.length)return;
  entry.push(strToU8(buffer),false);
  buffer='';
  writer.check();
 };
 const write=s=>{buffer+=s;if(buffer.length>=280000)flush()};
 const pause=async()=>{
  flush();
  if(typeof onProgress==='function'&&completed-lastReport>=16000){
   lastReport=completed;
   onProgress(Math.min(98,Math.round(completed/work*98)));
  }
  await yieldUI();
 };
 const textureParts=[],textureRels=[];
 try{
  write('<?xml version="1.0" encoding="UTF-8"?>');
  write('<model unit="millimeter" xml:lang="ru-RU" xmlns="'+core+
   '" xmlns:m="'+mats+'"><metadata name="Title">'+
   xmlEscape(name)+'</metadata><resources>');
  // Print material resources must precede <object> elements.
  for(const rec of records){
   const {attr,uv,colors,mats:materialList}=rec;
   const materials=usedMaterials(rec.geo,materialList);
   for(const mat of materials){
    if(mat?.map&&uv){
     const texId=id++,groupId=id++,filename='texture_'+String(++totalTextures).padStart(3,'0')+'.png';
     const path='/3D/Textures/'+filename;
     const bytes=await texturePNG(mat.map,{maxSize:maxTextureSize});
     textureParts.push({name:'3D/Textures/'+filename,bytes});
     textureRels.push('<Relationship Target="'+path+'" Id="texture'+totalTextures+
       '" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture"/>');
     write('<m:texture2d id="'+texId+'" path="'+path+
       '" contenttype="image/png" tilestyleu="wrap" tilestylev="wrap"/>');
     write('<m:texture2dgroup id="'+groupId+'" texid="'+texId+'">');
     mat.map.updateMatrix();
     const v=new THREE.Vector2();
     for(let i=0;i<attr.count;i++){
      v.set(uv.getX(i),uv.getY(i));
      mat.map.transformUv(v);
      write('<m:tex2coord u="'+fmt(v.x)+'" v="'+fmt(v.y)+'"/>');
      if(i%12000===11999)await pause();
     }
     write('</m:texture2dgroup>');
     rec.byMaterial.set(mat,{id:groupId,mode:'texture'});
    }else if(colors){
     const groupId=id++;
     write('<m:colorgroup id="'+groupId+'">');
     const col=new THREE.Color();
     for(let i=0;i<attr.count;i++){
      col.setRGB(colors.getX(i),colors.getY(i),colors.getZ(i),THREE.LinearSRGBColorSpace);
      write('<m:color color="'+colorHex(col)+'"/>');
      if(i%12000===11999)await pause();
     }
     write('</m:colorgroup>');
     rec.byMaterial.set(mat,{id:groupId,mode:'color'});
    }else{
     const groupId=id++;
     write('<basematerials id="'+groupId+'"><base name="'+xmlEscape(mat?.name||'Material')+
       '" displaycolor="'+colorHex(mat?.color,mat?.opacity??1)+'"/></basematerials>');
     rec.byMaterial.set(mat,{id:groupId,mode:'base'});
    }
   }
   rec.objectId=id++;
  }
  const tmp=new THREE.Vector3(),faceMaterials=[];
  for(const rec of records){
   const {node,geo,attr,idx,faces}=rec;
   write('<object id="'+rec.objectId+'" name="'+xmlEscape(node.name||name)+
    '" type="model"><mesh><vertices>');
   for(let i=0;i<attr.count;i++){
    tmp.fromBufferAttribute(attr,i);
    if(node.isSkinnedMesh)node.applyBoneTransform(i,tmp);
    tmp.applyMatrix4(node.matrixWorld);
    if(![tmp.x,tmp.y,tmp.z].every(Number.isFinite))
     throw Error('3MF: некорректные координаты вершин');
    write('<vertex x="'+fmt(tmp.x*unitScale)+'" y="'+fmt(-tmp.z*unitScale)+
     '" z="'+fmt(tmp.y*unitScale)+'"/>');
    completed++;
    if(i%12000===11999)await pause();
   }
   write('</vertices><triangles>');
   // Material group resolution is O(1) for the common single-material case.
   const one=rec.byMaterial.size===1?[...rec.byMaterial.values()][0]:null;
   for(let face=0;face<faces;face++){
    const a=idx?idx.getX(3*face):3*face,
     b=idx?idx.getX(3*face+1):3*face+1,
     c=idx?idx.getX(3*face+2):3*face+2;
    if(a===b||a===c||b===c)continue;
    if(a>=attr.count||b>=attr.count||c>=attr.count)
     throw Error('3MF: индекс треугольника выходит за пределы вершин');
    const material=one||rec.byMaterial.get(materialAt(geo,rec.mats,face));
    if(!material)throw Error('3MF: отсутствует материал треугольника');
    const props=material.mode==='base'?'':(' p1="'+a+'" p2="'+b+'" p3="'+c+'"');
    write('<triangle v1="'+a+'" v2="'+b+'" v3="'+c+'" pid="'+material.id+'"'+props+'/>');
    completed++;
    if(face%12000===11999)await pause();
   }
   write('</triangles></mesh></object>');
  }
  write('</resources><build>');
  for(const rec of records)write('<item objectid="'+rec.objectId+'"/>');
  write('</build></model>');
  flush();
  entry.push(new Uint8Array(0),true);
  const contentTypes='<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
   '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'+
   '<Default Extension="png" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodeltexture"/></Types>';
  const relationships='<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
   '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  writer.add('[Content_Types].xml',strToU8(contentTypes));
  writer.add('_rels/.rels',strToU8(relationships));
  if(textureRels.length)writer.add('3D/_rels/3dmodel.model.rels',strToU8(
   '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
   textureRels.join('')+'</Relationships>'));
  for(const part of textureParts)writer.add(part.name,part.bytes);
  zip.end();
  const content=await writer.done;
  if(typeof onProgress==='function')onProgress(100);
  return {content,mime:'model/3mf',textures:totalTextures,meshes:records.length,triangles:totalTriangles};
 }catch(error){
  zip.terminate?.();
  throw error;
 }
}

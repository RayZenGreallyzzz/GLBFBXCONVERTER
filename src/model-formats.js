// Offline import/export formats supported by bundled Three.js addons.
// Explicit restrictions prevent silently losing bones, animation or texture data.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { exportObjZip } from './obj-zip.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { PLYExporter } from 'three/addons/exporters/PLYExporter.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { USDZLoader } from 'three/addons/loaders/USDZLoader.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';

export const SUPPORTED_INPUTS = Object.freeze(['glb','gltf','vrm','fbx','obj','ply','stl','dae','usdz']);
export const SUPPORTED_OUTPUTS = Object.freeze(['glb','gltf','fbx7300','fbx7400','fbx7500','obj','obj-mixamo','ply','ply-lite','stl','usdz']);
export const LOSSY_EXPORTS = new Set(['obj','obj-mixamo','ply','ply-lite','stl','usdz']);
export const STATIC_EXPORTS = new Set(['obj','obj-mixamo','ply','ply-lite','stl','usdz']);
const MAX_ASSET_BYTES = 250*1024*1024;
const decoder = new TextDecoder();
function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength);
}
function meshScene(geometry, name, pointCloud=false) {
  if(!geometry?.getAttribute('position')) throw Error('Файл не содержит координат вершин');
  if(!geometry.getAttribute('normal')&&!pointCloud) geometry.computeVertexNormals();
  const material=pointCloud ?
    new THREE.PointsMaterial({size:.02,vertexColors:!!geometry.getAttribute('color')}) :
    new THREE.MeshStandardMaterial({vertexColors:!!geometry.getAttribute('color'),side:THREE.DoubleSide});
  const root = new THREE.Group();
  root.name = name;
  root.add(pointCloud?new THREE.Points(geometry,material):new THREE.Mesh(geometry,material));
  return root;
}
function basename(v){return decodeURIComponent(String(v||'').split(/[?#]/)[0].split('/').pop()).toLowerCase()}
function fileMap(files, main) {
  const map=new Map(), duplicates=new Set();
  for(const f of files||[]){
    if(f===main)continue;
    const key=basename(f.name);
    if(map.has(key))duplicates.add(key);
    map.set(key,f);
  }
  if(duplicates.size)throw Error('Дубли имен дополнительных файлов: '+[...duplicates].join(', '));
  return map;
}

// OBJ normally references MTL + image files. Resolve *only* explicitly selected
// local files; do not silently fetch missing dependencies from the Internet.
// All file URLs are released once textures have finished decoding.
export async function importObjWithMaterials(file,text,files=[file]){
  const assets=fileMap(files,file);
  const basic=new OBJLoader();
  const refs=[...text.matchAll(/^mtllib\s+(.+?)\s*$/gmi)].map(m=>m[1].trim());
  const providedMTL=Array.from(assets.values()).filter(a=>a.name.toLowerCase().endsWith('.mtl'));
  if(!refs.length&&!providedMTL.length){
    return {root:basic.parse(text),clips:[],
      notice:'OBJ: геометрия без файла MTL. Для текстур выбери OBJ, MTL и изображения вместе.'};
  }
  if(refs.length>1)throw Error('OBJ с несколькими MTL пока не поддерживается. Объедини материалы в один MTL.');
  let materialFile;
  if(refs.length){
    const expected=basename(refs[0]);
    materialFile=assets.get(expected);
    if(!materialFile)throw Error('OBJ ссылается на '+refs[0]+'. Выбери этот MTL вместе с OBJ.');
  }else{
    if(providedMTL.length!==1)throw Error('Выбери один файл MTL для OBJ');
    materialFile=providedMTL[0];
  }
  if(!materialFile.name.toLowerCase().endsWith('.mtl'))
    throw Error('Для OBJ вместо материала выбран не MTL-файл');
  const materialText=await materialFile.text();
  // OBJLoader.parse does no network fetch. Materials are bound by usemtl name.
  const manager=new THREE.LoadingManager();
  const urls=[];
  let rejectAssets,resolveAssets,finished=false;
  const loaded=new Promise((resolve,reject)=>{resolveAssets=resolve;rejectAssets=reject});
  manager.onLoad=()=>{finished=true;resolveAssets()};
  manager.onError=url=>rejectAssets(new Error('Не удалось загрузить изображение MTL: '+url));
  manager.setURLModifier(url=>{
    if(/^(https?:|file:|\/\/)/i.test(url))throw Error('Запрещена внешняя ссылка в MTL: '+url);
    if(/^(blob:|data:)/i.test(url))return url;
    const asset=assets.get(basename(url));
    if(!asset)throw Error('Для OBJ не хватает текстуры '+url+'. Выбери изображение вместе с OBJ и MTL.');
    if(!/\.(png|jpe?g|webp|bmp|gif)$/i.test(asset.name))
      throw Error('Неподдерживаемый файл текстуры MTL: '+asset.name);
    const local=URL.createObjectURL(asset);
    urls.push(local);
    return local;
  });
  try{
    const materialCreator=new MTLLoader(manager).setResourcePath('').parse(materialText,'');
    // Preload starts asynchronous texture reads. Wait for completion so
    // consumers can't export an OBJ->GLB before images finish decoding.
    const hasTextures=/^\s*(?:map_kd|map_ks|map_ke|map_d|map_bump|bump|norm)\s+/mi.test(materialText);
    materialCreator.preload();
    basic.setMaterials(materialCreator);
    const root=basic.parse(text);
    if(hasTextures&&!finished)await loaded;
    return {root,clips:[],notice:'OBJ + MTL: материалы и локальные изображения загружены. Экспорт в GLB встраивает текстуры.'};
  }finally{
    for(const u of urls)URL.revokeObjectURL(u);
  }
}

export async function importAdditional(file,data,files=[file]) {
  const ext=file.name.split('.').pop().toLowerCase(), bytes=new Uint8Array(data);
  const name=file.name.replace(/\\.[^.]+$/,'');
  if(['gltf','vrm'].includes(ext)){
    const mapping=fileMap(files,file),urls=[];
    const manager=new THREE.LoadingManager();
    manager.setURLModifier(url=>{
      if(url.startsWith('data:')||url.startsWith('blob:'))return url;
      const asset=mapping.get(basename(url));
      if(!asset) throw Error('Для glTF выбери вместе с .gltf связанные .bin и текстуры: '+url);
      const u=URL.createObjectURL(asset);urls.push(u);return u;
    });
    try{
      const gltf=await new GLTFLoader(manager).parseAsync(ext==='gltf'?decoder.decode(bytes):data,'');
      if(!gltf.scene)throw Error('glTF не содержит 3D-сцены');
      return {root:gltf.scene,clips:gltf.animations||[],
        notice:ext==='vrm'?'VRM: загружены обычные glTF-узлы, геометрия и риг. Специальные VRM-выражения, метаданные и физика при экспорте в GLB могут быть потеряны.':'glTF 2.0: загружена сцена с поддерживаемыми ресурсами.'};
    }finally {urls.forEach(u=>URL.revokeObjectURL(u))}
  }
  if(ext==='obj')return await importObjWithMaterials(file,decoder.decode(bytes),files);
  if(ext==='ply'){
    const geometry=new PLYLoader().parse(data);
    const pointCloud=!geometry.getIndex()&&!geometry.getAttribute('normal');
    return {root:meshScene(geometry,name,pointCloud),clips:[],
      notice:pointCloud?'PLY: облако точек; не является полигональной моделью.':'PLY: геометрия/цвет вершин; нет скелетов или встроенных текстур.'};
  }
  if(ext==='stl')return {root:meshScene(new STLLoader().parse(data),name),clips:[],
    notice:'STL: только поверхность, без текстур, скелета и анимаций.'};
  if(ext==='dae'){
    const result=new ColladaLoader().parse(decoder.decode(bytes),'');
    return {root:result.scene,clips:result.animations||[],
      notice:'COLLADA: поддерживается часть возможностей DAE; внешние изображения могут потребовать дополнительной обработки.'};
  }
  if(ext==='usdz'){
    // Three.js r170 supports USDA-based USDZ archives. Not all USDZ flavors load.
    const model=new USDZLoader().parse(data);
    return {root:model,clips:[],
      notice:'USDZ: импорт USDA-архивов. Бинарные USDC внутри USDZ пока не поддерживаются.'};
  }
  throw Error('Формат '+ext.toUpperCase()+' пока не поддерживается для импорта офлайн');
}
export function getExportWarnings(format, stats) {
  const warnings=[];
  if(LOSSY_EXPORTS.has(format)){
    if(stats.skinned||stats.bones)warnings.push('Скелет и веса костей не сохранятся');
    if(stats.animations)warnings.push('Анимации не сохранятся');
    if(['ply','ply-lite','stl'].includes(format)&&stats.textures)
      warnings.push('Изображения текстур не будут сохранены в файл');
    if(format==='obj'&&stats.textures)
      warnings.push('OBJ ZIP: текстуры включены, но не все просмотрщики понимают PBR-карты из MTL');
    if(format==='obj-mixamo'&&stats.textures)
      warnings.push('Mixamo: сохраняется Albedo/Diffuse; Normal, Metallic и Roughness исключаются');
    if(format==='usdz'&&(stats.skinned||stats.animations))
      warnings.push('USDZ экспортируется только как статичная сцена; для персонажей лучше GLB');
    if(format==='ply-lite')warnings.push('Компактный PLY: нормали, UV и цвета вершин не сохраняются');
  }
  return warnings;
}
export function outputNameExt(format){
  if(format.startsWith('fbx'))return '.fbx';
  if(format==='ply-lite')return '.ply';
  if(format==='obj'||format==='obj-mixamo')return '.zip';
  return '.'+format;
}
export async function exportAdditional(format,root,animations=[],options={}) {
  if(format==='gltf'){
    const gltf=await new GLTFExporter().parseAsync(root,{
      binary:false,trs:true,onlyVisible:false,animations,embedImages:true,
      maxTextureSize:4096,includeCustomExtensions:false
    });
    return {content:JSON.stringify(gltf),mime:'model/gltf+json'};
  }
  if(format==='obj'||format==='obj-mixamo')
    return await exportObjZip(root,{
      baseName:options.name||'model',
      profile:format==='obj-mixamo'?'mixamo':'full'
    });
  if(format==='ply'||format==='ply-lite'){
    // PLYExporter v0.170 invokes its callback on requestAnimationFrame,
    // so the result must be awaited before Android starts saving it.
    const output=await new Promise((resolve,reject)=>{
      try{new PLYExporter().parse(root,result=>resolve(result),{
        binary:true,littleEndian:true,
        excludeAttributes:format==='ply-lite'?['normal','uv','color']:[]
      })}
      catch(error){reject(error)}
    });
    return {content:output,mime:'application/octet-stream'};
  }
  if(format==='stl'){
    // STLExporter binary returns a DataView; normalize it to real bytes.
    const result=new STLExporter().parse(root,{binary:true});
    const content=ArrayBuffer.isView(result)?arrayBuffer(result):result;
    return {content,mime:'model/stl'};
  }
  if(format==='usdz')return {content:await new USDZExporter().parseAsync(root,{
    maxTextureSize:1024,onlyVisible:false,includeAnchoringProperties:false
  }),mime:'model/vnd.usdz+zip'};
  throw Error('Неизвестный выходной формат '+format);
}
export function validateImportFiles(files) {
  if(!files?.length)throw Error('Не выбран файл');
  const main=files.find(f=>SUPPORTED_INPUTS.includes(f.name.split('.').pop().toLowerCase()));
  if(!main)throw Error('Выбери один из поддерживаемых форматов: '+SUPPORTED_INPUTS.join(', '));
  if(main.size>MAX_ASSET_BYTES)throw Error('Файл больше 250 МБ: превышен лимит безопасности Android');
  return main;
}

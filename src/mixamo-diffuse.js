/**
 * Mixamo compatibility profile for FBX 7.2 / 7.3.
 *
 * Blender's successful workflow recreated in the browser:
 *    original GLB MeshStandardMaterial + many PBR slots
 *       -> temporary MeshPhongMaterial with BaseColor map only
 *       -> FBX 2012/2013 with embedded PNG and DiffuseColor connection.
 *
 * No original materials, meshes, UVs, animations or textures are overwritten.
 * We restore the scene even if exporting or writing the FBX fails.
 */
import * as THREE from 'three';
import { verifyLegacyFbxMetadata } from './legacy-fbx.js';

const PNG_MAGIC = [137,80,78,71,13,10,26,10];
function requirePNG(bytes) {
  return bytes?.length > 32 && PNG_MAGIC.every((b,i)=>bytes[i]===b);
}

function rgba8Downscale(source,targetWidth,targetHeight){
  const {data,width,height}=source;
  const scaled=new Uint8Array(targetWidth*targetHeight*4);
  for(let y=0;y<targetHeight;y++){
    const sy=Math.min(height-1,Math.floor(y*height/targetHeight));
    for(let x=0;x<targetWidth;x++){
      const sx=Math.min(width-1,Math.floor(x*width/targetWidth));
      const origin=4*(sy*width+sx),dest=4*(y*targetWidth+x);
      scaled[dest]=data[origin];scaled[dest+1]=data[origin+1];
      scaled[dest+2]=data[origin+2];scaled[dest+3]=data[origin+3];
    }
  }
  return scaled;
}

function reducedAlbedo(texture,maxSize,temps){
  if(!texture?.isTexture)return texture||null;
  const src=texture.image;
  const w=src?.width||src?.naturalWidth||0;
  const h=src?.height||src?.naturalHeight||0;
  if(!w||!h)throw Error('Текстура Albedo не загружена: нет размеров изображения');
  if(Math.max(w,h)<=maxSize)return texture;
  const factor=maxSize/Math.max(w,h),nw=Math.max(1,Math.round(w*factor));
  const nh=Math.max(1,Math.round(h*factor));
  let reduced;
  if(src.data instanceof Uint8Array && src.data.length===w*h*4){
    reduced=new THREE.DataTexture(rgba8Downscale(src,nw,nh),nw,nh,THREE.RGBAFormat);
    reduced.needsUpdate=true;
  }else{
    if(typeof document==='undefined')throw Error('Уменьшение Albedo требует Canvas на Android');
    const canvas=document.createElement('canvas');
    canvas.width=nw;canvas.height=nh;
    const ctx=canvas.getContext('2d');
    if(!ctx)throw Error('Невозможно обработать текстуру Albedo');
    ctx.drawImage(src,0,0,nw,nh);
    reduced=new THREE.CanvasTexture(canvas);
  }
  // Preserve FBX/glTF UV orientation and transforms exactly.
  reduced.name=(texture.name||'Albedo')+'_mixamo';
  reduced.flipY=texture.flipY;
  reduced.wrapS=texture.wrapS;reduced.wrapT=texture.wrapT;
  reduced.offset.copy(texture.offset);reduced.repeat.copy(texture.repeat);
  reduced.rotation=texture.rotation;reduced.center.copy(texture.center);
  reduced.colorSpace=texture.colorSpace||THREE.SRGBColorSpace;
  reduced.channel=texture.channel;
  temps.push(reduced);
  return reduced;
}

function diffuseMaterial(original,uvAvailable,maxSize,temps,textureCache){
  if(!original)return null;
  const sourceMap=original.map?.isTexture?original.map:null;
  if(sourceMap&&!uvAvailable)
    throw Error('У меша есть Albedo-текстура, но отсутствуют UV-координаты');
  let map=null;
  if(sourceMap){
    if(!textureCache.has(sourceMap))
      textureCache.set(sourceMap,reducedAlbedo(sourceMap,maxSize,temps));
    map=textureCache.get(sourceMap);
  }
  // MeshPhongMaterial maps to FbxSurfacePhong / DiffuseColor in the exporter.
  // All Normal/Roughness/Metallic/ORM/Emissive/Bump/Specular maps disappear.
  const result=new THREE.MeshPhongMaterial({
    name:(original.name||'Material')+'_MixamoDiffuse',
    color:original.color?.clone()||new THREE.Color(0xffffff),
    map,
    shininess:0,
    specular:new THREE.Color(0,0,0),
    emissive:new THREE.Color(0,0,0),
    opacity:original.opacity??1,
    transparent:!!original.transparent,
    alphaTest:original.alphaTest||0,
    vertexColors:!!original.vertexColors,
    side:original.side??THREE.FrontSide,
    depthWrite:original.depthWrite!==false
  });
  temps.push(result);
  return result;
}

export function prepareMixamoDiffuse(root,{maxTextureSize=2048}={}){
  if(!root?.traverse)throw Error('Загрузи модель перед конвертацией');
  if(![512,1024,2048,4096].includes(maxTextureSize))
    throw Error('Недопустимое разрешение Albedo');
  const modified=[],temporaries=[],textureCache=new Map();
  let maps=0,meshes=0;
  const restore=()=>{
    for(let i=modified.length-1;i>=0;i--)
      modified[i].object.material=modified[i].material;
    modified.length=0;
    for(const temp of temporaries)temp.dispose();
    temporaries.length=0;
  };
  try{
    root.traverse(object=>{
      if(!object.isMesh&&!object.isSkinnedMesh)return;
      meshes++;
      const original=object.material;
      const uv=!!object.geometry?.getAttribute('uv');
      const materials=Array.isArray(original)?original:[original];
      maps+=materials.filter(m=>m?.map?.isTexture).length;
      const replacement=materials.map(m=>diffuseMaterial(
        m,uv,maxTextureSize,temporaries,textureCache
      ));
      modified.push({object,material:original});
      object.material=Array.isArray(original)?replacement:replacement[0];
    });
    if(meshes<1)throw Error('В модели нет геометрии для FBX');
    return {restore,meshes,maps,maxTextureSize};
  }catch(error){
    restore();
    throw error;
  }
}

/** Ensure the file contains actual DiffuseColor PNG connections, not just PNG blobs. */
export function inspectDiffuseExportPlan(sceneData,expectedMaps=0){
  const textures=Array.from(sceneData.textures?.textures?.values()||[]);
  const connections=sceneData.connections||[];
  if(expectedMaps>0&&textures.length===0)
    throw Error('FBX экспортёр потерял цветные текстуры');
  for(const entry of textures){
    if(entry.slotName!=='map')throw Error('Mixamo профиль сохранил лишнюю PBR-карту: '+entry.slotName);
    if(!requirePNG(entry.imageBytes))
      throw Error('Albedo не встроена в FBX как PNG (ошибка экспорта материалов)');
    if(!connections.some(c=>c[0]==='OP'&&c[1]===entry.texUid&&c[3]==='DiffuseColor'))
      throw Error('Текстура Albedo не привязана к DiffuseColor');
    if(!connections.some(c=>c[0]==='OO'&&c[1]===entry.vidUid&&c[2]===entry.texUid))
      throw Error('Отсутствует связь встроенного PNG с FBX Texture');
  }
  return {textures:textures.length,embeddedPNG:textures.length,
    diffuseConnections:connections.filter(c=>c[0]==='OP'&&c[3]==='DiffuseColor').length};
}

/** Compatibility exporter called only for the old 2012/2013 Mixamo presets. */
export async function exportMixamoDiffuse(root,animations,version,FBXExporterClass,options={}){
  if(![7200,7300].includes(version))throw Error('Профиль Mixamo предназначен для FBX 2012/2013');
  const session=prepareMixamoDiffuse(root,options);
  const exporter=new FBXExporterClass();
  let manifest=null;
  exporter.register(sceneData=>{
    manifest=inspectDiffuseExportPlan(sceneData,session.maps);
  });
  try{
    const bytes=await exporter.parseAsync(root,{
      version,preset:'threejs',flipUV:'auto',fps:30,
      animations,embedTextures:true,onlyVisible:false
    });
    verifyLegacyFbxMetadata(bytes,version);
    if(!manifest)throw Error('Проверка подключения текстур FBX не выполнена');
    return {bytes,manifest,sourceMaps:session.maps};
  }finally{
    session.restore();
  }
}

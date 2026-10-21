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


/**
 * Meshy/GLB commonly packs the UV islands in a 1/16 tile and stores a
 * 16x repeat + offset in KHR_texture_transform (Three.Texture.matrix).
 * Mixamo may ignore the FBX Texture.Translation/Scaling fields.
 * Bake that matrix into *temporary* geometry UVs and emit an identity FBX
 * texture transform. Use a whole-tile shift so an atlas at UV 15..16 is
 * moved to UV 0..1 without breaking seams across triangles.
 */
export function bakeDiffuseUV(object, originalMaps, temps) {
  const originals = originalMaps.filter(t=>t?.isTexture);
  if (!originals.length) return {changed:false, restore:()=>{}};
  const original = originals[0];
  original.updateMatrix();
  const transform = original.matrix.clone();
  const channel = original.channel??0;
  for (const other of originals.slice(1)) {
    other.updateMatrix();
    if ((other.channel??0)!==channel ||
        !other.matrix.elements.every((v,i)=>Math.abs(v-transform.elements[i])<1e-6))
      throw Error('У меша разные преобразования Albedo в нескольких материалах. Нужна разбивка материалов — безопасный FBX не создан.');
  }
  const attributeName=channel===0?'uv':channel===1?'uv1':channel===2?'uv2':channel===3?'uv3':null;
  const uv=attributeName&&object.geometry?.getAttribute(attributeName);
  if(!uv||uv.itemSize!==2)
    throw Error('Albedo использует UV-канал '+channel+', но этот канал отсутствует в геометрии');
  // Convert transform into an attribute on a disposable geometry copy.
  const geo=object.geometry.clone();
  const baked=uv.clone();
  const sample=new THREE.Vector2();
  let minU=Infinity,minV=Infinity,maxU=-Infinity,maxV=-Infinity;
  for(let i=0;i<baked.count;i++){
    sample.set(uv.getX(i),uv.getY(i)).applyMatrix3(transform);
    if(!Number.isFinite(sample.x)||!Number.isFinite(sample.y))
      throw Error('Неверные UV-координаты после преобразования текстуры');
    baked.setXY(i,sample.x,sample.y);
    minU=Math.min(minU,sample.x);maxU=Math.max(maxU,sample.x);
    minV=Math.min(minV,sample.y);maxV=Math.max(maxV,sample.y);
  }
  if(!baked.count){geo.dispose();throw Error('У модели пустая UV-развёртка');}
  // Remove only global integer tile offsets. Keep the triangle topology
  // and any true multi-tile repeats intact.
  // Slight rounding in imported KHR_texture_transform can put the first
  // UV at 14.989 instead of 15.0. Prefer the nearest tile when very close
  // to its integer boundary so Mixamo receives an atlas in ~0..1 rather
  // than ~1..2 (which depends on its sampler wrapping).
  const tileShift = minimum => {
    const nearest=Math.round(minimum);
    return Math.abs(minimum-nearest)<0.05?nearest:Math.floor(minimum);
  };
  const shiftU=tileShift(minU);
  const shiftV=tileShift(minV);
  for(let i=0;i<baked.count;i++)baked.setXY(i,baked.getX(i)-shiftU,baked.getY(i)-shiftV);
  baked.needsUpdate=true;
  geo.setAttribute('uv',baked);
  const originalGeometry=object.geometry;
  object.geometry=geo;
  temps.push(geo);
  return {
    changed:Math.abs(transform.elements[0]-1)>1e-6 ||
      Math.abs(transform.elements[4]-1)>1e-6 ||
      transform.elements.some((v,i)=>(i===6||i===7)&&Math.abs(v)>1e-6),
    sourceSpan:[minU,maxU,minV,maxV],
    tileShift:[shiftU,shiftV],
    restore:()=>{object.geometry=originalGeometry}
  };
}

function diffuseMaterial(original,uvAvailable,maxSize,temps,textureCache){
  if(!original)return null;
  const sourceMap=original.map?.isTexture?original.map:null;
  if(sourceMap&&!uvAvailable)
    throw Error('У меша есть Albedo-текстура, но отсутствуют UV-координаты');
  let map=null;
  if(sourceMap){
    if(!textureCache.has(sourceMap)){
      const texture=reducedAlbedo(sourceMap,maxSize,temps).clone();
      // UVs have been baked into a copy of the geometry; FBX must NOT
      // specify its old 16x repeat / offset a second time.
      texture.offset.set(0,0);
      texture.repeat.set(1,1);
      texture.rotation=0;
      texture.center.set(0,0);
      texture.channel=0;
      texture.updateMatrix();
      texture.name=(sourceMap.name||'Albedo')+'_Mixamo_UVBaked';
      temps.push(texture);
      textureCache.set(sourceMap,texture);
    }
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
  let maps=0,meshes=0,uvBaked=0;
  const restore=()=>{
    for(let i=modified.length-1;i>=0;i--){
      modified[i].object.material=modified[i].material;
      modified[i].object.geometry=modified[i].geometry;
    }
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
      const sourceMaps=materials.map(m=>m?.map||null);
      // Bake while the original material and original geometry are available.
      const originalGeometry=object.geometry;
      modified.push({object,material:original,geometry:originalGeometry});
      const operation=bakeDiffuseUV(object,sourceMaps,temporaries);
      if(operation.changed)uvBaked++;
      const replacement=materials.map(m=>diffuseMaterial(
        m,uv,maxTextureSize,temporaries,textureCache
      ));
      object.material=Array.isArray(original)?replacement:replacement[0];
    });
    if(meshes<1)throw Error('В модели нет геометрии для FBX');
    return {restore,meshes,maps,uvBaked,maxTextureSize};
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


/**
 * Auto-rig inputs must contain visible meshes, not FBX Null->Null->Mesh
 * parent chains. Adobe Mixamo can confuse that parent chain with a rig.
 * Clone only the mesh objects, preserve their world transforms exactly,
 * and filter the temporary group out of FBX object serialization.
 *
 * Skinned / animated imports are deliberately not flattened.
 */
export function createMixamoAutorigInput(root, animations=[]) {
  const meshes=[],bones=[];
  root.traverse(object=>{
    if(object.isBone||object.isSkinnedMesh)bones.push(object);
    if(object.isMesh)meshes.push(object);
  });
  if(bones.length||animations.length)
    return {input:root,flat:false,meshes:meshes.length};
  if(!meshes.length)throw Error('Для Mixamo в модели нет геометрии');
  // The installed FBX exporter version still serializes its Group root as
  // a "Null" Model even when objectFilter excludes it. Send the Mesh
  // directly. For multiple meshes keep the original hierarchy rather than
  // silently losing garments/parts; a later merge workflow can address it.
  if(meshes.length!==1)return {input:root,flat:false,meshes:meshes.length};
  root.updateMatrixWorld(true);
  const flatRoot=new THREE.Group();
  flatRoot.name='MixamoExportOnly';
  const position=new THREE.Vector3(),rotation=new THREE.Quaternion(),scale=new THREE.Vector3();
  const recomposed=new THREE.Matrix4();
  for(const mesh of meshes){
    mesh.matrixWorld.decompose(position,rotation,scale);
    recomposed.compose(position,rotation,scale);
    const a=mesh.matrixWorld.elements,b=recomposed.elements;
    if(a.some((v,i)=>Math.abs(v-b[i])>1e-3*Math.max(1,Math.abs(v))))
      throw Error('Сложные родительские трансформации модели нельзя безопасно удалить для Mixamo');
    const clone=mesh.clone(false);
    clone.position.copy(position);clone.quaternion.copy(rotation);clone.scale.copy(scale);
    flatRoot.add(clone);
  }
  return {input:flatRoot.children[0],flat:true,meshes:1};
}

/** Compatibility exporter called only for the old 2012/2013 Mixamo presets. */
export async function exportMixamoDiffuse(root,animations,version,FBXExporterClass,options={}){
  if(![7200,7300].includes(version))throw Error('Профиль Mixamo предназначен для FBX 2012/2013');
  const session=prepareMixamoDiffuse(root,options);
  const exporter=new FBXExporterClass();
  let manifest=null,autorig;
  try{
    autorig=createMixamoAutorigInput(root,animations);
    exporter.register(sceneData=>{
      manifest=inspectDiffuseExportPlan(sceneData,session.maps);
      if(autorig.flat && sceneData.empties.length)
        throw Error('В FBX остались пустые родительские узлы, несовместимые с авториггингом Mixamo');
      if(autorig.flat && sceneData.meshes.length!==autorig.meshes)
        throw Error('Потеряна геометрия при очистке иерархии Mixamo');
    });
    const bytes=await exporter.parseAsync(autorig.input,{
      version,preset:'threejs',flipUV:'auto',fps:30,
      animations,embedTextures:true,onlyVisible:false,
      // The temporary group only holds detached meshes. Never serialize
      // a root-level Null node that Mixamo might interpret as skeleton.
      objectFilter:autorig.flat?object=>object.isMesh:undefined
    });
    verifyLegacyFbxMetadata(bytes,version);
    if(!manifest)throw Error('Проверка подключения текстур FBX не выполнена');
    return {bytes,manifest,sourceMaps:session.maps,uvBaked:session.uvBaked,
      flatMeshHierarchy:!!autorig?.flat};
  }finally{
    session.restore();
  }
}

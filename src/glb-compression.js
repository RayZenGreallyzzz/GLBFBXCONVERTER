// Optional storage codecs. Never simplify geometry, remove rig data, or touch source bytes.
import {EXTMeshoptCompression,KHRDracoMeshCompression,KHRTextureBasisu} from '@gltf-transform/extensions';
import {getTextureColorSpace,listTextureSlots} from '@gltf-transform/functions';
import {createCodecIO,removeGeometryCompression} from './codec-io.js';
import {asBytes} from './binary.js';

function hash(array){
 if(!array)return null;
 const bytes=new Uint8Array(array.buffer,array.byteOffset,array.byteLength);
 let h=2166136261;
 for(const b of bytes)h=Math.imul(h^b,16777619)>>>0;
 return [array.constructor.name,array.length,h];
}
function snapshot(document){
 const root=document.getRoot();
 return JSON.stringify({
  meshes:root.listMeshes().map(m=>m.listPrimitives().map(p=>({mode:p.getMode(),
   indices:p.getIndices()?.getCount()||p.getAttribute('POSITION')?.getCount()||0,
   semantics:p.listSemantics().sort(),targets:p.listTargets().map(t=>t.listSemantics().sort())}))),
  skins:root.listSkins().map(s=>({joints:s.listJoints().map(n=>n.getName()),
   matrices:hash(s.getInverseBindMatrices()?.getArray())})),
  animations:root.listAnimations().map(a=>({name:a.getName(),
   channels:a.listChannels().map(c=>({node:c.getTargetNode()?.getName(),path:c.getTargetPath(),
    interpolation:c.getSampler()?.getInterpolation(),
    input:hash(c.getSampler()?.getInput()?.getArray()),output:hash(c.getSampler()?.getOutput()?.getArray())}))})),
  materials:root.listMaterials().length,textures:root.listTextures().length
 });
}
export async function compressGlb(input,{geometryCodec='keep',textureCodec='keep',
 maxTextureSize=1024,onProgress=()=>{}}={}){
 if(!['keep','none','meshopt','draco'].includes(geometryCodec)||
  !['keep','etc1s','uastc'].includes(textureCodec))throw Error('Неизвестный способ сжатия');
 const source=asBytes(input);
 if(geometryCodec==='keep'&&textureCodec==='keep')return {bytes:source,codecNote:''};
 const io=await createCodecIO(source,{dracoEncode:geometryCodec==='draco'});
 onProgress(5,'Читаем модель для сжатия…');
 const document=await io.readBinary(source),before=snapshot(document);
 const notes=[];
 if(geometryCodec!=='keep'){
  removeGeometryCompression(document);
  if(geometryCodec==='meshopt'){
   // No reorder/quantize transform: positions, UV, bone weights and animation
   // values stay exact. QUANTIZE here means no lossy Meshopt filters.
   document.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
   notes.push('Meshopt: данные без дополнительного квантования');
  }else if(geometryCodec==='draco'){
   if(!document.getRoot().listMeshes().some(m=>m.listPrimitives().some(p=>p.getMode()===4)))
    throw Error('Draco требует полигональную модель из треугольников');
   document.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
    method:KHRDracoMeshCompression.EncoderMethod.SEQUENTIAL,encodeSpeed:5,decodeSpeed:5,
    quantizationBits:{POSITION:20,NORMAL:12,TEX_COORD:16,COLOR:12,GENERIC:0}
   });
   notes.push('Draco: высокая точность; костные веса без квантования');
  }else notes.push('Сжатие геометрии снято');
 }else{
  // readBinary decodes the input; preserve its codec when only texture mode changes.
  const existing=document.getRoot().listExtensionsUsed().find(e=>e.extensionName==='KHR_draco_mesh_compression');
  if(existing){
   io.registerDependencies({'draco3d.encoder':await (await import('./codec-io.js')).getDracoModule('encoder')});
   // Texture-only edits must not add another lossy geometry quantization pass.
   existing.setEncoderOptions({method:KHRDracoMeshCompression.EncoderMethod.SEQUENTIAL,
    quantizationBits:{POSITION:0,NORMAL:0,TEX_COORD:0,COLOR:0,GENERIC:0}});
  }
 }
 if(textureCodec!=='keep'){
  const {decodeTexture,resizePixels,encodeKtx2}=await import('./texture-codecs.js');
  const textures=document.getRoot().listTextures();
  if(!textures.length)throw Error('В модели нет изображений для сжатия KTX2');
  for(let i=0;i<textures.length;i++){
   const texture=textures[i],slots=listTextureSlots(texture);
   const color=slots.some(s=>/color|emissive|diffuse/i.test(s));
   const dataMap=slots.some(s=>!/color|emissive|diffuse/i.test(s));
   if(color&&dataMap)throw Error('Одна текстура используется одновременно как цвет и данные: раздели её перед KTX2');
   onProgress(15+Math.round(i/textures.length*60),'KTX2: текстура '+(i+1)+' из '+textures.length+'…');
   const decoded=await decodeTexture(texture.getImage(),texture.getMimeType());
   const image=resizePixels(decoded,Math.min(2048,Math.max(4,maxTextureSize)));
   // Normal/ORM maps use UASTC even with ETC1S color mode, preserving detail.
   const mode=dataMap?'uastc':textureCodec;
   const encoded=await encodeKtx2(image,{mode,srgb:getTextureColorSpace(texture)==='srgb',
    normal:slots.some(s=>/normal/i.test(s))});
   texture.setImage(encoded).setMimeType('image/ktx2');
  }
  for(const ext of document.getRoot().listExtensionsUsed())
   if(['EXT_texture_webp','EXT_texture_avif'].includes(ext.extensionName))ext.dispose();
  document.createExtension(KHRTextureBasisu).setRequired(true);
  notes.push('KTX2 '+textureCodec.toUpperCase()+'; normal/ORM — UASTC; максимум 2048 px');
 }
 onProgress(85,'Кодируем и проверяем результат…');
 const bytes=await io.writeBinary(document);
 const verifyIO=await createCodecIO(bytes);
 const reopened=await verifyIO.readBinary(bytes);
 if(snapshot(reopened)!==before)throw Error('Проверка обнаружила изменение геометрии, скелета, анимаций или материалов. Сохранение отменено.');
 onProgress(100,'Сжатый GLB проверен');
 return {bytes,codecNote:notes.join('. ')+'.'+(bytes.length>=source.length
  ?' На этой модели кодек не уменьшил размер файла.':'')};
}

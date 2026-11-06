import {prune} from '@gltf-transform/functions';
import {PropertyType} from '@gltf-transform/core';
import {readBakeGlb,bakePlan,bakePrimitives,assertBakeRigPreserved} from './bake-common.js';
import {primitiveGeometry,packedProjectionSource} from './bake-geometry.js';
import {projectBakePixels,transformUV} from './bake-pixels.js';
import {geometryTargetNote,optimizationHistory,HISTORY_KEY} from './geometry-policy.js';
import {countTriangles,countAnimationKeys} from './glb-optimize.js';
import {captureMorphs,assertMorphRows,morphMaps,resampleWithMorphs} from './morph-policy.js';
export async function decodeBakeImage(texture,{maxSize=2048}={}){
 const mime=texture.getMimeType(),bytes=texture.getImage();
 if(mime==='image/ktx2'){
  if(Math.max(...texture.getSize())>4096)throw Error('KTX2-источник больше 4096 px: уменьши текстуру перед переносом');
  const {decodeKtx2}=await import('./texture-codecs.js');return decodeKtx2(bytes);
 }
 if(!['image/png','image/jpeg','image/webp'].includes(mime)||typeof createImageBitmap!=='function'||typeof OffscreenCanvas==='undefined')throw Error('Этот Android WebView не поддерживает фоновый перенос текстур. Обнови Android System WebView.');
 const size=texture.getSize(),factor=Math.min(1,maxSize/Math.max(...size)),width=Math.max(1,Math.round(size[0]*factor)),height=Math.max(1,Math.round(size[1]*factor));
 const bitmap=await createImageBitmap(new Blob([bytes],{type:mime}),{resizeWidth:width,resizeHeight:height,resizeQuality:'high',premultiplyAlpha:'none',colorSpaceConversion:'none'});
 try{
  const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)throw Error('Недоступна фоновая обработка изображений');
  ctx.drawImage(bitmap,0,0,width,height);return {data:ctx.getImageData(0,0,width,height).data,width,height};
 }finally{bitmap.close()}
}
export async function encodeBakeImage({data,width,height,kind,opaque}){
 const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');if(!ctx)throw Error('Недоступен фоновый Canvas');
 ctx.putImageData(new ImageData(data,width,height),0,0);
 const mime=kind==='base'&&opaque?'image/jpeg':'image/png',blob=await canvas.convertToBlob({type:mime,quality:.94});
 return {image:new Uint8Array(await blob.arrayBuffer()),mimeType:blob.type};
}
async function textureMaps(material,decode){
 const result={},cache=new Map();
 for(const [slot,name]of [['base','BaseColor'],['normal','Normal'],['orm','MetallicRoughness'],['occlusion','Occlusion'],['emissive','Emissive']]){
  const texture=material?.['get'+name+'Texture']();if(!texture)continue;
  const info=material['get'+name+'TextureInfo'](),ext=info.getExtension('KHR_texture_transform'),origin=transformUV(info,0,0),x=transformUV(info,1,0),y=transformUV(info,0,1);
  if(!cache.has(texture))cache.set(texture,await decode(texture));const image=cache.get(texture);
  if(!image?.width||!image?.height||image.data?.length!==image.width*image.height*4)throw Error('Декодер текстуры вернул неверные пиксели');
  result[slot]={...image,coord:ext?.getTexCoord()??info.getTexCoord(),matrix:[x[0]-origin[0],x[1]-origin[1],y[0]-origin[0],y[1]-origin[1],...origin],wrapS:info.getWrapS(),wrapT:info.getWrapT()};
 }
 return result;
}
function textureInfo(material,name){const info=material['get'+name+'TextureInfo']();if(info){info.setTexCoord(0).setWrapS(33071).setWrapT(33071);info.setExtension('KHR_texture_transform',null);}}
export async function projectBakeGlb(original,prepared,options={}){
 const progress=options.onProgress||(()=>{}),decode=options.decodeImage||decodeBakeImage,encode=options.encodeImage||encodeBakeImage;progress(2,'Строим проекцию деталей исходника…');
 const donor=await readBakeGlb(original,options),low=await readBakeGlb(prepared.bytes),plan=bakePlan(donor.document,original.byteLength,options);
 if(plan.unchanged)throw Error('Для переноса нужна уменьшенная сетка');assertBakeRigPreserved(donor.document,low.document);
 const morph=captureMorphs(donor.document);if(morph.parts.length)assertMorphRows(morph,low.document,{baked:true});
 const from=bakePrimitives(donor.document),to=bakePrimitives(low.document),reports=[];if(from.length!==to.length)throw Error('Изменилось число частей модели');const root=low.document.getRoot();
 for(let i=0;i<from.length;i++){
  const source=(from[i].getIndices()?.getCount()||from[i].getAttribute('POSITION').getCount())>786432?packedProjectionSource(from[i]):primitiveGeometry(from[i]),target=primitiveGeometry(to[i]);target.uv=target.uv[0];target.margin=Math.max(4,Math.round(plan.resolution/128));
  const material=from[i].getMaterial(),maps=await textureMaps(material,t=>decode(t,{maxSize:options.lowMemory?Math.max(1024,plan.resolution):2048}));if(!target.tangents||!target.uv)throw Error('Не подготовлена UV-развёртка результата');
  progress(5+75*i/from.length,'Переносим поверхность части '+(i+1)+'/'+from.length+'…');
  const baked=projectBakePixels(source,target,{size:plan.resolution,maps,normalScale:material?.getNormalScale()??1,onProgress:p=>progress(5+75*(i+p)/from.length,'Перенос деталей: часть '+(i+1)+'/'+from.length+', '+Math.round(p*100)+'%')});
  const result=low.document.createMaterial((material?.getName()||'Material')+'_baked');
  if(material)result.setExtras(material.getExtras()).setBaseColorFactor(material.getBaseColorFactor()).setMetallicFactor(material.getMetallicFactor()).setRoughnessFactor(material.getRoughnessFactor()).setDoubleSided(material.getDoubleSided()).setAlphaMode(material.getAlphaMode()).setAlphaCutoff(material.getAlphaCutoff()).setEmissiveFactor(material.getEmissiveFactor()).setOcclusionStrength(material.getOcclusionStrength());
  for(const [kind,data]of Object.entries(baked.maps)){
   const encoded=await encode({data,width:plan.resolution,height:plan.resolution,kind,opaque:!material||material.getAlphaMode()==='OPAQUE'});
   const texture=low.document.createTexture('Baked_'+kind+'_'+i).setImage(encoded.image).setMimeType(encoded.mimeType);
   if(kind==='base'){result.setBaseColorTexture(texture);textureInfo(result,'BaseColor');}
   if(kind==='normal'){result.setNormalTexture(texture).setNormalScale(1);textureInfo(result,'Normal');}
   if(kind==='orm'){result.setMetallicRoughnessTexture(texture);textureInfo(result,'MetallicRoughness');if(maps.occlusion){result.setOcclusionTexture(texture);textureInfo(result,'Occlusion');}}
   if(kind==='emissive'){result.setEmissiveTexture(texture);textureInfo(result,'Emissive');}
  }
  to[i].setMaterial(result).setAttribute('_PHOENIX_PROJECTION_NORMAL',null);reports.push({coverage:baked.coverage,projected:baked.projected,misses:baked.misses});source.geometry?.dispose();target.geometry.dispose();
 }
 const sourceTriangles=countTriangles(donor.document),optimizedTriangles=countTriangles(low.document),keys=countAnimationKeys(low.document);if(options.animationKeys)await resampleWithMorphs(low.document);
 const morphMap=morph.parts.length?morphMaps(low.document,{remove:true}):null;
 const removedKeys=keys-countAnimationKeys(low.document),history=optimizationHistory(sourceTriangles,optimizedTriangles,plan.targetTriangles,plan.error);
 history.surfaceBake={version:1,resolution:plan.resolution,regularizedParts:prepared.regularizedParts||0,projectionMisses:reports.reduce((n,r)=>n+r.misses,0)};root.setExtras({...root.getExtras(),[HISTORY_KEY]:history});
 await low.document.transform(prune({propertyTypes:[PropertyType.ACCESSOR,PropertyType.MATERIAL,PropertyType.TEXTURE,PropertyType.BUFFER],keepAttributes:true,keepExtras:false,keepSolidTextures:true}));
 for(const e of root.listExtensionsUsed()){
  if(e.extensionName==='EXT_texture_webp'&&!root.listTextures().some(t=>t.getMimeType()==='image/webp'))e.dispose();
  if(e.extensionName==='KHR_texture_basisu'&&!root.listTextures().some(t=>t.getMimeType()==='image/ktx2'))e.dispose();
  if(['KHR_mesh_quantization','KHR_texture_transform'].includes(e.extensionName))e.dispose();
 }
 progress(90,'Проверяем кости, отдельные анимации и готовый GLB…');const bytes=await low.io.writeBinary(low.document),reopened=await low.io.readBinary(bytes);
 assertBakeRigPreserved(donor.document,reopened,{animationKeys:!!options.animationKeys});
 if(morph.parts.length)assertMorphRows(morph,reopened,{maps:morphMap,baked:true});
 if(countTriangles(reopened)!==optimizedTriangles||!reopened.getRoot().listTextures().length)throw Error('Готовый GLB не прошёл проверку');
 return {bytes,beforeBytes:original.byteLength,afterBytes:bytes.byteLength,sourceTriangles,optimizedTriangles,targetTriangles:plan.targetTriangles,textureLimit:plan.resolution,skins:root.listSkins().length,animations:root.listAnimations().length,removedKeys,unchanged:false,bakeReports:reports,codecSuffix:'_baked',note:'Детали перенесены с оригинала на новые карты '+plan.resolution+' px. Все пиксели поверхности спроецированы. Кости, веса и привязки анимаций сохранены. '+geometryTargetNote(plan.targetTriangles,optimizedTriangles)};
}

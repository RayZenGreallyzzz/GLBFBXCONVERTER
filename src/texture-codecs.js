import {encodeToKTX2} from 'ktx2-encoder';
import {localCodecURL} from './codec-io.js';

let basisPending;
async function getBasis(){
 if(!basisPending)basisPending=(async()=>{
  if(typeof process!=='undefined'&&process.versions?.node){
   const name='ktx2-encoder';
   const {NodeBasisEncoder}=await import(/* @vite-ignore */ name);
   return new NodeBasisEncoder().init();
  }
  const url=localCodecURL('basis/transcoder.js');
  const {default:factory}=await import(/* @vite-ignore */ url);
  const response=await fetch(localCodecURL('basis/basis_transcoder.wasm'));
  if(!response.ok)throw Error('Не найден локальный транскодер KTX2');
  const module=await factory({wasmBinary:await response.arrayBuffer()});
  module.initializeBasis();return module;
 })().catch(e=>{basisPending=null;throw e});
 return basisPending;
}
export async function decodeKtx2(bytes){
 const basis=await getBasis(),file=new basis.KTX2File(bytes);
 try{
  if(!file.isValid()||file.getFaces()!==1||file.getLayers()>1||file.isHDR?.())
   throw Error('Поддерживаются только обычные 2D KTX2 ETC1S/UASTC без HDR');
  const width=file.getWidth(),height=file.getHeight();
  if(!width||!height||width*height>4096*4096)
   throw Error('KTX2 больше 4096×4096: распаковка отменена для защиты памяти');
  if(!file.startTranscoding())throw Error('Не удалось распаковать KTX2');
  const data=new Uint8Array(file.getImageTranscodedSizeInBytes(0,0,0,13));
  if(!file.transcodeImage(data,0,0,0,13,0,-1,-1))throw Error('Ошибка декодирования KTX2');
  return {width,height,data};
 }finally{file.close();file.delete()}
}
function surface(width,height){
 const canvas=typeof OffscreenCanvas!=='undefined'
  ?new OffscreenCanvas(width,height):globalThis.document?.createElement('canvas');
 if(!canvas)throw Error('Для обработки текстур требуется Canvas');
 canvas.width=width;canvas.height=height;
 return canvas;
}
export async function decodeTexture(bytes,mime){
 if(mime==='image/ktx2')return decodeKtx2(bytes);
 if(!['image/png','image/jpeg','image/webp'].includes(mime))
  throw Error('Неподдерживаемый формат текстуры: '+mime);
 const bitmap=await createImageBitmap(new Blob([bytes],{type:mime}),
  {premultiplyAlpha:'none',colorSpaceConversion:'none'});
 try{
  if(bitmap.width*bitmap.height>4096*4096)
   throw Error('Текстура больше 4096×4096: сначала уменьши её разрешение');
  const canvas=surface(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(!ctx)throw Error('Canvas 2D недоступен');
  ctx.drawImage(bitmap,0,0);
  return {width:bitmap.width,height:bitmap.height,
   data:new Uint8Array(ctx.getImageData(0,0,bitmap.width,bitmap.height).data)};
 }finally{bitmap.close()}
}
export function resizePixels(image,maxSize){
 const scale=Math.min(1,maxSize/Math.max(image.width,image.height));
 // KHR_texture_basisu requires base dimensions divisible by four.
 const width=Math.max(4,Math.floor(image.width*scale/4)*4);
 const height=Math.max(4,Math.floor(image.height*scale/4)*4);
 if(width===image.width&&height===image.height)return image;
 const source=surface(image.width,image.height),ctx=source.getContext('2d');
 ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data),image.width,image.height),0,0);
 const canvas=surface(width,height),dest=canvas.getContext('2d',{willReadFrequently:true});
 dest.drawImage(source,0,0,width,height);
 return {width,height,data:new Uint8Array(dest.getImageData(0,0,width,height).data)};
}
export async function encodeKtx2(image,{mode='uastc',srgb=false,normal=false}={}){
 if(!['uastc','etc1s'].includes(mode))throw Error('Неизвестный режим KTX2');
 if(image.width*image.height>2048*2048||image.data.length!==image.width*image.height*4)
  throw Error('Кодирование KTX2 ограничено 2048×2048 для защиты памяти Android');
 const options={isUASTC:mode==='uastc',isKTX2File:true,generateMipmap:true,
  isYFlip:false,isPerceptual:srgb,isSetKTX2SRGBTransferFunc:srgb,
  isNormalMap:normal,qualityLevel:180,compressionLevel:1,uastcLDRQualityLevel:1,
  needSupercompression:mode==='uastc',enableRDO:false,enableDebug:false,
  imageDecoder:async()=>image};
 if(!(typeof process!=='undefined'&&process.versions?.node))
  options.wasmUrl=localCodecURL('ktx2/basis_encoder.wasm');
 return encodeToKTX2(new Uint8Array(0),options);
}

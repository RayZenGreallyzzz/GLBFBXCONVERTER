import {WebIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder,MeshoptEncoder} from 'meshoptimizer';
import {inspectGlb} from './format.js';

const pending=new Map();
export function localCodecURL(path){
 return new URL('/codecs/'+path,globalThis.location.origin).href;
}
export async function getDracoModule(kind){
 if(!['decoder','encoder'].includes(kind))throw Error('Unknown Draco module');
 if(!pending.has(kind))pending.set(kind,(async()=>{
  if(typeof process!=='undefined'&&process.versions?.node){
   const name='draco3dgltf';
   const {default:draco}=await import(/* @vite-ignore */ name);
   return kind==='encoder'?draco.createEncoderModule():draco.createDecoderModule();
  }
  const url=localCodecURL('draco/'+kind+'.js');
  const {default:factory}=await import(/* @vite-ignore */ url);
  const wasm=kind==='encoder'?'draco_encoder.wasm':'draco_decoder_gltf.wasm';
  const response=await fetch(localCodecURL('draco/'+wasm));
  if(!response.ok)throw Error('Не найден локальный кодек Draco: '+response.status);
  return await factory({wasmBinary:await response.arrayBuffer()});
 })().catch(e=>{pending.delete(kind);throw e}));
 return pending.get(kind);
}
export async function createCodecIO(bytes,{dracoEncode=false}={}){
 await MeshoptDecoder.ready;
 await MeshoptEncoder.ready;
 const io=new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder':MeshoptDecoder,'meshopt.encoder':MeshoptEncoder
 });
 const json=inspectGlb(bytes).json;
 if((json.extensionsUsed||[]).includes('KHR_draco_mesh_compression'))
  io.registerDependencies({'draco3d.decoder':await getDracoModule('decoder')});
 if(dracoEncode)io.registerDependencies({'draco3d.encoder':await getDracoModule('encoder')});
 return io;
}
export function removeGeometryCompression(document){
 for(const ext of document.getRoot().listExtensionsUsed())
  if(['KHR_draco_mesh_compression','EXT_meshopt_compression'].includes(ext.extensionName))ext.dispose();
}

import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openEmbeddedMotions} from '../src/embedded-motions.js';
import {inspectGlb} from '../src/format.js';
export async function verifyMotionLibrary(directory){
 const entries=await openEmbeddedMotions({fetcher:async url=>{
  try{return new Response(await readFile(join(directory,url.slice('/motions/'.length))))}catch{return new Response('',{status:404})}
 }});
 for(const entry of entries){
  const bytes=await entry.read();if(createHash('sha256').update(bytes).digest('hex')!==entry.id)throw Error('Не совпал хеш движения '+entry.title);
  const json=inspectGlb(bytes).json;
  if(json.animations?.length!==1||!json.animations[0].channels?.length||['meshes','materials','textures','images'].some(key=>json[key]?.length))throw Error('Ожидается одно движение без геометрии и текстур: '+entry.title);
 }
 return entries.length;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{console.log('Verified '+await verifyMotionLibrary(resolve(process.argv[2]||'public/motions'))+' embedded clips.')}catch(error){console.error('Embedded motion assets are required before APK packaging. '+error.message);process.exitCode=1}
}

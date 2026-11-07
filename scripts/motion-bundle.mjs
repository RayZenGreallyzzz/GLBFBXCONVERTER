import {readFile,writeFile,mkdir,readdir,rm,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {zipSync,unzipSync} from 'fflate';
import {motionPath} from '../src/motion-pack.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function walk(directory,prefix=''){
 const files=[];for(const child of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){const name=prefix+child.name;if(child.isDirectory())files.push(...await walk(join(directory,child.name),name+'/'));else if(child.isFile())files.push(name)}return files;
}
export async function packMotionBundle(source,destination,{partBytes=1048576}={}){
 const entries={};for(const name of await walk(source))entries[name]=[new Uint8Array(await readFile(join(source,name))),{mtime:new Date('2020-01-01T00:00:00Z')}];
 const archive=zipSync(entries,{level:6}),manifest=JSON.parse(new TextDecoder().decode(entries['index.json'][0]));
 if(!manifest.clips?.length)throw Error('Cannot package an empty library');
 await mkdir(destination,{recursive:true});for(const name of await readdir(destination))if(/^motion-data-\d+\.bin$/.test(name))await rm(join(destination,name));
 const parts=[];for(let offset=0;offset<archive.length;offset+=partBytes){const data=archive.subarray(offset,offset+partBytes),file='motion-data-'+String(parts.length+1).padStart(3,'0')+'.bin';await writeFile(join(destination,file),data);parts.push({file,bytes:data.length,sha256:sha(data)})}
 const bundle={version:1,clipCount:manifest.clips.length,archiveBytes:archive.length,archiveSha256:sha(archive),parts};await writeFile(join(destination,'bundle.json'),JSON.stringify(bundle,null,2)+'\n');return bundle;
}
export async function unpackMotionBundle(source,destination){
 const manifest=JSON.parse(await readFile(join(source,'bundle.json'),'utf8'));
 if(manifest.version!==1||!manifest.parts?.length||!manifest.clipCount)throw Error('Invalid motion bundle');
 const chunks=[];for(const part of manifest.parts){if(!/^motion-data-\d+\.bin$/.test(part.file))throw Error('Invalid bundle part path');const bytes=await readFile(join(source,part.file));if(bytes.length!==part.bytes||sha(bytes)!==part.sha256)throw Error('Corrupted motion bundle part '+part.file);chunks.push(bytes)}
 const archive=Buffer.concat(chunks);if(archive.length!==manifest.archiveBytes||sha(archive)!==manifest.archiveSha256)throw Error('Corrupted motion bundle archive');
 const entries=unzipSync(archive),index=JSON.parse(new TextDecoder().decode(entries['index.json']));if(index.clips?.length!==manifest.clipCount)throw Error('Motion bundle clip count mismatch');
 const temporary=destination+'.unpacking';await rm(temporary,{recursive:true,force:true});await mkdir(temporary,{recursive:true});
 try{for(const [name,bytes]of Object.entries(entries)){const safe=motionPath(name);if(safe.endsWith('/'))continue;const path=join(temporary,safe);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,bytes)}
  await rm(destination,{recursive:true,force:true});await rename(temporary,destination);
 }catch(error){await rm(temporary,{recursive:true,force:true});throw error}
 return manifest.clipCount;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv[2]==='pack'){const result=await packMotionBundle(resolve(process.argv[3]||'public/motions'),resolve(process.argv[4]||'motion-library'));console.log('Packed '+result.clipCount+' clips in '+result.parts.length+' verified parts ('+result.archiveBytes+' bytes).')}
 else if(process.argv[2]==='unpack')console.log('Prepared '+await unpackMotionBundle(resolve(process.argv[3]||'motion-library'),resolve(process.argv[4]||'public/motions'))+' built-in clips.');else throw Error('Expected pack or unpack')}
 catch(error){console.error(error.message);process.exitCode=1}
}

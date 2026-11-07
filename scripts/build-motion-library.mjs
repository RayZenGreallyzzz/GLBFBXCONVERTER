// Build one mesh-free GLB per unique skeletal clip from local ZIP/GLB/FBX/BVH
// inputs. Names never decide deduplication: hierarchy, rest transforms, key
// times, values and interpolation must all match byte-for-byte.
import {readFile,mkdir,writeFile,readdir,rm,rename} from 'node:fs/promises';
import {resolve,join,basename,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {openMotionPack,indexMotionZip} from '../src/motion-pack.js';
import {loadMotionSource} from '../src/motion-import.js';
import {classifyMotion} from '../src/motion-categories.js';

globalThis.ProgressEvent??=class{constructor(type,values){this.type=type;Object.assign(this,values)}};
const hash=data=>createHash('sha256').update(data).digest('hex');
export function encodeMotionGlb(source,clip,{family}={}){
 const bones=source.skeleton.bones,indices=new Map(bones.map((b,i)=>[b,i])),byName=new Map(bones.map((b,i)=>[b.name,i]));
 const nodes=bones.map(b=>({name:b.name,translation:b.position.toArray(),rotation:b.quaternion.toArray(),scale:b.scale.toArray(),...b.children.some(c=>indices.has(c))?{children:b.children.filter(c=>indices.has(c)).map(c=>indices.get(c))}:{}}));
 const chunks=[],bufferViews=[],accessors=[],samplers=[],channels=[];let length=0;
 const accessor=(values,type)=>{
  const data=new Float32Array(values),view=bufferViews.length;chunks.push(new Uint8Array(data.buffer));bufferViews.push({buffer:0,byteOffset:length,byteLength:data.byteLength});length+=data.byteLength;
  const width={SCALAR:1,VEC3:3,VEC4:4}[type],a={bufferView:view,componentType:5126,count:data.length/width,type};
  if(type==='SCALAR'){a.min=[data[0]];a.max=[data.at(-1)]}accessors.push(a);return accessors.length-1;
 };
 for(const track of [...clip.tracks].sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  const parsed=THREE.PropertyBinding.parseTrackName(track.name),node=byName.get(parsed.nodeName),path={quaternion:'rotation',position:'translation',scale:'scale'}[parsed.propertyName];
  if(node===undefined||!path)throw Error('Не удалось сохранить дорожку '+track.name);
  const cubic=track.createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline;
  const interpolation=cubic?'CUBICSPLINE':track.getInterpolation()===THREE.InterpolateDiscrete?'STEP':'LINEAR';
  if(!cubic&&![THREE.InterpolateDiscrete,THREE.InterpolateLinear].includes(track.getInterpolation()))throw Error('Неподдерживаемая интерполяция '+track.name);
  const sampler=samplers.length;samplers.push({input:accessor(track.times,'SCALAR'),output:accessor(track.values,path==='rotation'?'VEC4':'VEC3'),interpolation});channels.push({sampler,target:{node,path}});
 }
 const json={asset:{version:'2.0',generator:'Phoenix Model Forge motion library',...(family?{extras:{family}}:{})},scene:0,scenes:[{nodes:bones.flatMap((b,i)=>indices.has(b.parent)?[]:[i])}],nodes,skins:[{joints:bones.map((_,i)=>i)}],animations:[{name:'Motion',samplers,channels}],accessors,bufferViews,buffers:[{byteLength:length}]};
 const text=new TextEncoder().encode(JSON.stringify(json)),jsonSize=(text.length+3)&~3,binSize=(length+3)&~3,bytes=new Uint8Array(28+jsonSize+binSize),view=new DataView(bytes.buffer);
 view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);view.setUint32(8,bytes.length,true);view.setUint32(12,jsonSize,true);view.setUint32(16,0x4e4f534a,true);bytes.fill(32,20,20+jsonSize);bytes.set(text,20);view.setUint32(20+jsonSize,binSize,true);view.setUint32(24+jsonSize,0x004e4942,true);let offset=28+jsonSize;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}return bytes;
}
function titleFor(entry,clip,count,annotation){
 const file=entry.path.split('/').at(-1).replace(/\.[^.]+$/,'');
 const name=clip.name.replace(/^Armature[|_]/i,''),generic=/^(?:mixamo[ ._]com|take[ _]*\d*|default[ _]*take|animation|motion|action|armature)$/i;
 let title=count===1||generic.test(name)?file:name;
 if(/_[a-f0-9]{10,64}$/i.test(file)&&!generic.test(name))title=name;
 if(annotation?.labels?.length)title=annotation.labels[0]+(annotation.source?' · '+annotation.source:'');
 if(file.startsWith('monster_'))title=file.slice(8)+' · '+name;
 if(/(?:^|\/)(?:RootMotion|С_RootMotion)(?:\/|$)/i.test(entry.path)&&!/rootmotion/i.test(title))title+=' · RootMotion';
 return title.replace(/_/g,' ').slice(0,200);
}
async function collect(paths){
 const files=[];
 for(const path of paths){
  let children;try{children=await readdir(path,{withFileTypes:true})}catch(error){if(error.code!=='ENOTDIR')throw error}
  if(children){files.push(...await collect(children.sort((a,b)=>a.name.localeCompare(b.name,'en')).map(c=>join(path,c.name))));continue}
  if(!['.zip','.glb','.gltf','.fbx','.bvh','.bin'].includes(extname(path).toLowerCase()))continue;
  const bytes=await readFile(path),file=new Blob([bytes]);Object.defineProperty(file,'name',{value:basename(path)});files.push(file);
 }
 return files;
}
export async function buildMotionLibrary(paths,output,{progress=()=>{}}={}){
 const files=await collect(paths);if(!files.length)throw Error('Не найдены ZIP/GLB/FBX/BVH с анимациями');
 const annotations=new Map();for(const file of files)if(file.name.endsWith('.zip')){const index=await indexMotionZip(file,{metadata:true}),entry=index.get('animation-manifest.json');if(entry){const data=JSON.parse(new TextDecoder().decode(await entry.read()));for(const row of data.files||[])if(row.path)annotations.set(file.name+' / '+row.path,row)}}
 const entries=await openMotionPack(files),clips=new Map(),seenFiles=new Map(),warnings=[];let totalClips=0,duplicates=0;
 const temporary=output+'.building';await rm(temporary,{recursive:true,force:true});await mkdir(join(temporary,'clips'),{recursive:true});
 try{
  for(let index=0;index<entries.length;index++){
   const entry=entries[index];progress({index:index+1,total:entries.length,path:entry.label});
   try{
    const bytes=await entry.read(),fileHash=(entry.path.split('/').at(-1).startsWith('monster_')?'monster':'humanoid')+'/'+hash(bytes);
    if(seenFiles.has(fileHash)&&entry.format!=='gltf'){
     for(const id of seenFiles.get(fileHash)){const item=clips.get(id);if(!item.aliases.includes(entry.label))item.aliases.push(entry.label);totalClips++;duplicates++}continue;
    }
    const source=await loadMotionSource({...entry,read:async()=>bytes}),ids=[];
    for(const clip of source.clips){
     totalClips++;try{const family=entry.path.split('/').at(-1).startsWith('monster_')?'monster':'humanoid',packed=encodeMotionGlb(source,clip,{family}),id=hash(packed),alias=entry.label+' / '+clip.name;
     if(clips.has(id)){const item=clips.get(id);if(!item.aliases.includes(alias))item.aliases.push(alias);ids.push(id);duplicates++;continue}
     if(packed.length>8*1048576)throw Error('Движение больше 8 МиБ: '+clip.name);
     const annotation=annotations.get(entry.label),title=titleFor(entry,clip,source.clips.length,annotation),item={id,title,family,category:classifyMotion(annotation?.clips?.[0]?.name||title,entry.path),duration:clip.duration,bytes:packed.length,source:entry.label,aliases:[alias]};
     // Verify the packed asset through the same skeleton-only loader used by
     // Android before making it part of the shipped manifest.
     const verified=await loadMotionSource({format:'glb',path:title+'.glb',size:packed.length,read:async()=>packed});
     if(verified.clips.length!==1||verified.clip.tracks.length!==clip.tracks.length)throw Error('Проверка сохранённого движения не прошла');
     await writeFile(join(temporary,'clips',id+'.glb'),packed);clips.set(id,item);ids.push(id);
     }catch(error){warnings.push({source:entry.label,clip:clip.name,reason:error.message})}
    }
    seenFiles.set(fileHash,ids);for(const warning of source.warnings||[])if(warning.startsWith('Пропущено'))warnings.push({source:entry.label,reason:warning});
   }catch(error){warnings.push({source:entry.label,reason:error.message})}
  }
  if(!clips.size)throw Error('Нет поддерживаемых движений. '+(warnings[0]?.reason||''));
  const categoryOrder=['idle','walk','run','attack','other'];
  const ordered=[...clips.values()].sort((a,b)=>a.family.localeCompare(b.family,'en')||categoryOrder.indexOf(a.category)-categoryOrder.indexOf(b.category)||a.title.localeCompare(b.title,'en')||a.id.localeCompare(b.id,'en'));
  const titleCounts=new Map(),variants=new Map();for(const c of ordered){const key=c.family+'/'+c.category+'/'+c.title;titleCounts.set(key,(titleCounts.get(key)||0)+1)}for(const c of ordered){const key=c.family+'/'+c.category+'/'+c.title;if(titleCounts.get(key)>1){const n=(variants.get(key)||0)+1;variants.set(key,n);c.title+=' · Вариант '+n}}
  const report={sourceFiles:entries.length,sourceClips:totalClips,uniqueClips:ordered.length,duplicates,skippedClips:totalClips-ordered.length-duplicates,bytes:ordered.reduce((sum,c)=>sum+c.bytes,0),categories:Object.fromEntries(['idle','walk','run','attack','other'].map(category=>[category,ordered.filter(c=>c.category===category).length])),warnings,notes:['BLEND files are not imported; export their skeletal animations to GLB/FBX first.','Only exact hierarchy, rest transforms and key data duplicates are removed.']};
  report.families=Object.fromEntries(['humanoid','monster'].map(family=>[family,ordered.filter(c=>c.family===family).length]));
  await writeFile(join(temporary,'index.json'),JSON.stringify({version:1,clips:ordered}));await writeFile(join(temporary,'build-report.json'),JSON.stringify(report,null,2)+'\n');
  const backup=output+'.previous';await rm(backup,{recursive:true,force:true});let existed=false;try{await rename(output,backup);existed=true}catch(error){if(error.code!=='ENOENT')throw error}
  try{await rename(temporary,output)}catch(error){if(existed)await rename(backup,output);throw error}await rm(backup,{recursive:true,force:true});return report;
 }catch(error){await rm(temporary,{recursive:true,force:true});throw error}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const inputs=process.argv.slice(2);if(!inputs.length){console.error('Usage: npm run motions:build -- /path/to/animation-archives');process.exitCode=1}else{
  try{console.log(JSON.stringify(await buildMotionLibrary(inputs.map(p=>resolve(p)),resolve('public/motions'),{progress:p=>console.log(p.index+'/'+p.total+' '+p.path)}),null,2))}catch(error){console.error(error.message);process.exitCode=1}
 }
}

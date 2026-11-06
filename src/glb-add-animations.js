import {PropertyBinding,InterpolateDiscrete,InterpolateLinear} from 'three';
import {asBytes} from './binary.js';
import {inspectGlb} from './format.js';

// Append BVH tracks to the original container. Existing BIN bytes, textures,
// compressed geometry, materials, extensions, bind pose and clips stay intact.
export function appendGlbAnimations(input,clips,{nodeIndices=new Map(),memoryBudgetMiB=384}={}){
 const bytes=asBytes(input),json=inspectGlb(bytes).json;
 if(!clips.length)return bytes;
 if(!Number.isFinite(memoryBudgetMiB)||memoryBudgetMiB<64||memoryBudgetMiB>768)throw Error('Неверный предел памяти экспорта');
 const chunks=[];let bin=null;
 for(let offset=12;offset<bytes.length;){
  if(offset+8>bytes.length)throw Error('Повреждён блок GLB');
  const view=new DataView(bytes.buffer,bytes.byteOffset+offset,8),length=view.getUint32(0,true),type=view.getUint32(4,true);
  if(length%4||offset+8+length>bytes.length)throw Error('Повреждён размер блока GLB');
  const data=bytes.subarray(offset+8,offset+8+length);chunks.push({type,data});
  if(type===0x004e4942){if(bin)throw Error('Повторный BIN в GLB');bin=data}
  offset+=8+length;
 }
 if(!bin||!json.buffers?.[0]||json.buffers[0].byteLength>bin.length)throw Error('Не найден встроенный буфер модели');
 const names=new Map(),joints=new Set((json.skins||[]).flatMap(s=>s.joints||[]));
 for(const [index,node]of (json.nodes||[]).entries())if(node.name){for(const name of new Set([node.name,PropertyBinding.sanitizeNodeName(node.name)])){if(!names.has(name))names.set(name,index);else if(names.get(name)!==index)names.set(name,null)}}
 const resolve=name=>{
  const index=nodeIndices.has(name)?nodeIndices.get(name):names.get(name);
  if(!Number.isInteger(index)||!joints.has(index))throw Error('Неоднозначная или отсутствующая кость в исходном GLB: '+name);
  return index;
 };
 const properties={position:['translation',3],quaternion:['rotation',4],scale:['scale',3]},arrays=[],timeCache=[],existing=new Set((json.animations||[]).map(a=>a.name));let nextOffset=bin.length;
 const accessor=(array,size,time=false)=>{
  if(time){const found=timeCache.find(c=>c.array.length===array.length&&c.array.every((v,i)=>v===array[i]));if(found)return found.index}
  const view=(json.bufferViews??=[]).push({buffer:0,byteOffset:nextOffset,byteLength:array.byteLength})-1;
  const index=(json.accessors??=[]).push({bufferView:view,componentType:5126,count:array.length/size,type:size===1?'SCALAR':size===3?'VEC3':'VEC4',...(time?{min:[array[0]],max:[array.at(-1)]}:{})})-1;
  arrays.push({array,offset:nextOffset});nextOffset+=array.byteLength;
  if(time)timeCache.push({array,index});return index;
 };
 for(const clip of clips){
  if(!clip.name||existing.has(clip.name))throw Error('Повторное или пустое название анимации: '+(clip.name||''));
  if(!clip.tracks?.length)throw Error('В анимации нет дорожек');
  existing.add(clip.name);const animation={name:clip.name,channels:[],samplers:[]},targets=new Set();
  for(const track of clip.tracks){
   const binding=PropertyBinding.parseTrackName(track.name),property=properties[binding.propertyName];
   if(!property||binding.propertyIndex!==undefined||binding.objectName&&binding.objectName!=='bones')throw Error('Неподдерживаемая дорожка BVH: '+track.name);
   const node=resolve(binding.objectName==='bones'?binding.objectIndex:binding.nodeName),[path,size]=property,key=node+':'+path;
   if(targets.has(key))throw Error('Повторная дорожка кости: '+track.name);targets.add(key);
   if(track.createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline)throw Error('BVH не должен содержать кубические дорожки');
   const interpolation=track.getInterpolation();if(![InterpolateDiscrete,InterpolateLinear].includes(interpolation))throw Error('Неподдерживаемая интерполяция BVH');
   const times=track.times instanceof Float32Array?track.times:new Float32Array(track.times),values=track.values instanceof Float32Array?track.values:new Float32Array(track.values);
   if(!times.length||values.length!==times.length*size)throw Error('Размер дорожки BVH не совпал с ключами');
   for(let i=0;i<times.length;i++)if(!Number.isFinite(times[i])||times[i]<0||i>0&&times[i]<=times[i-1])throw Error('Некорректное время ключей BVH');
   if(!values.every(Number.isFinite))throw Error('Некорректные значения анимации');
   if(path==='rotation')for(let i=0;i<values.length;i+=4){const norm=values[i]**2+values[i+1]**2+values[i+2]**2+values[i+3]**2;if(Math.abs(norm-1)>.001)throw Error('Ненормализованный поворот BVH')}
   const sampler=animation.samplers.push({input:accessor(times,1,true),output:accessor(values,size),interpolation:interpolation===InterpolateDiscrete?'STEP':'LINEAR'})-1;
   animation.channels.push({sampler,target:{node,path}});
  }(json.animations??=[]).push(animation);
 }
 json.buffers[0].byteLength=nextOffset;
 const encoded=new TextEncoder().encode(JSON.stringify(json)),jsonLength=Math.ceil(encoded.length/4)*4;
 const total=12+chunks.reduce((sum,c)=>sum+8+(c.type===0x4e4f534a?jsonLength:c.type===0x004e4942?nextOffset:c.data.length),0);
 const estimated=Math.ceil((total*1.25+encoded.length*8+32*1048576)/1048576);
 if(total>250*1048576||estimated>memoryBudgetMiB)throw Error('Экспорт анимаций: расчётная память '+estimated+' МиБ превышает доступный предел. Нужна более лёгкая модель или анимация.');
 const output=new Uint8Array(total),header=new DataView(output.buffer);header.setUint32(0,0x46546c67,true);header.setUint32(4,2,true);header.setUint32(8,total,true);let offset=12;
 for(const chunk of chunks){const length=chunk.type===0x4e4f534a?jsonLength:chunk.type===0x004e4942?nextOffset:chunk.data.length;header.setUint32(offset,length,true);header.setUint32(offset+4,chunk.type,true);offset+=8;
  if(chunk.type===0x4e4f534a){output.fill(32,offset,offset+length);output.set(encoded,offset)}
  else{output.set(chunk.data,offset);if(chunk.type===0x004e4942)for(const part of arrays)output.set(new Uint8Array(part.array.buffer,part.array.byteOffset,part.array.byteLength),offset+part.offset)}offset+=length;
 }
 return output;
}

import {buildGuidedRig} from './guided-rig.js';
self.onmessage=async({data})=>{
 try{
  const result=await buildGuidedRig(data.bytes,{...data.options,onProgress:(percent,message)=>self.postMessage({progress:true,percent,message})});
  const buffers=new Set([result.bytes.buffer]);for(const part of result.preview.parts)for(const value of Object.values(part))if(ArrayBuffer.isView(value))buffers.add(value.buffer);
  self.postMessage({result},[...buffers]);
 }catch(e){self.postMessage({error:e.message||String(e)})}
};

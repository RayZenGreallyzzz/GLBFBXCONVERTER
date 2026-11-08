import {buildGuidedRig} from './guided-rig.js';
import {repairArmWeights} from './arm-weight-repair.js';
self.onmessage=async({data})=>{
 try{
  const calculate=data.options?.operation==='arm-weights'?repairArmWeights:buildGuidedRig;
  const result=await calculate(data.bytes,{...data.options,onProgress:(percent,message)=>self.postMessage({progress:true,percent,message})});
  const buffers=new Set([result.bytes.buffer]);for(const part of result.preview.parts)for(const value of Object.values(part))if(ArrayBuffer.isView(value))buffers.add(value.buffer);
  self.postMessage({result},[...buffers]);
 }catch(e){self.postMessage({error:e.message||String(e)})}
};

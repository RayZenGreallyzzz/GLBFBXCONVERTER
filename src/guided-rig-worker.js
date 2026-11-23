import {buildGuidedRig} from './guided-rig.js';
import {repairArmWeights} from './arm-weight-repair.js';
import {buildFingerRig,draftFingerRig} from './finger-rig.js';
self.onmessage=async({data})=>{
 try{
  const operation=data.options?.operation;
  const calculate={ 'arm-weights':repairArmWeights, 'finger-rig':buildFingerRig, 'finger-draft':draftFingerRig }[operation]||buildGuidedRig;
  const result=await calculate(data.bytes,{...data.options,onProgress:(percent,message)=>self.postMessage({progress:true,percent,message})});
  const buffers=new Set();if(result.bytes)buffers.add(result.bytes.buffer);for(const part of result.preview?.parts||[])for(const value of Object.values(part))if(ArrayBuffer.isView(value))buffers.add(value.buffer);
  self.postMessage({result},[...buffers]);
 }catch(e){self.postMessage({error:e.message||String(e)})}
};

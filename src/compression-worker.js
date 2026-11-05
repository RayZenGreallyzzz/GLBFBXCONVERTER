import {compressGlb} from './glb-compression.js';
self.onmessage=async({data})=>{
 try{
  const result=await compressGlb(data.bytes,{...data.options,
   onProgress:(percent,message)=>self.postMessage({progress:true,percent,message})});
  self.postMessage({result},[result.bytes.buffer]);
 }catch(error){self.postMessage({error:error.message||String(error)})}
};

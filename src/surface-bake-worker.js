// Terminating phase one releases its large simplifier WASM heap before BVH.
self.onmessage=async({data})=>{
 try{
  const options={...data.options,onProgress:(percent,message)=>self.postMessage({progress:true,percent,message})};let result;
  if(data.phase==='prepare'){
   if(typeof OffscreenCanvas==='undefined'||typeof createImageBitmap!=='function')throw Error('Обнови Android System WebView: недоступна фоновая обработка изображений.');
   const {prepareBakeGlb}=await import('./bake-prepare.js');result=await prepareBakeGlb(data.bytes,options);
  }else if(data.phase==='project'){
   const {projectBakeGlb}=await import('./bake-project.js');result=await projectBakeGlb(data.bytes,data.prepared,options);
  }else throw Error('Неизвестный этап переноса');
  self.postMessage({result},[result.bytes.buffer]);
 }catch(e){self.postMessage({error:e.message||String(e)})}
};

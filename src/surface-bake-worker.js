// Terminating phase one releases its large simplifier WASM heap before BVH.
self.onmessage=async({data})=>{
 try{
  const source=data.file?new Uint8Array(await data.file.arrayBuffer()):data.bytes;
  const options={...data.options,onProgress:(percent,message)=>self.postMessage({progress:true,percent,message})};let result;
  if(data.phase==='prepare'){
   if(typeof OffscreenCanvas==='undefined'||typeof createImageBitmap!=='function')throw Error('Обнови Android System WebView: недоступна фоновая обработка изображений.');
   const {prepareBakeGlb}=await import('./bake-prepare.js');result=await prepareBakeGlb(source,options);
  }else if(data.phase==='unwrap'){
   const {unwrapPreparedBake}=await import('./bake-unwrap.js');result=await unwrapPreparedBake(data.prepared,options);
  }else if(data.phase==='project'){
   const {projectBakeGlb}=await import('./bake-project.js');result=await projectBakeGlb(source,data.prepared,options);
  }else throw Error('Неизвестный этап переноса');
  self.postMessage({result},[result.bytes.buffer]);
 }catch(e){self.postMessage({error:e.message||String(e),errorCode:e.code})}
};

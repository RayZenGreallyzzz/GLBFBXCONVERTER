import {asBytes} from './binary.js';
function abortError(){const e=new Error('Перенос деталей отменён. Исходник сохранён.');e.name='AbortError';return e}
function settleWorker(signal){
 // Termination requests are immediate; WebView releases a worker's WASM heap
 // asynchronously. Yield before asking Android for the next live RAM budget.
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(abortError());return}
  const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(abortError())};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve()},200);
  signal?.addEventListener('abort',cancel,{once:true});
 });
}
function phase(data,{signal,onProgress}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(abortError());return}
  const worker=new Worker(new URL('./surface-bake-worker.js',import.meta.url),{type:'module'});let settled=false;
  const finish=(e,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);worker.terminate();e?reject(e):resolve(result)};
  const cancel=()=>finish(abortError()),timer=setTimeout(()=>finish(new Error('Этап переноса занял больше 15 минут. Уменьши исходник или разрешение карт.')),900000);
  signal?.addEventListener('abort',cancel,{once:true});worker.onerror=e=>finish(new Error('Ошибка фонового переноса: '+(e.message||'не удалось запустить обработку')));
  worker.onmessage=({data})=>{if(data.progress)onProgress(data.percent,data.message);else {const e=data.error?Object.assign(new Error(data.error),{code:data.errorCode}):null;finish(e,data.result)}};
  const payload={...data},transfers=[];
  if(data.bytes){const copy=asBytes(data.bytes).slice();payload.bytes=copy;transfers.push(copy.buffer)}
  if(data.prepared)transfers.push(data.prepared.bytes.buffer);
  try{worker.postMessage(payload,transfers)}catch(e){finish(e)}
 });
}
export async function bakeGlbOffThread(bytes,options,{signal,onProgress=()=>{},readMemoryBudget}={}){
 async function phaseOptions(afterWorker=false){
  if(signal?.aborted)throw abortError();
  if(afterWorker&&options.lowMemory)await settleWorker(signal);
  const budget=readMemoryBudget?await readMemoryBudget():options.memoryBudgetMiB??768;
  if(signal?.aborted)throw abortError();
  if(!Number.isFinite(budget)||budget<64||budget>768)throw Error('Неверный предел памяти');
  return {...options,memoryBudgetMiB:Math.min(options.memoryBudgetMiB??768,budget)};
 }
 const isFile=typeof Blob!=='undefined'&&bytes instanceof Blob,original=isFile?bytes:asBytes(bytes),source=isFile?{file:original}:{bytes:original},originalSize=isFile?original.size:original.byteLength,prepareOptions=await phaseOptions();
 let prepared=await phase({phase:'prepare',...source,options:{...prepareOptions,geometryOnly:!!options.lowMemory}},{signal,onProgress:(p,m)=>onProgress(p*.3,m)});
 if(prepared.unchanged)return {...prepared,beforeBytes:originalSize,afterBytes:originalSize,removedKeys:0,note:'Сетка уже не больше выбранной цели. Исходный GLB сохранён без изменений.'};
 if(options.lowMemory){
  for(let attempt=0;attempt<2;attempt++){
   try{prepared=await phase({phase:'unwrap',prepared,options:await phaseOptions(true)},{signal,onProgress:(p,m)=>onProgress(30+p*.15,m)});break}
   catch(e){
    if(attempt||!['BAKE_UV','BAKE_FRAME'].includes(e.code))throw e;
    onProgress(5,'Создаём альтернативную сетку из исходного файла…');
    prepared=await phase({phase:'prepare',...source,options:{...await phaseOptions(true),geometryOnly:true,regularize:true}},{signal,onProgress:(p,m)=>onProgress(p*.3,m)});
   }
  }
 }
 if(signal?.aborted)throw abortError();
 const projectOptions=await phaseOptions(true);
 return phase({phase:'project',...source,prepared,options:projectOptions},{signal,onProgress:(p,m)=>onProgress(46+p*.48,m)});
}

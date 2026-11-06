import {asBytes} from './binary.js';
function abortError(){const e=new Error('Перенос деталей отменён. Исходник сохранён.');e.name='AbortError';return e}
function phase(data,{signal,onProgress}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(abortError());return}
  const worker=new Worker(new URL('./surface-bake-worker.js',import.meta.url),{type:'module'});let settled=false;
  const finish=(e,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);worker.terminate();e?reject(e):resolve(result)};
  const cancel=()=>finish(abortError()),timer=setTimeout(()=>finish(new Error('Этап переноса занял больше 15 минут. Уменьши исходник или разрешение карт.')),900000);
  signal?.addEventListener('abort',cancel,{once:true});worker.onerror=e=>finish(new Error('Ошибка фонового переноса: '+(e.message||'не удалось запустить обработку')));
  worker.onmessage=({data})=>{if(data.progress)onProgress(data.percent,data.message);else finish(data.error?new Error(data.error):null,data.result)};
  const copy=asBytes(data.bytes).slice(),transfers=[copy.buffer];if(data.prepared)transfers.push(data.prepared.bytes.buffer);
  try{worker.postMessage({...data,bytes:copy},transfers)}catch(e){finish(e)}
 });
}
export async function bakeGlbOffThread(bytes,options,{signal,onProgress=()=>{},readMemoryBudget}={}){
 async function phaseOptions(){
  if(signal?.aborted)throw abortError();
  const budget=readMemoryBudget?await readMemoryBudget():options.memoryBudgetMiB??768;
  if(signal?.aborted)throw abortError();
  if(!Number.isFinite(budget)||budget<64||budget>768)throw Error('Неверный предел памяти');
  return {...options,memoryBudgetMiB:Math.min(options.memoryBudgetMiB??768,budget)};
 }
 const original=asBytes(bytes),prepareOptions=await phaseOptions();
 const prepared=await phase({phase:'prepare',bytes:original,options:prepareOptions},{signal,onProgress:(p,m)=>onProgress(p*.38,m)});
 if(prepared.unchanged)return {...prepared,beforeBytes:original.byteLength,afterBytes:original.byteLength,removedKeys:0,note:'Сетка уже не больше выбранной цели. Исходный GLB сохранён без изменений.'};
 if(signal?.aborted)throw abortError();
 const projectOptions=await phaseOptions();
 return phase({phase:'project',bytes:original,prepared,options:projectOptions},{signal,onProgress:(p,m)=>onProgress(40+p*.54,m)});
}

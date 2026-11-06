import {asBytes} from './binary.js';
export function startGuidedRig(bytes,options,onProgress=()=>{}){
 let worker,timer,finish,finished=false;
 const promise=new Promise((resolve,reject)=>{
  finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);worker?.terminate();error?reject(error):resolve(result)};
  worker=new Worker(new URL('./guided-rig-worker.js',import.meta.url),{type:'module'});
  worker.onmessage=({data})=>{if(finished)return;if(data.progress)onProgress(data.percent,data.message);else finish(data.error?Error(data.error):null,data.result)};
  worker.onerror=e=>finish(Error('Скелет: ошибка обработчика. '+(e.message||'')));
  timer=setTimeout(()=>finish(Error('Создание скелета заняло больше 3 минут. Уменьши сетку или точность весов.')),180000);
  const copy=asBytes(bytes).slice();worker.postMessage({bytes:copy,options},[copy.buffer]);
 });
 return {promise,cancel:()=>finish?.(Object.assign(Error('Создание скелета отменено. Исходник сохранён.'),{name:'AbortError'}))};
}

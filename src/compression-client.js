import {asBytes} from './binary.js';
export function compressGlbOffThread(bytes,options,onProgress=()=>{}){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./compression-worker.js',import.meta.url),{type:'module'});
  let timer;
  const done=(error,result)=>{clearTimeout(timer);worker.terminate();error?reject(error):resolve(result)};
  worker.onmessage=({data})=>{
   if(data.progress)onProgress(data.percent,data.message);
   else done(data.error?new Error(data.error):null,data.result);
  };
  worker.onerror=e=>done(new Error('Ошибка кодека: '+(e.message||'не удалось запустить обработку')));
  timer=setTimeout(()=>done(new Error('Сжатие заняло больше 5 минут. Уменьши модель или текстуры.')),300000);
  // Transfer a copy: never detach the original model or a valid saved preview.
  const copy=asBytes(bytes).slice();
  worker.postMessage({bytes:copy,options},[copy.buffer]);
 });
}

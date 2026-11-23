export function startDetailsJob(operation,input,options,parts=[],onProgress=()=>{}){
  let worker,finish,timer;
  const promise=new Promise((resolve,reject)=>{
    let finished=false;
    finish=(error,value)=>{
      if(finished)return;
      finished=true;clearTimeout(timer);worker?.terminate();
      if(error)reject(error);else resolve(value);
    };
    try{
      worker=new Worker(new URL('./details-worker.js',import.meta.url),{type:'module'});
      worker.onmessage=({data})=>{
        if(data.progress!==undefined)onProgress(data.progress);
        else if(data.error)finish(Error(data.error));
        else finish(null,data.result);
      };
      worker.onerror=()=>finish(Error('Ошибка обработчика деталей.'));
      const source=new Uint8Array(input).slice(), copies=parts.map(p=>p.bytes?{...p,bytes:new Uint8Array(p.bytes).slice()}:p);
      worker.postMessage({operation,input:source,options,parts:copies},[source.buffer,...copies.flatMap(p=>p.bytes?[p.bytes.buffer]:[])]);
      timer=setTimeout(()=>finish(Error('Правка заняла больше трёх минут. Уменьши размер моделей.')),180000);
    }catch(error){finish(error)}
  });
  return {promise,cancel:()=>finish(Error('Правка отменена.'))};
}

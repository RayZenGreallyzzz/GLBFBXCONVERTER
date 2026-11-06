// These are task estimates, not Android heap limits or allocation guarantees.
export function boundedGeometryMemory(bytes,accessorBytes,triangles,vertices){
 // Includes allocator / WASM high-water overhead observed in the 5.24M test.
 return bytes+accessorBytes+triangles*4+vertices*4+240*1048576+200000*192;
}
export function bakeMemoryBudget({android=false,deviceMemory,native}={}){
 const fallback=android?(deviceMemory&&deviceMemory<=2?256:384):(deviceMemory&&deviceMemory<=4?384:768);
 if(!android||!native)return fallback;
 const {totalMiB,availableMiB,thresholdMiB,lowMemory,lowRamDevice}=native;
 if(lowMemory===true)throw Error('Android сообщает о нехватке оперативной памяти. Закрой другие приложения и повтори перенос.');
 if(![totalMiB,availableMiB,thresholdMiB].every(Number.isFinite)||totalMiB<=0||availableMiB<0||thresholdMiB<0||availableMiB>totalMiB)return fallback;
 // Retain the system's low-memory reserve and at least half the remainder.
 const headroom=Math.floor((availableMiB-Math.max(256,thresholdMiB))/2);
 const ceiling=lowRamDevice||totalMiB<3072?256:totalMiB<5120?512:768;
 const budget=Math.min(ceiling,headroom);
 if(budget<64)throw Error('Сейчас недостаточно свободной оперативной памяти для переноса. Закрой другие приложения и повтори попытку.');
 return budget;
}
export async function resolveBakeMemoryBudget({android=false,deviceMemory,readNative}={}){
 let native,timer;
 if(android&&readNative){
  try{native=await Promise.race([readNative(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('memory query timeout')),3000)})])}
  catch{}finally{clearTimeout(timer)}
 }
 return bakeMemoryBudget({android,deviceMemory,native});
}
export function checkBakeMemory({geometryBytes,projectionBytes=0,mapBytesPerPixel=0,resolution=512,memoryBudgetMiB}){
 if(!Number.isFinite(memoryBudgetMiB)||memoryBudgetMiB<64||memoryBudgetMiB>768)throw Error('Неверный предел памяти');
 const estimateAt=size=>Math.max(geometryBytes,projectionBytes+size*size*mapBytesPerPixel);
 const estimate=estimateAt(resolution),limit=memoryBudgetMiB*1048576;
 if(estimate<=limit)return Math.ceil(estimate/1048576);
 const prefix='Расчётная память задачи — '+Math.ceil(estimate/1048576)+' МиБ, предел — '+memoryBudgetMiB+' МиБ. ';
 const smaller=[2048,1024,512].find(size=>size<resolution&&estimateAt(size)<=limit);
 if(smaller)throw Error(prefix+'Выбери карты '+smaller+' px: оценка — '+Math.ceil(estimateAt(smaller)/1048576)+' МиБ.');
 throw Error(prefix+'Уменьшения карт недостаточно: память занимает исходная модель и её обработка. Нужен более лёгкий исходник или устройство с большим запасом памяти.');
}

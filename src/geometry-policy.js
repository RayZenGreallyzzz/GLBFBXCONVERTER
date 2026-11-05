// Absolute goals and portable history prevent destructive percentage chains.
import {inspectGlb} from './format.js';
import {asBytes} from './binary.js';
export const HISTORY_KEY='phoenixModelForge';
export function geometryHistory(extras){
 const h=extras?.[HISTORY_KEY];
 if(h?.version!==1||!Number.isInteger(h.sourceTriangles)||!Number.isInteger(h.triangles)||
  h.sourceTriangles<=h.triangles||h.triangles<1||h.geometryPasses!==1)return null;
 return h;
}
export function geometryPlan({sourceTriangles,ratio=.5,targetTriangles=null,error=.003,history=null}={}){
 if(!Number.isInteger(sourceTriangles)||sourceTriangles<0)throw Error('Некорректное число треугольников');
 if(!Number.isFinite(error)||error<0||error>1)throw Error('Некорректная погрешность упрощения');
 if(history)throw Error('Эта сетка уже упрощена в Forge. Для другой цели загрузи исходный GLB. Текстуры, анимации и кодеки можно обрабатывать отдельно.');
 if(targetTriangles!==null&&(!Number.isInteger(targetTriangles)||targetTriangles<1))
  throw Error('Укажи положительное целое число треугольников');
 if(!Number.isFinite(ratio)||ratio<=0||ratio>1)throw Error('Некорректная доля треугольников');
 const requested=targetTriangles===null?Math.max(1,Math.floor(sourceTriangles*ratio)):targetTriangles;
 return {ratio:targetTriangles===null?ratio:sourceTriangles?Math.min(1,requested/sourceTriangles):1,
  targetTriangles:Math.min(sourceTriangles,requested),error};
}
export function optimizationHistory(sourceTriangles,triangles,targetTriangles,error){
 return {version:1,sourceTriangles,triangles,targetTriangles,error,geometryPasses:1};
}
export function geometryTargetNote(target,actual){
 if(!target)return '';
 return actual>target*1.05
  ?'Цель '+target.toLocaleString('ru-RU')+' треугольников не достигнута: оставлено '+
    actual.toLocaleString('ru-RU')+' для соблюдения ограничений формы и швов. Не упрощай сохранённый результат повторно; меняй цель на исходнике.'
  :'Цель: около '+target.toLocaleString('ru-RU')+' треугольников. Новый вариант создаётся из загруженного исходника.';
}
export function markGeometryGlb(input,history){
 const source=asBytes(input),json=inspectGlb(source).json;
 json.extras={...json.extras,[HISTORY_KEY]:history};
 const payload=new TextEncoder().encode(JSON.stringify(json)),length=Math.ceil(payload.length/4)*4;
 const previous=new DataView(source.buffer,source.byteOffset,source.byteLength).getUint32(12,true);
 const result=new Uint8Array(source.length-previous+length),view=new DataView(result.buffer);
 result.set(source.subarray(0,12));view.setUint32(8,result.length,true);
 view.setUint32(12,length,true);view.setUint32(16,0x4e4f534a,true);
 result.fill(32,20,20+length);result.set(payload,20);result.set(source.subarray(20+previous),20+length);
 return result;
}

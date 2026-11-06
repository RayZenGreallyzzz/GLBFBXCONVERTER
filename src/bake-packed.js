// Normalized accessor reads without expanding every packed attribute to Float32.
export function packedValues(accessor){
 const array=accessor.getArray();if(!array)throw Error('Нет данных атрибута');
 const max=accessor.getNormalized()?{5120:127,5121:255,5122:32767,5123:65535,5125:4294967295}[accessor.getComponentType()]:0;
 if(accessor.getNormalized()&&!max)throw Error('Неподдерживаемый нормализованный атрибут');
 if(!max)return array;
 return {length:array.length,byteLength:array.byteLength,at:i=>Math.max(-1,array[i]/max)};
}
export const valueAt=(a,i)=>ArrayBuffer.isView(a)?a[i]:a.at(i);
export function positionBounds(p){
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<p.length;i++){const v=valueAt(p,i),k=i%3;if(!Number.isFinite(v))throw Error('Некорректные координаты сетки');min[k]=Math.min(min[k],v);max[k]=Math.max(max[k],v)}
 return {min,max,extent:Math.max(...max.map((v,k)=>v-min[k]))};
}

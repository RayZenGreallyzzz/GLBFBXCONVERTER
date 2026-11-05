import {prune} from '@gltf-transform/functions';
import {PropertyType} from '@gltf-transform/core';
import {readBakeGlb,bakePlan,bakePrimitives} from './bake-common.js';
import {simplifyBakeStatic,unwrapBakePrimitive,finishBakePrimitive,removeBakeDegenerates} from './bake-geometry.js';
import {simplifySkinnedMeshes} from './skin-simplify.js';
import {countTriangles} from './glb-optimize.js';
export async function prepareBakeGlb(bytes,options={}){
 const progress=options.onProgress||(()=>{});progress(2,'Читаем исходник для переноса деталей…');
 const {io,document}=await readBakeGlb(bytes),plan=bakePlan(document,bytes.byteLength,options);
 if(plan.unchanged)return {bytes,unchanged:true,sourceTriangles:plan.sourceTriangles,optimizedTriangles:plan.sourceTriangles};
 const skinned=new Set(document.getRoot().listNodes().filter(n=>n.getSkin()).map(n=>n.getMesh())),primitives=bakePrimitives(document);
 progress(8,'Создаём лёгкую сетку из оригинала…');await simplifySkinnedMeshes(document,{ratio:plan.ratio,error:plan.error});
 let index=0;
 for(const mesh of document.getRoot().listMeshes())for(const prim of mesh.listPrimitives()){
  if(!skinned.has(mesh))await simplifyBakeStatic(document,prim,plan);removeBakeDegenerates(prim);
  if((prim.getIndices()?.getCount()||prim.getAttribute('POSITION').getCount())>600000)throw Error('Сетка остаётся слишком большой для переноса. Увеличь погрешность формы или выбери обычную оптимизацию.');
  progress(15+70*index/primitives.length,'UV-развёртка части '+(index+1)+'/'+primitives.length+': '+(prim.getIndices().getCount()/3).toLocaleString('ru-RU')+' треугольников…');
  await unwrapBakePrimitive(document,prim,plan.resolution,(_category,p)=>progress(15+70*(index+p/100)/primitives.length,'Развёртка части '+(index+1)+'/'+primitives.length+': '+p+'%'));
  finishBakePrimitive(prim);index++;
 }
 const optimizedTriangles=countTriangles(document);if(optimizedTriangles>=plan.sourceTriangles)throw Error('Безопасного уменьшения сетки не получилось. Перенос отменён.');
 await document.transform(prune({propertyTypes:[PropertyType.ACCESSOR],keepAttributes:true,keepExtras:true}));
 progress(95,'Подготавливаем проекцию; освобождаем память упрощения…');const prepared=await io.writeBinary(document);
 return {bytes:prepared,unchanged:false,sourceTriangles:plan.sourceTriangles,optimizedTriangles,targetTriangles:plan.targetTriangles,resolution:plan.resolution,error:plan.error,estimatedMiB:plan.estimatedMiB};
}

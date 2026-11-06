import {prune} from '@gltf-transform/functions';
import {PropertyType} from '@gltf-transform/core';
import {readBakeGlb,bakePlan,bakePrimitives} from './bake-common.js';
import {simplifyBakeStatic,unwrapBakePrimitive,finishBakePrimitive,removeBakeDegenerates} from './bake-geometry.js';
import {simplifySkinnedMeshes} from './skin-simplify.js';
import {countTriangles} from './glb-optimize.js';
import {captureMorphs,assertMorphRows} from './morph-policy.js';
import {primitiveGeometry} from './bake-geometry.js';
import {Accessor} from '@gltf-transform/core';
export async function prepareBakeGlb(bytes,options={}){
 const progress=options.onProgress||(()=>{});progress(2,'Читаем исходник для переноса деталей…');
 const {io,document}=await readBakeGlb(bytes,options),plan=bakePlan(document,bytes.byteLength,options);
 if(plan.unchanged)return {bytes,unchanged:true,sourceTriangles:plan.sourceTriangles,optimizedTriangles:plan.sourceTriangles};
 const morph=captureMorphs(document,{ids:true});
 for(const part of morph.parts){
  const p=document.getRoot().listMeshes()[part.mi].listPrimitives()[part.pi];
  if(!p.getAttribute('NORMAL')){const data=primitiveGeometry(p);p.setAttribute('NORMAL',document.createAccessor().setBuffer(document.getRoot().listBuffers()[0]).setType(Accessor.Type.VEC3).setArray(data.normals));data.geometry.dispose()}
 }
 const skinned=new Set(document.getRoot().listNodes().filter(n=>n.getSkin()).map(n=>n.getMesh())),primitives=bakePrimitives(document);
 progress(8,'Создаём лёгкую сетку из оригинала…');await simplifySkinnedMeshes(document,{ratio:plan.ratio,error:plan.error});
 let index=0,regularizedParts=options.regularize?primitives.length:0,trianglesDone=0;
 for(const mesh of document.getRoot().listMeshes())for(const prim of mesh.listPrimitives()){
  const isStatic=!skinned.has(mesh),donor=isStatic&&!options.geometryOnly?prim.clone():null;
  async function preparePart(regularize=false){
   if(isStatic)await simplifyBakeStatic(document,prim,{...plan,regularize,onProgress:p=>progress(8+65*(index+p)/primitives.length,'Упрощаем сетку небольшими частями: '+Math.round(p*100)+'%')});removeBakeDegenerates(prim);
   if((prim.getIndices()?.getCount()||prim.getAttribute('POSITION').getCount())>600000)throw Error('Сетка остаётся слишком большой для переноса. Увеличь погрешность формы или выбери обычную оптимизацию.');
   if((options.lowMemory||morph.parts.length)&&trianglesDone+prim.getIndices().getCount()/3>200000)throw Error('Для переноса остаётся больше 200 тысяч треугольников. Защищённая мимика или ограничения формы не позволяют достичь цели.');
   if(options.geometryOnly)return;
   progress(15+70*index/primitives.length,'UV-развёртка части '+(index+1)+'/'+primitives.length+': '+(prim.getIndices().getCount()/3).toLocaleString('ru-RU')+' треугольников…');
   await unwrapBakePrimitive(document,prim,plan.resolution,(_category,p)=>progress(15+70*(index+p/100)/primitives.length,'Развёртка части '+(index+1)+'/'+primitives.length+': '+p+'%'));
  }
  try{
   try{await preparePart(!!options.regularize)}catch(e){
    if(!donor||!['BAKE_FRAME','BAKE_UV'].includes(e.code))throw e;
    // Retry an alternative FROM THE DONOR with the SAME error limit.
    // Never simplify the already-reduced result a second time.
    prim.copy(donor);regularizedParts++;
    progress(12,'Подбираем более устойчивую сетку для переноса…');await preparePart(true);
   }
   finishBakePrimitive(prim);
  }finally{donor?.dispose()}
  trianglesDone+=prim.getIndices().getCount()/3;
  index++;
 }
 const optimizedTriangles=countTriangles(document);if(optimizedTriangles>=plan.sourceTriangles)throw Error('Безопасного уменьшения сетки не получилось. Перенос отменён.');
 if(morph.parts.length)assertMorphRows(morph,document,{baked:!options.geometryOnly});
 await document.transform(prune({propertyTypes:[PropertyType.ACCESSOR],keepAttributes:true,keepExtras:true}));
 progress(95,'Подготавливаем проекцию; освобождаем память упрощения…');const prepared=await io.writeBinary(document);
 return {bytes:prepared,unchanged:false,sourceTriangles:plan.sourceTriangles,optimizedTriangles,targetTriangles:plan.targetTriangles,resolution:plan.resolution,error:plan.error,estimatedMiB:plan.estimatedMiB,regularizedParts,geometryOnly:!!options.geometryOnly};
}

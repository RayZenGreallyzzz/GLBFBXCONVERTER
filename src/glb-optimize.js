// Offline glTF 2.0 optimizer. Works directly on the original GLB bytes:
// unlike GLTFExporter round-tripping, source images are kept when unchanged.
import {createCodecIO,removeGeometryCompression} from './codec-io.js';
import { prune } from '@gltf-transform/functions';
import {PropertyType} from '@gltf-transform/core';
import {inspectGlb} from './format.js';
import {inspectMorphJson,captureMorphs,assertMorphRows,morphMaps,resampleWithMorphs} from './morph-policy.js';
import { simplifySkinnedMeshes } from './skin-simplify.js';
import {simplifyStaticMeshes} from './static-simplify.js';
import {geometryHistory,geometryPlan,optimizationHistory,geometryTargetNote,HISTORY_KEY} from './geometry-policy.js';

export const MOBILE_PRESETS = Object.freeze({
  mobile: { texture: 512, ratio: 0.22, error: 0.07 },
  balanced: { texture: 1024, ratio: 0.50, error: 0.025 },
  high: { texture: 2048, ratio: 0.75, error: 0.008 },
  original: { texture: 4096, ratio: 1.0, error: 0 }
});
export const formatSize = bytes => (bytes / 1048576).toFixed(1) + ' МБ';
export function countAnimationKeys(document) {
  return document.getRoot().listAnimations().reduce((sum,animation)=>
    sum+animation.listSamplers().reduce((n,sampler)=>n+(sampler.getInput()?.getCount()||0),0),0);
}
export function selectiveOptimizationPlan({geometry=false,textures=false,animationKeys=false,ratio=1}={}) {
  return {geometry:Boolean(geometry)&&ratio<1,textures:Boolean(textures),
    animationKeys:Boolean(animationKeys)};
}

export function countTriangles(document) {
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      // glTF mode 4 == TRIANGLES, which covers typical Meshy exports.
      if (primitive.getMode() !== 4) continue;
      const indices = primitive.getIndices();
      const positions = primitive.getAttribute('POSITION');
      total += Math.floor((indices?.getCount() || positions?.getCount() || 0) / 3);
    }
  }
  return total;
}

function colorOnly(document, texture) {
  // JPEG is safe only for fully opaque color textures. Normal/ORM/alpha maps
  // remain PNG so that GPU lighting and cutouts are not degraded.
  let used = false;
  for (const m of document.getRoot().listMaterials()) {
    if (m.getNormalTexture() === texture ||
        m.getOcclusionTexture() === texture ||
        m.getMetallicRoughnessTexture() === texture) return false;
    if (m.getBaseColorTexture() === texture || m.getEmissiveTexture() === texture)
      used = true;
  }
  return used;
}

function encodeCanvas(canvas, mime, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? b.arrayBuffer().then(buf => resolve(new Uint8Array(buf)), reject)
      : reject(new Error('Не удалось сжать текстуру')), mime, quality));
}

export async function resizeTextures(document, maxSize, quality = 0.83) {
  if (typeof document === 'undefined' || !document.getRoot) throw Error('Нет данных glTF');
  const stats = { resized: 0, lossy: 0, unchanged: 0 };
  if (!document.getRoot().listTextures().length) return stats;
  if (typeof window === 'undefined' || typeof createImageBitmap !== 'function')
    throw Error('Обработка текстур требует Android/WebView с Canvas');
  for (const texture of document.getRoot().listTextures()) {
    const bytes = texture.getImage(), type = texture.getMimeType();
    if(type==='image/ktx2'){
      const size=texture.getSize();
      if(size&&Math.max(...size)<=maxSize){stats.unchanged++;continue;}
      const {decodeKtx2}=await import('./texture-codecs.js');
      const image=await decodeKtx2(bytes);
      const scale=Math.min(1,maxSize/Math.max(image.width,image.height));
      const original=window.document.createElement('canvas');
      original.width=image.width;original.height=image.height;
      original.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data),image.width,image.height),0,0);
      const canvas=window.document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(image.width*scale));
      canvas.height=Math.max(1,Math.round(image.height*scale));
      canvas.getContext('2d').drawImage(original,0,0,canvas.width,canvas.height);
      texture.setImage(await encodeCanvas(canvas,'image/png',1)).setMimeType('image/png');
      stats.resized++;continue;
    }
    if (!bytes || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
      throw Error('Неизвестный формат текстуры: ' + (type || 'нет MIME'));
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    try {
      const width = bitmap.width, height = bitmap.height;
      const scale = Math.min(1, maxSize / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      // Already-sized textures are kept byte-for-byte. Repeated lossy JPEG
      // conversion of a previously optimized PNG changes the appearance.
      const tryJpeg = colorOnly(document, texture) && type === 'image/png' && scale < 1;
      if (scale === 1) {
        stats.unchanged++;
        continue; // preserve exact original embedded PNG/JPEG bytes.
      }
      // Shadowing the Document variable here would hide window.document.
      const surface = window.document.createElement('canvas');
      surface.width = w; surface.height = h;
      const ctx = surface.getContext('2d', { willReadFrequently: tryJpeg });
      if (!ctx) throw Error('Canvas 2D не поддерживается');
      ctx.drawImage(bitmap, 0, 0, w, h);
      // Preserve WebP as WebP: Godot 4.x supports EXT_texture_webp and a
      // WebP→PNG conversion can greatly increase file size on alpha textures.
      let outMime = type;
      let out = await encodeCanvas(surface, outMime, quality);
      if (tryJpeg) {
        const image = ctx.getImageData(0, 0, w, h).data;
        let opaque = true;
        for (let i = 3; i < image.length; i += 4) {
          if (image[i] !== 255) { opaque = false; break; }
        }
        if (opaque) {
          const jpg = await encodeCanvas(surface, 'image/jpeg', quality);
          if (jpg.byteLength < out.byteLength) {
            out = jpg; outMime = 'image/jpeg'; stats.lossy++;
          }
        }
      }
      if (out.byteLength < bytes.byteLength || scale < 1) {
        texture.setImage(out);
        texture.setMimeType(outMime);
        stats.resized++;
      } else stats.unchanged++;
    } finally { bitmap.close?.(); }
  }
  // Only drop WebP extension when no WebP textures remain.
  if (!document.getRoot().listTextures().some(t => t.getMimeType() === 'image/webp')) {
    for (const extension of document.getRoot().listExtensionsUsed()) {
      if (extension.extensionName === 'EXT_texture_webp') extension.dispose();
    }
  }
  if(!document.getRoot().listTextures().some(t=>t.getMimeType()==='image/ktx2'))
    for(const extension of document.getRoot().listExtensionsUsed())
      if(extension.extensionName==='KHR_texture_basisu')extension.dispose();
  return stats;
}

export async function optimizeGlb(originalBuffer, { texture = 1024, ratio = 0.5,
  error = 0.025, geometry = true, textures = true, animationKeys = false,
  targetTriangles = null,
  onProgress = () => {} } = {}) {
  if (!originalBuffer) throw Error('Отсутствует исходный GLB');
  const original = originalBuffer instanceof Uint8Array
    ? originalBuffer : new Uint8Array(originalBuffer);
  const morphInfo=inspectMorphJson(inspectGlb(original).json);
  const io = await createCodecIO(original);
  onProgress(12, 'Читаем оригинальный GLB без повторного кодирования...');
  const document = await io.readBinary(original);
  removeGeometryCompression(document);
  const morph=morphInfo.targets?captureMorphs(document,{ids:geometry}):null;
  const sourceTriangles = countTriangles(document);
  const skins = document.getRoot().listSkins().length;
  const animations = document.getRoot().listAnimations().length;
  const sourceImages = document.getRoot().listTextures().length;
  const history=geometryHistory(document.getRoot().getExtras());
  const goal=geometry?geometryPlan({sourceTriangles,ratio,targetTriangles,error,history}):null;
  if(goal)ratio=goal.ratio;
  const originalKeyCount = countAnimationKeys(document);
  const plan = selectiveOptimizationPlan({geometry,textures,animationKeys,ratio});
  onProgress(28, 'Анализируем геометрию и скелеты...');
  let geometryNote = '';
  let changed=false;
  let removedKeys=0;
  if (plan.geometry && skins === 0 && sourceTriangles > 0) {
    onProgress(35, 'Упрощаем сетку с учётом нормалей, UV и швов…');
    const stats=await simplifyStaticMeshes(document,{ratio,error});
    geometryNote=stats.reduced?'Сетка упрощена с учётом нормалей, UV и швов.'
      :'Безопасных сокращений не найдено: сохранена исходная сетка.';
    if(stats.skipped)geometryNote+=' Пропущены неподдерживаемые примитивы: '+stats.skipped+'.';
  } else if (plan.geometry && skins && sourceTriangles>0) {
    onProgress(35, 'Защищаем суставы, UV и веса костей при упрощении сетки...');
    const stats=await simplifySkinnedMeshes(document,{ratio,error});
    await simplifyStaticMeshes(document,{ratio,error});
    geometryNote=stats.reduced
      ?'Скелетная сетка: '+stats.trianglesBefore.toLocaleString('ru-RU')+
       ' → '+stats.trianglesAfter.toLocaleString('ru-RU')+
       ' треугольников. Веса и кости сохранены.'
      :'Скелетная сетка: безопасных сокращений не найдено, веса и кости не изменены.';
  } else {
    geometryNote = 'Сетка оставлена без изменений по выбору пользователя.';
  }
  const optimizedTriangles = countTriangles(document);
  if (optimizedTriangles > sourceTriangles)
    throw Error('Оптимизация неожиданно увеличила число треугольников');
  if (optimizedTriangles < sourceTriangles) changed=true;
  if(optimizedTriangles<sourceTriangles)
    document.getRoot().setExtras({...document.getRoot().getExtras(),
      [HISTORY_KEY]:optimizationHistory(sourceTriangles,optimizedTriangles,goal?.targetTriangles,error)});
  let textureStats={resized:0,lossy:0,unchanged:sourceImages};
  if (plan.textures) {
    onProgress(65, 'Обрабатываем только выбранные текстуры...');
    textureStats = await resizeTextures(document,texture);
    if(textureStats.resized>0)changed=true;
  }
  if (plan.animationKeys && animations>0) {
    onProgress(72, 'Удаляем только повторяющиеся ключи анимаций...');
    await resampleWithMorphs(document);
    const optimizedKeyCount=countAnimationKeys(document);
    removedKeys=originalKeyCount-optimizedKeyCount;
    if(removedKeys<0)throw Error('Оптимизация неожиданно добавила ключи анимаций');
    if(removedKeys>0)changed=true;
  }
  if(morph)geometryNote+=' Blend Shapes: вершины мимики и их окружение защищены; имена, веса и анимации форм сохраняются.';
  if(goal&&targetTriangles!==null)geometryNote+=' '+geometryTargetNote(goal.targetTriangles,optimizedTriangles);
  const noteParts=[geometryNote];
  if(removedKeys>0)noteParts.push('Удалено повторов ключей: '+removedKeys+'.');
  const unchangedResult=(message)=>{
    onProgress(100,message);
    return {bytes:original,beforeBytes:original.byteLength,afterBytes:original.byteLength,
      sourceTriangles,optimizedTriangles:sourceTriangles,skins,animations,
      textureStats,removedKeys:0,unchanged:true,
      note:message+' Исходные байты GLB сохранены без повторного кодирования.'};
  };
  if(!changed) return unchangedResult(geometryNote+' Изменений нет: модель уже оптимизирована или выбранные части не требуют обработки.');
  let morphMap;
  if(morph){if(!geometry)captureMorphs(document,{ids:true});morphMap=morphMaps(document,{remove:true});assertMorphRows(morph,document,{maps:morphMap})}
  // Replacing an indices accessor can leave the original large index array
  // orphaned. Remove only unreferenced accessors; retain all live attributes,
  // including UVs without a current material, skin data and animation keys.
  await document.transform(prune({propertyTypes:[PropertyType.ACCESSOR],
    keepAttributes:true,keepExtras:true}));
  onProgress(86, 'Собираем стандартный GLB 2.0 для Godot...');
  const output = await io.writeBinary(document);
  if (output.byteLength >= original.byteLength)
    return unchangedResult('Выбранные изменения не уменьшили файл. Оставлен оригинал.');
  // New storage codecs are an explicit, separate step. Existing KTX2 textures
  // can remain compressed when no texture resizing is requested.
  const forbidden = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];
  const optimizedIO = await io.readBinary(output);
  if(morph)assertMorphRows(morph,optimizedIO,{maps:morphMap});
  const required = optimizedIO.getRoot().listExtensionsRequired().map(e => e.extensionName);
  if (required.some(e => forbidden.includes(e)))
    throw Error('Результат требует внешнего декодера: ' + required.join(', '));
  if (optimizedIO.getRoot().listSkins().length !== skins ||
      optimizedIO.getRoot().listAnimations().length !== animations ||
      optimizedIO.getRoot().listTextures().length !== sourceImages)
    throw Error('Обнаружена потеря скелета, анимаций или текстур. Сохранение отменено.');
  onProgress(100, 'Готово');
  return { bytes: output, beforeBytes: original.byteLength,
    afterBytes: output.byteLength, sourceTriangles, optimizedTriangles,
    skins, animations, textureStats, removedKeys,unchanged:false,
    targetTriangles:goal?.targetTriangles??null,
    note:noteParts.join(' ') };
}

// Offline glTF 2.0 optimizer. Works directly on the original GLB bytes:
// unlike GLTFExporter round-tripping, source images are kept when unchanged.
import { WebIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

export const MOBILE_PRESETS = Object.freeze({
  mobile: { texture: 512, ratio: 0.22, error: 0.07 },
  balanced: { texture: 1024, ratio: 0.50, error: 0.025 },
  high: { texture: 2048, ratio: 0.75, error: 0.008 },
  original: { texture: 4096, ratio: 1.0, error: 0 }
});
export const formatSize = bytes => (bytes / 1048576).toFixed(1) + ' МБ';

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
  if (typeof window === 'undefined' || typeof createImageBitmap !== 'function')
    throw Error('Обработка текстур требует Android/WebView с Canvas');
  const stats = { resized: 0, lossy: 0, unchanged: 0 };
  for (const texture of document.getRoot().listTextures()) {
    const bytes = texture.getImage(), type = texture.getMimeType();
    if (!bytes || !['image/jpeg', 'image/png'].includes(type)) {
      throw Error('Неизвестный формат текстуры: ' + (type || 'нет MIME'));
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    try {
      const width = bitmap.width, height = bitmap.height;
      const scale = Math.min(1, maxSize / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const tryJpeg = colorOnly(document, texture) && type === 'image/png';
      if (scale === 1 && !tryJpeg) {
        stats.unchanged++;
        continue; // preserve exact original embedded PNG/JPEG bytes.
      }
      // Shadowing the Document variable here would hide window.document.
      const surface = window.document.createElement('canvas');
      surface.width = w; surface.height = h;
      const ctx = surface.getContext('2d', { willReadFrequently: tryJpeg });
      if (!ctx) throw Error('Canvas 2D не поддерживается');
      ctx.drawImage(bitmap, 0, 0, w, h);
      let out = await encodeCanvas(surface, type, quality), outMime = type;
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
  return stats;
}

export async function optimizeGlb(originalBuffer, { texture = 1024, ratio = 0.5,
  error = 0.025, geometry = true, onProgress = () => {} } = {}) {
  if (!originalBuffer) throw Error('Отсутствует исходный GLB');
  const original = originalBuffer instanceof Uint8Array
    ? originalBuffer : new Uint8Array(originalBuffer);
  const io = new WebIO().registerExtensions(KHRONOS_EXTENSIONS);
  onProgress(12, 'Читаем оригинальный GLB без повторного кодирования...');
  const document = await io.readBinary(original);
  const sourceTriangles = countTriangles(document);
  const skins = document.getRoot().listSkins().length;
  const animations = document.getRoot().listAnimations().length;
  onProgress(28, 'Анализируем геометрию и скелеты...');
  let geometryNote = '';
  if (geometry && ratio < 1 && skins === 0 && sourceTriangles > 0) {
    await MeshoptSimplifier.ready;
    onProgress(35, 'Упрощаем сетку с помощью Meshoptimizer...');
    await document.transform(weld(), simplify({
      simplifier: MeshoptSimplifier, ratio, error,
      lockBorder: true, cleanup: false
    }));
  } else if (skins) {
    geometryNote = 'Скелет обнаружен: упрощение сетки отключено для защиты весов и анимаций.';
  } else if (!geometry) {
    geometryNote = 'Упрощение сетки отключено.';
  }
  const optimizedTriangles = countTriangles(document);
  if (skins === 0 && optimizedTriangles > sourceTriangles)
    throw Error('Оптимизация неожиданно увеличила число треугольников');
  onProgress(65, 'Сохраняем текстуры и ограничиваем разрешение...');
  const textureStats = await resizeTextures(document, texture);
  onProgress(86, 'Собираем стандартный GLB 2.0 для Godot...');
  const output = await io.writeBinary(document);
  if (output.byteLength >= original.byteLength) {
    throw Error('Файл стал больше: ' + formatSize(original.byteLength) + ' → ' +
      formatSize(output.byteLength) + '. Не сохраняем ухудшенный результат. ' +
      'Попробуй режим «Экономия» или меньше текстуры.');
  }
  // No Draco, meshopt buffer compression, or WebP requirement is added.
  const forbidden = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression',
    'KHR_texture_basisu', 'EXT_texture_webp'];
  const optimizedIO = await io.readBinary(output);
  const required = optimizedIO.getRoot().listExtensionsRequired().map(e => e.extensionName);
  if (required.some(e => forbidden.includes(e)))
    throw Error('Результат требует внешнего декодера: ' + required.join(', '));
  if (optimizedIO.getRoot().listSkins().length !== skins ||
      optimizedIO.getRoot().listAnimations().length !== animations)
    throw Error('Обнаружена потеря скелета или анимаций. Сохранение отменено.');
  onProgress(100, 'Готово');
  return { bytes: output, beforeBytes: original.byteLength,
    afterBytes: output.byteLength, sourceTriangles, optimizedTriangles,
    skins, animations, textureStats, note: geometryNote };
}

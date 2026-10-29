/**
 * Safe offline BVH preview. BVH stores skeleton motion, not skinned meshes.
 * Retargeting this clip to arbitrary VRM/FBX rigs requires bone-name mapping,
 * rest-pose alignment and scale correction and is deliberately NOT assumed.
 */
import * as THREE from 'three';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';

export function importBvhMotion(text,{name='BVH Animation'}={}) {
 if(typeof text!=='string'||text.length>20*1048576)
   throw Error('BVH слишком большой для безопасного просмотра на Android (20 МБ)');
 if(!/^\s*HIERARCHY\b/.test(text)||!/\bMOTION\b/.test(text))
   throw Error('BVH должен содержать разделы HIERARCHY и MOTION');
 const match=text.match(/\bFrames:\s*(\d+)/i);
 if(!match||!Number.isSafeInteger(Number(match[1]))||Number(match[1])<1||Number(match[1])>18000)
   throw Error('BVH: неподдерживаемая длительность (максимум 18 000 кадров)');
 const {skeleton,clip}=new BVHLoader().parse(text);
 if(!skeleton?.bones?.length||!clip?.tracks?.length)
   throw Error('BVH не содержит анимированного скелета');
 const root=new THREE.Group();root.name='BVH: '+name;
 const skeletonRoot=skeleton.bones[0];
 root.add(skeletonRoot);
 const helper=new THREE.SkeletonHelper(skeletonRoot);
 helper.name='BVH: линии костей';root.add(helper);
 clip.name=name;
 return {root,clips:[clip],notice:'BVH: '+skeleton.bones.length+
   ' костей, '+match[1]+' кадров. Воспроизведение движения без 3D-меша; перенос на другой риг пока не выполняется.',
   bvhOnly:true};
}

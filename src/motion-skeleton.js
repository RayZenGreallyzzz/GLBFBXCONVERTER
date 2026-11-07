import * as THREE from 'three';
import {canonicalBone} from './animation-retarget.js';
const MiB=1048576;
// Export/decomposition noise can leave a nominal unit scale at 1.0000156.
// Accept at most 0.005% relative error, then use a uniform private copy.
// A relative check matters for centimeter armatures and very small rigs too.
const SCALE_ROUNDING=5e-5;
const sameScale=(a,b)=>Number.isFinite(a)&&a>0&&Number.isFinite(b)&&b>0&&Math.abs(a-b)<=SCALE_ROUNDING*Math.max(a,b);
function binding(root,track){const p=THREE.PropertyBinding.parseTrackName(track.name);let node=THREE.PropertyBinding.findNode(root,p.nodeName);if(p.objectName==='bones')node=node?.skeleton?.bones.find(b=>b.name===p.objectIndex)||root.getObjectByName(p.objectIndex);else if(p.objectName)return null;return node&&p.propertyIndex===undefined?{node,property:p.propertyName}:null}
export function skeletonMotionSource(root,animations,kind){
 const nodes=[],actual=[];root.traverse(n=>{nodes.push(n);if(n.isBone)actual.push(n)});
 if(!animations?.length)throw Error('В файле нет анимаций');
 if(!actual.length&&!nodes.some(n=>canonicalBone(n.name)==='hips'))throw Error('В файле нет распознаваемого скелета');
 const needed=new Set();for(const node of actual.length?actual:nodes)for(let p=node;p;p=p.parent){needed.add(p);if(p===root)break}
 if(needed.size>200)throw Error('В источнике больше 200 узлов скелета');
 const graph=new THREE.Group(),copies=new Map(),names=new Set();
 for(const node of nodes)if(needed.has(node)){
  const b=new THREE.Bone();let name=THREE.PropertyBinding.sanitizeNodeName(node.name||'MotionNode'),suffix=1;while(names.has(name))name=THREE.PropertyBinding.sanitizeNodeName(node.name||'MotionNode')+'_'+suffix++;names.add(name);b.name=name;
  b.position.copy(node.position);b.quaternion.copy(node.quaternion);b.scale.copy(node.scale);
  const meanScale=(b.scale.x+b.scale.y+b.scale.z)/3;
  if(![...b.position.toArray(),...b.quaternion.toArray()].every(Number.isFinite)||!b.scale.toArray().every(s=>sameScale(s,meanScale)))throw Error('Для переноса нужен положительный равномерный масштаб скелета. Узел «'+b.name+'»: '+b.scale.toArray().map(v=>Number(v.toPrecision(7))).join(', '));
  b.scale.setScalar(meanScale);
  (copies.get(node.parent)||graph).add(b);copies.set(node,b);
 }
 const warnings=[],clips=[];let skipped=0,trackBytes=0;
 for(const original of animations){
  const tracks=[],targets=new Set();let rotations=0,invalid='';
  for(const track of original.tracks){
   const target=binding(root,track),copy=target&&copies.get(target.node);if(!copy||!['quaternion','position','scale'].includes(target.property)){skipped++;continue}
   if(track.times.length>18000||!track.times.length||!track.values.every(Number.isFinite)||track.times.some((v,i)=>!Number.isFinite(v)||v<0||i&&v<=track.times[i-1])){invalid='неподдерживаемые или повреждённые ключи';break}
   if(target.property==='scale'){
    if(track.createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline||track.values.some((v,i)=>!sameScale(v,copy.scale.getComponent(i%3)))){invalid='меняется масштаб скелета; такой перенос пока не поддерживается';break}continue;
   }
   const width=target.property==='quaternion'?4:3,multiplier=track.createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline?3:1,key=copy.name+'.'+target.property;
   if(track.values.length!==track.times.length*width*multiplier||targets.has(key)){invalid='не совпал размер или повторяется дорожка кости';break}targets.add(key);
   trackBytes+=track.times.byteLength+track.values.byteLength;if(trackBytes>64*MiB)throw Error('Ключи движений в файле превышают 64 МиБ. Раздели набор на несколько файлов.');
   const clone=track.clone();clone.name=copy.name+'.'+target.property;tracks.push(clone);if(target.property==='quaternion')rotations++;
  }
  if(invalid||!rotations||!Number.isFinite(original.duration)||original.duration<=0){warnings.push('Пропущено движение «'+(original.name||'без названия')+'»: '+(invalid||'нет поддерживаемых вращений или длительности')+'.');continue}
  const name=String(original.name||'Motion').replace(/[^\p{L}\p{N}_ -]/gu,'_').slice(0,60)||'Motion';
  const clip=new THREE.AnimationClip(name,original.duration,tracks);clips.push(clip);
 }
 if(!clips.length)throw Error(warnings[0]||'В файле нет поддерживаемых анимаций костей');
 if(clips.length>100)throw Error('В одном файле допускается до 100 движений');
 if(skipped)warnings.push('Нескелетные каналы (например, мимика и материалы) не переносятся: '+skipped+'.');
 warnings.push('Переносятся повороты костей и, по выбору, движение таза. Скелет и веса персонажа сохраняются.');
 graph.updateMatrixWorld(true);const bones=[...copies.values()];return {kind,root:graph,skeleton:new THREE.Skeleton(bones),clips,clip:clips[0],warnings};
}

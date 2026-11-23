import {canonicalBone} from './animation-retarget.js';
import {RIG_EXTRAS} from './rig-guides.js';

const names={
  hips:'Таз',spine:'Поясница',spine1:'Корпус',spine2:'Грудь',neck:'Шея',head:'Голова',
  headend:'Верх головы',leftshoulder:'Левая ключица',rightshoulder:'Правая ключица',
  leftarm:'Левое плечо',rightarm:'Правое плечо',leftforearm:'Левое предплечье',rightforearm:'Правое предплечье',
  lefthand:'Левая кисть',righthand:'Правая кисть',leftupleg:'Левое бедро',rightupleg:'Правое бедро',
  leftleg:'Левая голень',rightleg:'Правая голень',leftfoot:'Левая стопа',rightfoot:'Правая стопа',
  lefttoebase:'Пальцы левой стопы',righttoebase:'Пальцы правой стопы'
};

export function detailBoneLabel(name,index){
  const id=canonicalBone(name);
  if(names[id])return names[id];
  for(const chain of Object.values(RIG_EXTRAS)){
    const prefix='Forge'+chain.bone;
    if(name?.startsWith(prefix)&&/^[1-5]$/.test(name.slice(prefix.length)))return chain.label+' · Кость '+name.slice(prefix.length);
  }
  if(/ · Кость \d+$/.test(name||''))return name;
  return 'Кость '+(index+1);
}

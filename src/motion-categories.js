export const MOTION_CATEGORIES=Object.freeze([
 {id:'all',label:'Все'}, {id:'idle',label:'Idle · Стойки'},
 {id:'walk',label:'Walk · Ходьба'}, {id:'run',label:'Run · Бег'},
 {id:'attack',label:'Attack · Атаки'}, {id:'other',label:'Прочее'}
]);
const ids=new Set(MOTION_CATEGORIES.map(c=>c.id));
export function motionCategory(value){return ids.has(value)?value:'other'}
function classify(text){
 const s=String(text).replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().replace(/[_\d./\\-]+/g,' ');
 // A hit reaction is not an attack. Keep falls, death and damage in Other.
 if(/\b(death|die|dead|hurt|damage|hit react\w*|get hit|take hit|knock\w*)\b|смерт|поражен|ранени|получ.*удар|падени/.test(s))return 'other';
 if(/\b(attack\w*|punch\w*|kick\w*|slash\w*|shoot\w*|strike\w*|stab\w*|thrust\w*|melee\w*|bite\w*|cast\w*|fire|swing\w*)\b|атак|удар|стрельб|выстрел|укус/.test(s))return 'attack';
 if(/\b(run\w*|running|jog\w*|sprint\w*)\b|бег|беж/.test(s))return 'run';
 if(/\b(walk\w*|walking)\b|ходьб|ходить|шага/.test(s))return 'walk';
 if(/\b(idle\w*|stand\w*|breath\w*|rest|t pose|a pose)\b|стойк|ожидани|дыхани|покой/.test(s))return 'idle';
 return null;
}
export function classifyMotion(name,path=''){
 // A named take is more specific than its folder (e.g. Sword/Idle).
 return classify(name)??classify(path.split('/').at(-1))??classify(path)??'other';
}
export function matchesMotion(entry,query='',category='all'){
 if(category!=='all'&&(entry.category||classifyMotion(entry.title||'',entry.path))!==category)return false;
 const haystack=[entry.label,entry.title,entry.path,entry.source,...(entry.aliases||[])].filter(Boolean).join(' ').toLocaleLowerCase();
 return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(w=>haystack.includes(w));
}
export function categoryCounts(entries){
 const counts=Object.fromEntries(MOTION_CATEGORIES.map(c=>[c.id,0]));counts.all=entries.length;
 for(const entry of entries)counts[motionCategory(entry.category||classifyMotion(entry.title||'',entry.path))]++;
 return counts;
}
export function fillMotionCategories(select,entries,value='all'){
 const counts=categoryCounts(entries);select.replaceChildren();
 for(const {id,label}of MOTION_CATEGORIES){const option=document.createElement('option');option.value=id;option.textContent=label+' ('+counts[id]+')';select.append(option)}
 select.value=ids.has(value)?value:'all';
}

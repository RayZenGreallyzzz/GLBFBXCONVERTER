// VRChat requires a humanoid, skinned model, imported into Unity with the
// official VRChat SDK. This is a PREPARATION/PREFLIGHT utility, not an upload
// function, Unity package writer, or VRChat SDK replacement.
const keys=[
 'hips','spine','head','leftarm','leftforearm','lefthand',
 'rightarm','rightforearm','righthand',
 'leftupleg','leftleg','leftfoot','rightupleg','rightleg','rightfoot'
];
const alias={
 pelvis:'hips',chest:'spine',upperchest:'spine',
 leftupperarm:'leftarm',rightupperarm:'rightarm',
 leftlowerarm:'leftforearm',rightlowerarm:'rightforearm',
 leftthigh:'leftupleg',rightthigh:'rightupleg',
 leftshin:'leftleg',rightshin:'rightleg',
 leftcalf:'leftleg',rightcalf:'rightleg'
};
export function normalizeVRChatBone(name){
 const k=String(name||'').split(/[|/:\\]/).pop()
  .replace(/^mixamorig\d*[:_]?/i,'').replace(/[^a-z0-9]/gi,'').toLowerCase();
 return alias[k]||k;
}
export function inspectVRChatAvatar(root,{triangles=0,skinned=0,bones=0,materials=0,textures=0}={}){
 const matched=new Set();
 root?.traverse?.(node=>{if(node.isBone)matched.add(normalizeVRChatBone(node.name));});
 const missing=keys.filter(k=>!matched.has(k));
 const issues=[];
 if(!skinned)issues.push('Нет SkinnedMesh: нужен настоящий риг с весами.');
 if(missing.length)issues.push('Нет гуманоидных костей: '+missing.join(', ')+'.');
 const highTriangles=triangles>20000,pcHeavy=triangles>70000;
 if(highTriangles)issues.push('Для VRChat Android/Quest более 20 000 треугольников — Very Poor или хуже; сделай отдельный облегчённый вариант.');
 if(pcHeavy)issues.push('Для VRChat PC более 70 000 треугольников — Very Poor (нет строгого запрета на экспорт FBX).');
 const recommendations=[
  'Импортируй FBX в Unity через VRChat Creator Companion и SDK Avatars.',
  'В Unity установи Rig → Humanoid, проверь костный Avatar Mapping и T-позу.',
  'Добавь VRC Avatar Descriptor, viewpoint, visemes/blendshapes и допустимые shaders.',
  'Материалы, PhysBones, выражения и Android-сборку настраивай в Unity/VRChat SDK.',
  'Для Quest/Android делай отдельный оптимизированный вариант, не заменяя оригинал.'
 ];
 return {rigged:skinned>0&&missing.length===0,missing,issues,recommendations,
  pcTriangles:triangles,androidHighPoly:highTriangles,pcHeavy,
  materials,textures,bones};
}
export function assertVRChatReady(report){
 if(!report?.rigged)throw Error('VRChat: нужен гуманоидный скелет с весами. '+
  (report?.issues?.filter(x=>/SkinnedMesh|костей/.test(x)).join(' ')||''));
 return true;
}

// Minimal, explicit VRM 1.0 HUMANOID export from a properly rigged glTF.
// VRM 0.x is only supported by lossless source copy in this application.
import {inspectGlb} from './format.js';

const HUMAN={
 hips:['hips','pelvis'],spine:['spine','spine1'],chest:['chest','spine2'],
 upperChest:['upperchest','spine3'],neck:['neck'],head:['head'],
 leftShoulder:['leftshoulder'],leftUpperArm:['leftupperarm','leftarm'],
 leftLowerArm:['leftlowerarm','leftforearm','leftelbow'],leftHand:['lefthand'],
 rightShoulder:['rightshoulder'],rightUpperArm:['rightupperarm','rightarm'],
 rightLowerArm:['rightlowerarm','rightforearm','rightelbow'],rightHand:['righthand'],
 leftUpperLeg:['leftupperleg','leftupleg','leftthigh'],
 leftLowerLeg:['leftlowerleg','leftleg','leftshin'],leftFoot:['leftfoot'],
 rightUpperLeg:['rightupperleg','rightupleg','rightthigh'],
 rightLowerLeg:['rightlowerleg','rightleg','rightshin'],rightFoot:['rightfoot'],
 leftToes:['lefttoes','lefttoebase'],rightToes:['righttoes','righttoebase'],
 leftEye:['lefteye'],rightEye:['righteye'],jaw:['jaw']
};
const REQUIRED=[
 'hips','spine','head','leftUpperArm','leftLowerArm','leftHand',
 'rightUpperArm','rightLowerArm','rightHand','leftUpperLeg','leftLowerLeg','leftFoot',
 'rightUpperLeg','rightLowerLeg','rightFoot'
];
const norm=s=>String(s||'').split(/[|/:\\]/).pop().replace(/^mixamorig\d*[:_]?/i,'')
 .replace(/[^a-z0-9]/gi,'').toLowerCase();
export function detectHumanoidBones(doc){
 const map=new Map();
 (doc.nodes||[]).forEach((node,i)=>{
   const key=norm(node.name);
   if(key&&!map.has(key))map.set(key,i);
 });
 const humanBones={};
 for(const [human,aliases] of Object.entries(HUMAN)){
   const found=aliases.map(a=>map.get(a)).find(x=>Number.isInteger(x));
   if(found!==undefined)humanBones[human]={node:found};
 }
 const missing=REQUIRED.filter(k=>!humanBones[k]);
 return {humanBones,missing};
}
function assertHierarchy(doc,humanBones){
 const parents=new Map();
 (doc.nodes||[]).forEach((n,i)=>{
   for(const child of n.children||[])parents.set(child,i);
 });
 const chain=(child,parent)=>{
   const start=humanBones[child]?.node,target=humanBones[parent]?.node;
   if(start===undefined||target===undefined)return true;
   let i=start;
   while(i!==undefined){
     if(i===target)return true;
     i=parents.get(i);
   }
   return false;
 };
 const requirements=[
  ['spine','hips'],['head','spine'],
  ...['left','right'].flatMap(side=>[
   [side+'UpperArm','spine'],[side+'LowerArm',side+'UpperArm'],
   [side+'Hand',side+'LowerArm'],
   [side+'UpperLeg','hips'],[side+'LowerLeg',side+'UpperLeg'],
   [side+'Foot',side+'LowerLeg']
  ])
 ];
 const bad=requirements.filter(([a,b])=>!chain(a,b));
 if(bad.length)throw Error('VRM 1.0: неправильная иерархия костей: '+
   bad.map(([a,b])=>a+' не потомок '+b).join(', '));
}
export function addVrm1Extension(doc,{name='Avatar',author='Автор модели'}={}){
 const result=structuredClone(doc);
 if(!(result.skins||[]).length)throw Error('Для VRM нужен GLB со скелетом и весами');
 const {humanBones,missing}=detectHumanoidBones(result);
 if(missing.length)throw Error('VRM: не найдены обязательные кости '+missing.join(', '));
 assertHierarchy(result,humanBones);
 const joints=new Set(result.skins.flatMap(s=>s.joints||[]));
 const outside=REQUIRED.filter(k=>!joints.has(humanBones[k].node));
 if(outside.length)throw Error('VRM: кости не принадлежат привязанному скину: '+outside.join(', '));
 if(result.extensions?.VRM||result.extensions?.VRMC_vrm)
   throw Error('Исходный файл уже имеет VRM — сохраняй исходник без изменений');
 const label=String(name).trim().slice(0,100)||'Avatar';
 const creator=String(author).trim().slice(0,100)||'Автор модели';
 result.extensionsUsed=[...new Set([...(result.extensionsUsed||[]),'VRMC_vrm'])];
 result.extensions={...(result.extensions||{}),VRMC_vrm:{
   specVersion:'1.0',
   meta:{
     name:label,authors:[creator],licenseUrl:'https://vrm.dev/licenses/1.0/',
     avatarPermission:'onlyAuthor',commercialUsage:'personalNonProfit',
     creditNotation:'required',allowRedistribution:false,
     modification:'prohibited',allowExcessivelyViolentUsage:false,
     allowExcessivelySexualUsage:false,allowPoliticalOrReligiousUsage:false
   },
   humanoid:{humanBones}
 }};
 // Pure VRM 1.0 is a single static avatar; ordinary glTF animation clips
 // should be exported separately in a .glb, rather than embedded in .vrm.
 delete result.animations;
 return result;
}
export function rewriteGlbJson(data,doc){
 const bytes=data instanceof Uint8Array?data:new Uint8Array(data);
 const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const jsonLength=dv.getUint32(12,true),afterJSON=20+jsonLength;
 const encoder=new TextEncoder();
 const text=encoder.encode(JSON.stringify(doc));
 const padded=Math.ceil(text.byteLength/4)*4,tail=bytes.slice(afterJSON);
 const output=new Uint8Array(20+padded+tail.length);
 const view=new DataView(output.buffer);
 view.setUint32(0,0x46546c67,true);view.setUint32(4,2,true);
 view.setUint32(8,output.byteLength,true);view.setUint32(12,padded,true);
 view.setUint32(16,0x4e4f534a,true);
 output.fill(0x20,20,20+padded);output.set(text,20);output.set(tail,20+padded);
 return output;
}
export function makeVrm1(glb,options={}){
 const parsed=inspectGlb(glb);
 const doc=addVrm1Extension(parsed.json,options);
 const output=rewriteGlbJson(glb,doc);
 const verify=inspectGlb(output);
 if(!verify.json.extensions?.VRMC_vrm?.humanoid?.humanBones?.hips)
   throw Error('Не удалось проверить VRM 1.0');
 return output;
}

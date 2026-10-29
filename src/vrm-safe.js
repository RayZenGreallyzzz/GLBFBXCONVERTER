import {inspectGlb} from './format.js';
// VRM 0.x and VRM 1.0 are GLB containers with extra required semantics.
// Preserve exact original bytes when saving source VRM — do not pretend a
// generic GLB becomes a compliant VRM merely by changing extension.
export function inspectVrm(value) {
 const metadata=inspectGlb(value),ex=metadata.json.extensions||{};
 const v1=ex.VRMC_vrm;
 const v0=ex.VRM;
 if(!v1&&!v0)throw Error('У файла нет расширения VRM 0.x или VRMC_vrm 1.0. Обычный GLB нельзя переименовать в VRM.');
 if(v1 && (typeof v1!=='object'||!v1.humanoid?.humanBones))
   throw Error('VRM 1.0 не содержит корректных Humanoid-костей');
 if(v0 && (typeof v0!=='object'||!v0.humanoid))
   throw Error('VRM 0.x не содержит Humanoid-описания');
 return {...metadata,vrmVersion:v1?'VRM 1.0':'VRM 0.x'};
}

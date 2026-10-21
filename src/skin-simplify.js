/**
 * Conservative LOD for already-rigged GLB characters.
 *
 * Every output vertex is taken from an existing input vertex, and all glTF
 * vertex attributes (including JOINTS_0 / WEIGHTS_0 / UV) are compacted
 * together. No skeletons, bind matrices, animation tracks, or original GLB
 * data are edited. Vertex weighting signatures make changing bone influence
 * regions expensive for the simplifier.
 */
import { compactPrimitive, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const MAX_VERTICES = 1_200_000;
const TRIANGLES = 4;
const COMPONENT_FLOAT = 5126;
const COMPONENT_USHORT = 5123;
const COMPONENT_UBYTE = 5121;

// Deterministic signed embedding for bone IDs; avoids falsely treating
// numerical IDs (e.g. bone 1 and bone 2) as spatially close together.
function boneSignature(index,slot) {
 let x = (Math.imul(index+1, 0x9e3779b1) ^ Math.imul(slot+1, 0x85ebca6b))>>>0;
 x = Math.imul(x ^ (x>>>16), 0x7feb352d)>>>0;
 return (x & 1) ? 1 : -1;
}
const copyFloat=(accessor,count,size)=>{
 if(!accessor)return null;
 if(accessor.getType()!==({2:'VEC2',3:'VEC3',4:'VEC4'}[size]) ||
    accessor.getComponentType()!==COMPONENT_FLOAT) return null;
 const values=accessor.getArray();
 return values?.length===count*size?values:null;
};

function checkSkin(prim){
 const position=prim.getAttribute('POSITION'),joint=prim.getAttribute('JOINTS_0');
 const weight=prim.getAttribute('WEIGHTS_0'),count=position?.getCount();
 if(!position||!joint||!weight||!count)throw Error(
   'У модели со скелетом отсутствуют координаты, JOINTS_0 или WEIGHTS_0');
 if(prim.getMode()!==TRIANGLES)throw Error(
   'Скелетная сетка с режимом рисования не TRIANGLES пока не упрощается');
 if(prim.listTargets().length)throw Error(
   'В модели есть Blend Shapes/Morph Targets. Упрощение отключено для защиты мимики');
 if(prim.getAttribute('JOINTS_1')||prim.getAttribute('WEIGHTS_1'))
   throw Error('Более четырёх костных влияний на вершину: упрощение пока недоступно');
 if(count>MAX_VERTICES)
   throw Error('Сетка содержит больше 1,2 млн вершин; для Android нужна предварительная подготовка');
 if(joint.getCount()!==count||weight.getCount()!==count)
   throw Error('Количество вершин и костных весов не совпадает');
 if(joint.getType()!=='VEC4'||weight.getType()!=='VEC4'||
   ![COMPONENT_UBYTE,COMPONENT_USHORT].includes(joint.getComponentType())||
   weight.getComponentType()!==COMPONENT_FLOAT)
   throw Error('Этот формат хранения весов требует отдельной безопасной обработки');
 return count;
}
function buildSignature(prim){
 const count=checkSkin(prim);
 const positions=copyFloat(prim.getAttribute('POSITION'),count,3);
 const weights=copyFloat(prim.getAttribute('WEIGHTS_0'),count,4);
 const ids=prim.getAttribute('JOINTS_0').getArray();
 if(!positions||!weights||!ids)
   throw Error('Только Float32 координаты/веса пока поддерживаются для безопасного LOD');
 const normal=copyFloat(prim.getAttribute('NORMAL'),count,3);
 const uv=copyFloat(prim.getAttribute('TEXCOORD_0'),count,2);
 if(prim.getAttribute('TEXCOORD_0')&&!uv)
   throw Error('UV с нестандартной упаковкой: изменение сетки отменено');
 const stride=(normal?3:0)+(uv?2:0)+8;
 const attrs=new Float32Array(stride*count),attrWeights=[];
 if(normal)attrWeights.push(1.25,1.25,1.25);
 if(uv)attrWeights.push(2,2);
 for(let i=0;i<8;i++)attrWeights.push(5);
 const locks=new Uint8Array(count);
 for(let i=0;i<count;i++){
   let dst=i*stride,offset=0;
   if(normal){for(let j=0;j<3;j++)attrs[dst+offset++]=normal[i*3+j];}
   if(uv){for(let j=0;j<2;j++)attrs[dst+offset++]=uv[i*2+j];}
   const base=offset;
   for(let j=0;j<4;j++){
     const weight=weights[i*4+j],bone=ids[i*4+j];
     if(!Number.isFinite(weight)||weight<0||weight>1.001||bone>65535)
       throw Error('Некорректные костные веса в исходном GLB');
     if(weight<=0)continue;
     for(let k=0;k<8;k++)attrs[dst+base+k]+=weight*boneSignature(bone,k);
   }
   // Preserve sensitive multi-influence areas (elbows, knees, fingers).
   // Locking 3+ significant weights is conservative but still allows
   // many single/two-bone surface triangles to simplify.
   const sorted=[weights[i*4],weights[i*4+1],weights[i*4+2],weights[i*4+3]]
     .sort((a,b)=>b-a);
   if(sorted[2]>.15)locks[i]=1;
 }
 return {positions,attrs,stride,attrWeights,locks,count};
}
/**
 * Returns detailed counts. Mutates ONLY glTF-Transform's in-memory Document.
 * Caller compares output to original, reopens it for structural validation,
 * and discards any result that did not make the file smaller.
 */
export async function simplifySkinnedMeshes(document,{ratio=.75,error=.008}={}){
 const skinned=new Set(document.getRoot().listNodes()
   .filter(node=>node.getSkin()&&node.getMesh()).map(node=>node.getMesh()));
 if(!skinned.size)return {supported:0,reduced:0,trianglesBefore:0,trianglesAfter:0};
 await MeshoptSimplifier.ready;
 const stats={supported:0,reduced:0,trianglesBefore:0,trianglesAfter:0};
 for(const mesh of skinned){
   for(const prim of mesh.listPrimitives()){
     const starting=checkSkin(prim);
     // Weld joins only bitwise-identical attribute tuples. This cannot
     // change position/weight/UV data or animate differently.
     weldPrimitive(prim);
     const data=buildSignature(prim);
     let indices=prim.getIndices()?.getArray();
     if(!indices)throw Error('Не удалось построить индексную сетку');
     if(indices.length%3)throw Error('Некорректные треугольники в скелетной модели');
     stats.supported++;
     stats.trianglesBefore+=indices.length/3;
     const requested=Math.floor(indices.length*ratio/3)*3;
     const target=Math.max(3,requested);
     if(indices.length<=3||target>=indices.length) {
       stats.trianglesAfter+=indices.length/3;
       continue;
     }
     const [newIndices]=MeshoptSimplifier.simplifyWithAttributes(
       indices instanceof Uint32Array?indices:new Uint32Array(indices),
       data.positions,3,data.attrs,data.stride,data.attrWeights,data.locks,
       target,error,['LockBorder','Regularize']
     );
     if(newIndices.length<3||newIndices.length%3||newIndices.length>indices.length)
       throw Error('Алгоритм упрощения создал некорректную топологию');
     if(newIndices.length<indices.length){
       // Clone the indices accessor to avoid touching shared data.
       prim.setIndices(prim.getIndices().clone().setArray(newIndices));
       // Uses a single remap for ALL attributes and morph targets.
       compactPrimitive(prim);
       const destCount=prim.getAttribute('POSITION').getCount();
       if(destCount<1||destCount>starting)
         throw Error('Оптимизация вершин нарушила геометрию');
       if(prim.getAttribute('JOINTS_0').getCount()!==destCount||
         prim.getAttribute('WEIGHTS_0').getCount()!==destCount)
         throw Error('Не совпадает количество весов после упрощения');
       stats.reduced++;
     }
     stats.trianglesAfter+=prim.getIndices().getCount()/3;
   }
 }
 return stats;
}

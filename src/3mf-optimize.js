// Direct low-memory optimization for static 3MF meshes.
// Do not create a full-size intermediate GLB just to simplify FoxGi.
import * as THREE from 'three';
import {MeshoptSimplifier} from 'meshoptimizer';

function compactGeometry(geometry,indices){
 const oldPosition=geometry.getAttribute('position');
 const vertexCount=oldPosition.count;
 const remap=new Uint32Array(vertexCount);
 remap.fill(0xffffffff);
 let used=0;
 const compactedIndex=new Uint32Array(indices.length);
 for(let i=0;i<indices.length;i++){
  const old=indices[i];
  if(old>=vertexCount)throw Error('3MF LOD: индекс вне границ исходной сетки');
  let mapped=remap[old];
  if(mapped===0xffffffff){mapped=used++;remap[old]=mapped}
  compactedIndex[i]=mapped;
 }
 const out=new THREE.BufferGeometry();
 for(const [key,attr] of Object.entries(geometry.attributes)){
  if(attr.isInterleavedBufferAttribute)
   throw Error('3MF LOD: interleaved атрибуты требуют отдельного импорта');
  const size=attr.itemSize,source=attr.array,Type=source.constructor;
  const data=new Type(used*size);
  for(let old=0;old<vertexCount;old++){
   const dest=remap[old];
   if(dest===0xffffffff)continue;
   for(let k=0;k<size;k++)data[dest*size+k]=source[old*size+k];
  }
  out.setAttribute(key,new THREE.BufferAttribute(data,size,attr.normalized));
 }
 out.setIndex(new THREE.BufferAttribute(
  used<=65535?new Uint16Array(compactedIndex):compactedIndex,1));
 return out;
}

export async function simplify3mfScene(root,{ratio=.5,error=.025,
 onProgress=()=>{}}={}){
 if(!Number.isFinite(ratio)||ratio<=0||ratio>1)
  throw Error('3MF LOD: неверная доля треугольников');
 if(!Number.isFinite(error)||error<0)
  throw Error('3MF LOD: неверная погрешность');
 await MeshoptSimplifier.ready;
 const result=new THREE.Group();
 result.name='3MF optimized copy';
 root.updateWorldMatrix(true,true);
 const meshes=[];
 root.traverse(node=>{if(node.isMesh&&node.visible)meshes.push(node)});
 if(!meshes.length)throw Error('3MF LOD: пустая модель');
 let sourceTriangles=0,optimizedTriangles=0;
 try{
  for(let n=0;n<meshes.length;n++){
   const node=meshes[n],geo=node.geometry;
   const pos=geo?.getAttribute('position'),idx=geo?.getIndex(),uv=geo?.getAttribute('uv');
   if(!pos||!idx)throw Error('3MF LOD: нужна индексированная сетка');
   if(geo.groups.length>1)throw Error('3MF LOD: несколько материалов в одном меше требуют предварительного разделения');
   if(!pos.isBufferAttribute||!(pos.array instanceof Float32Array))
    throw Error('3MF LOD: нужны Float32 координаты вершин');
   if(uv&&(!(uv.array instanceof Float32Array)||uv.itemSize!==2||uv.count!==pos.count))
    throw Error('3MF LOD: несовместимый UV-атрибут');
   const before=Math.floor(idx.count/3),srcIndex=idx.array;
   sourceTriangles+=before;
   onProgress(Math.round(n/meshes.length*55)+10,'Упрощаем 3MF без промежуточного GLB…');
   const target=Math.max(3,Math.floor(before*ratio)*3);
   let newIndices=srcIndex;
   if(target<srcIndex.length){
    // UV atlas is a hard visual constraint: compare positions and texture
    // coordinates while locking visible mesh borders.
    const locks=new Uint8Array(pos.count);
    const options=['LockBorder','Regularize'];
    if(uv){
     [newIndices]=MeshoptSimplifier.simplifyWithAttributes(
      srcIndex instanceof Uint32Array?srcIndex:new Uint32Array(srcIndex),
      pos.array,3,uv.array,2,[5,5],locks,target,error,options);
    }else{
     [newIndices]=MeshoptSimplifier.simplify(
      srcIndex instanceof Uint32Array?srcIndex:new Uint32Array(srcIndex),
      pos.array,3,target,error,options);
    }
   }
   if(!newIndices.length||newIndices.length%3)
    throw Error('3MF LOD: оптимизатор вернул пустую сетку');
   optimizedTriangles+=newIndices.length/3;
   const out=compactGeometry(geo,newIndices);
   const mesh=new THREE.Mesh(out,node.material);
   mesh.name=node.name;
   mesh.matrixAutoUpdate=false;
   mesh.matrix.copy(node.matrixWorld);
   result.add(mesh);
   onProgress(Math.round((n+1)/meshes.length*55)+10,'Сохранены UV и исходные материалы…');
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  return {root:result,sourceTriangles,optimizedTriangles};
 }catch(error){
  for(const mesh of result.children)mesh.geometry.dispose();
  throw error;
 }
}
export function release3mfSimplifiedGeometry(root){
 root?.traverse(node=>{if(node.isMesh)node.geometry.dispose()});
}

import {Matrix3, Matrix4, ShapeUtils, Vector2, Vector3} from 'three';
import {Accessor, PropertyType} from '@gltf-transform/core';
import {prune} from '@gltf-transform/functions';
import {attributeValues} from './static-simplify.js';
import {createCodecIO, removeGeometryCompression} from './codec-io.js';
import {inspectGlb} from './format.js';

export const CUT_MATERIAL='Forge · Срез';
const toMat=value=>new Matrix4().fromArray(value);
const planes=[[0,-1],[0,1],[1,-1],[1,1],[2,-1],[2,1]];
const epsilon=1e-8;
const axisIndex=['x','y','z'];
const planeDistance=(p,[axis,sign])=>sign*p.xyz.getComponent(axis)-.5;
const signedKey=(point,tolerance)=>point.toArray().map(x=>Math.round(x/tolerance)).join(':');
const trimWeight=(v)=>Math.min(1,Math.max(0,v));

function clipPolygon(input,plane,inside) {
  const output=[];
  for(let i=0;i<input.length;i++){
    const a=input[i],b=input[(i+1)%input.length],d=planeDistance(a,plane),e=planeDistance(b,plane);
    const retain=inside?d<=epsilon:d>=-epsilon, next=inside?e<=epsilon:e>=-epsilon;
    if(retain)output.push(a);
    if(retain===next||Math.abs(d-e)<1e-18)continue;
    const t=trimWeight(d/(d-e)), xyz=a.xyz.clone().lerp(b.xyz,t);
    xyz[axisIndex[plane[0]]]=plane[1]*.5;
    output.push({xyz, bary:a.bary.map((w,k)=>w+(b.bary[k]-w)*t),ids:a.ids});
  }
  return output;
}

function different(a,b){return a.xyz.distanceToSquared(b.xyz)>epsilon*epsilon}
function clean(poly){return poly.filter((p,i)=>different(p,poly[(i+poly.length-1)%poly.length]))}

function readPart(primitive){
  const read=prop=>prop.listSemantics().map(name=>{
    const a=prop.getAttribute(name);
    return {name,type:a.getType(),width:a.getElementSize(),values:attributeValues(a)};
  });
  const attrs=read(primitive), targets=primitive.listTargets().map(read), positions=attrs.find(a=>a.name==='POSITION')?.values;
  if(primitive.getMode()!==4||!positions||attrs.some(a=>/^(JOINTS|WEIGHTS)_[1-9]/.test(a.name)))
    throw Error('Ножу нужна треугольная сетка с четырьмя влияниями на вершину.');
  return {attrs,targets,positions,
    indices:primitive.getIndices()?.getArray()||Uint32Array.from({length:positions.length/3},(_,i)=>i),
    joints:attrs.find(a=>a.name==='JOINTS_0'),weights:attrs.find(a=>a.name==='WEIGHTS_0')};
}

function interpolated(attr,v){
  const result=new Array(attr.width).fill(0);
  for(let i=0;i<3;i++) {
    const from=v.ids[i]*attr.width,w=v.bary[i];
    for(let k=0;k<attr.width;k++)result[k]+=attr.values[from+k]*w;
  }
  return result;
}

function skinWeights(data,v){
  const sums=new Map();
  for(let i=0;i<3;i++)for(let k=0;k<4;k++){
    const index=v.ids[i]*4+k,id=data.joints.values[index],weight=data.weights.values[index]*v.bary[i];
    if(weight>0)sums.set(id,(sums.get(id)||0)+weight);
  }
  const rows=[...sums].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,4),sum=rows.reduce((s,[,w])=>s+w,0);
  if(!(sum>0))throw Error('На участке среза обнаружены пустые веса.');
  return {JOINTS_0:Array.from({length:4},(_,i)=>rows[i]?.[0]||0),
    WEIGHTS_0:Array.from({length:4},(_,i)=>(rows[i]?.[1]||0)/sum)};
}

function builders(data, document, buffer, options={}){
  const {capNormal}=options;
  const output=document.createPrimitive();
  const attrRows=data.attrs.filter(a=>!capNormal||['POSITION','NORMAL','JOINTS_0','WEIGHTS_0'].includes(a.name))
    .map(attr=>({...attr,out:[]}));
  if(capNormal&&!attrRows.some(a=>a.name==='NORMAL'))attrRows.push({name:'NORMAL',type:'VEC3',out:[]});
  const targets=data.targets.map(rows=>rows.map(a=>({...a,out:[]})));
  const indices=[], cache=new Map();
  const stored=options.keepOriginal?data.positions.length/3:0;
  if(stored)for(const a of [...attrRows,...targets.flat()]){
    a.out=new (a.name==='JOINTS_0'?Uint16Array:Float32Array)(a.values);
  }
  const added=[];
  function vertex(v){
    const saved=v.bary.findIndex(w=>w>1-epsilon);
    if(stored&&saved>=0)return v.ids[saved];
    const key=v.ids.map((id,i)=>[id,v.bary[i]]).filter(([,w])=>Math.abs(w)>epsilon)
      .sort(([a],[b])=>a-b).map(([id,w])=>id+':'+Math.round(w*1e8)).join('/');
    if(cache.has(key))return cache.get(key);
    const id=stored+added.push(v)-1;
    cache.set(key,id);
    return id;
  }
  function fan(poly){
    poly=clean(poly);
    if(poly.length<3)return;
    for(let i=1;i<poly.length-1;i++) {
      const a=poly[i].xyz.clone().sub(poly[0].xyz),b=poly[i+1].xyz.clone().sub(poly[0].xyz);
      if(a.cross(b).lengthSq()<epsilon**4)continue;
      indices.push(vertex(poly[0]),vertex(poly[i]),vertex(poly[i+1]));
    }
  }
  function finish(material){
    if(!indices.length){output.dispose();return null}
    const collect=new Map(),count=stored+added.length;
    if(count>1200000||indices.length>4500000)throw Error('Срез создал слишком много геометрии. Уменьши область ножа.');
    for(const a of [...attrRows,...targets.flat()]) {
      const typed=a.name==='JOINTS_0'?new Uint16Array(count*4):new Float32Array(count*(a.width||3));
      if(stored)typed.set(a.out);
      collect.set(a,typed);
    }
    const normal=new Vector3();
    for(const [i,v] of added.entries()){
      const skin=data.joints&&data.weights?skinWeights(data,v):{};
      for(const a of attrRows){
        let x=skin[a.name]||(capNormal&&a.name==='NORMAL'?capNormal:interpolated(a,v));
        if(a.name==='NORMAL'||a.name==='TANGENT'){
          const length=normal.fromArray(x).length();
          if(length>epsilon)normal.multiplyScalar(1/length);
          else normal.set(0,1,0);
          x=a.name==='NORMAL'?normal.toArray():[...normal.toArray(),x[3]<0?-1:1];
        }
        collect.get(a).set(x,(stored+i)*(a.width||3));
      }
      for(const a of targets.flat())collect.get(a).set(interpolated(a,v),(stored+i)*a.width);
    }
    const accessor=a=>document.createAccessor().setType(a.type).setBuffer(buffer).setArray(collect.get(a));
    for(const a of attrRows)output.setAttribute(a.name,accessor(a));
    for(const rows of targets){
      const target=document.createPrimitiveTarget();
      for(const a of rows)target.setAttribute(a.name,accessor(a));
      output.addTarget(target);
    }
    output.setIndices(document.createAccessor().setType(Accessor.Type.SCALAR).setBuffer(buffer)
      .setArray(count<=65535?Uint16Array.from(indices):Uint32Array.from(indices)));
    if(material)output.setMaterial(material);
    return output;
  }
  return {fan,finish,indices};
}

function addCutEdges(polygon,maps,tolerance){
  const poly=clean(polygon);
  for(let i=0;i<poly.length;i++){
    const a=poly[i], b=poly[(i+1)%poly.length];
    for(const [f,plane] of planes.entries()){
      if(Math.abs(planeDistance(a,plane))>epsilon*4||Math.abs(planeDistance(b,plane))>epsilon*4)continue;
      const ka=signedKey(a.xyz,tolerance),kb=signedKey(b.xyz,tolerance);
      if(ka===kb)continue;
      const id=ka<kb?ka+'|'+kb:kb+'|'+ka;
      if(maps[f].has(id))maps[f].delete(id);
      else maps[f].set(id,{ka,kb,a,b});
    }
  }
}

function contours(edges){
  const points=new Map(),neighbors=new Map();
  for(const {ka,kb,a,b} of edges.values()){
    points.set(ka,a);points.set(kb,b);
    if(!neighbors.has(ka))neighbors.set(ka,[]);
    if(!neighbors.has(kb))neighbors.set(kb,[]);
    neighbors.get(ka).push(kb);neighbors.get(kb).push(ka);
  }
  let open=0;
  const loops=[],visited=new Set();
  for(const start of points.keys()){
    if(visited.has(start))continue;
    const component=[start];visited.add(start);
    for(let i=0;i<component.length;i++)for(const next of neighbors.get(component[i])){
      if(visited.has(next))continue;
      visited.add(next);component.push(next);
    }
    if(component.length<3||component.some(id=>neighbors.get(id).length!==2)){open++;continue}
    const loop=[];
    let previous=null,at=start;
    do{
      loop.push(points.get(at));
      const next=neighbors.get(at).find(x=>x!==previous);
      previous=at;at=next;
    }while(at!==start&&loop.length<=component.length);
    if(at===start&&loop.length>=3)loops.push(loop);else open++;
  }
  return {loops,open};
}

function splitPrimitive(document,buffer,primitive,localToKnife,options){
  const data=readPart(primitive), patch=builders(data,document,buffer,{keepOriginal:true});
  const edges=planes.map(()=>new Map()), minimum=new Vector3(),maximum=new Vector3(), point=new Vector3();
  const knifePositions=new Float64Array(data.positions.length);
  for(let i=0;i<data.positions.length;i+=3)point.fromArray(data.positions,i).applyMatrix4(localToKnife).toArray(knifePositions,i);
  let changed=0;
  for(let i=0;i<data.indices.length;i+=3){
    const ids=Array.from(data.indices.subarray(i,i+3));
    const poly=ids.map((id,k)=>({xyz:new Vector3().fromArray(knifePositions,id*3),ids,bary:[+(k===0),+(k===1),+(k===2)]}));
    minimum.copy(poly[0].xyz).min(poly[1].xyz).min(poly[2].xyz);
    maximum.copy(poly[0].xyz).max(poly[1].xyz).max(poly[2].xyz);
    if([0,1,2].some(k=>minimum.getComponent(k)>=.5-epsilon||maximum.getComponent(k)<=-.5+epsilon)){
      patch.indices.push(...ids);continue;
    }
    let inner=poly;
    const keep=[];
    for(const plane of planes){
      if(inner.every(p=>planeDistance(p,plane)<=epsilon))continue;
      if(inner.every(p=>planeDistance(p,plane)>=-epsilon)){
        keep.push(inner);inner=[];break;
      }
      keep.push(clipPolygon(inner,plane,false));
      inner=clipPolygon(inner,plane,true);
    }
    if(clean(inner).length<3){patch.indices.push(...ids);continue}
    changed++;
    for(const polygon of keep)patch.fan(polygon);
    if(options.close)addCutEdges(inner,edges,1e-6);
  }
  if(!changed)return {changed:0};
  const replacement=patch.finish(primitive.getMaterial()), caps=[];
  let closed=0, open=0;
  if(options.close){
    const knifeToLocal=localToKnife.clone().invert(), nMat=new Matrix3().getNormalMatrix(knifeToLocal);
    const material=options.capMaterial();
    for(const [i,edge] of edges.entries()){
      const [axis,sign]=planes[i], [u,v]=[0,1,2].filter(k=>k!==axis), {loops,open:broken}=contours(edge);
      open+=broken;
      if(!loops.length)continue;
      const localNormal=new Vector3().setComponent(axis,-sign).applyMatrix3(nMat).normalize();
      const cap=builders(data,document,buffer,{capNormal:localNormal.toArray()});
      const shapes=loops.map(loop=>loop.map(p=>new Vector2(p.xyz.getComponent(u),p.xyz.getComponent(v))));
      const contains=(polygon,p)=>{
        let result=false;
        for(let a=0,b=polygon.length-1;a<polygon.length;b=a++){
          const x=polygon[a],y=polygon[b];
          if((x.y>p.y)!==(y.y>p.y)&&p.x<(y.x-x.x)*(p.y-x.y)/(y.y-x.y)+x.x)result=!result;
        }
        return result;
      };
      const depth=shapes.map((shape,j)=>shapes.reduce((n,other,k)=>n+(k!==j&&contains(other,shape[0])?1:0),0));
      for(const [j,shape] of shapes.entries()){
        if(depth[j]%2)continue;
        const holes=shapes.flatMap((child,k)=>depth[k]===depth[j]+1&&contains(shape,child[0])?[k]:[]);
        const verts=[...loops[j],...holes.flatMap(k=>loops[k])];
        const faces=ShapeUtils.triangulateShape(shape.slice(),holes.map(k=>shapes[k].slice()));
        for(const face of faces){
          const poly=face.map(k=>verts[k]), loc=poly.map(p=>p.xyz.clone().applyMatrix4(knifeToLocal));
          if(loc[1].sub(loc[0]).cross(loc[2].sub(loc[0])).dot(localNormal)<0)poly.reverse();
          cap.fan(poly);
        }
        if(faces.length)closed+=1+holes.length;else open++;
      }
      const part=cap.finish(material);
      if(part)caps.push(part);
    }
  }
  return {changed,replacement,caps,closed,open};
}

async function openDocument(bytes,budget){
  const {json}=inspectGlb(bytes);
  const width={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
  let decoded=0;
  for(const accessor of json.accessors||[]){
    if(!Number.isSafeInteger(accessor.count)||accessor.count<1||!width[accessor.type])
      throw Error('В GLB повреждены размеры данных.');
    decoded+=accessor.count*width[accessor.type]*4;
  }
  if(bytes.byteLength*3+decoded*3+24*1048576>budget*1048576)throw Error('Недостаточно памяти для правки GLB.');
  const io=await createCodecIO(bytes), doc=await io.readBinary(bytes);
  return {io,doc};
}

export async function cutDetail(input,{matrix,placement,node=null,close=true,color=[.27,.22,.18],memoryBudgetMiB=384}={}){
  const {doc,io}=await openDocument(input,memoryBudgetMiB);
  const root=doc.getRoot(), buffer=root.listBuffers()[0];
  const knife=toMat(matrix), transform=placement?toMat(placement):new Matrix4();
  if(matrix.some(v=>!Number.isFinite(v))||Math.abs(knife.determinant())<1e-24)throw Error('Задай толщину, высоту и глубину ножа.');
  const toKnife=knife.invert().multiply(transform), nodes=root.listNodes(), totals={changed:0,closed:0,open:0};
  let capMaterial=null,edited=0;
  const cap=()=>capMaterial??=(doc.createMaterial(CUT_MATERIAL).setBaseColorFactor([...color,1]).setRoughnessFactor(.85).setMetallicFactor(0));
  for(const [id,item] of nodes.entries()){
    if(node!==null&&id!==node)continue;
    const mesh=item.getMesh();if(!mesh)continue;
    const snapshot=mesh.listPrimitives();
    let replacement=null;
    for(const part of snapshot){
      const count=part.getAttribute('POSITION').getCount();edited+=count;
      if(edited>650000)throw Error('Для ножа доступно до 650 тысяч вершин за операцию.');
      const result=splitPrimitive(doc,buffer,part,toKnife.clone().multiply(toMat(item.getWorldMatrix())),{close,capMaterial:cap});
      if(!result.changed){if(replacement)replacement.addPrimitive(part);continue}
      if(!replacement){
        replacement=doc.createMesh(mesh.getName()).setWeights(mesh.getWeights()).setExtras(mesh.getExtras());
        for(const before of snapshot.slice(0,snapshot.indexOf(part)))replacement.addPrimitive(before);
      }
      if(result.replacement)replacement.addPrimitive(result.replacement);
      for(const c of result.caps)replacement.addPrimitive(c);
      totals.changed+=result.changed;totals.closed+=result.closed;totals.open+=result.open;
    }
    if(replacement){
      if(!replacement.listPrimitives().length)throw Error('Нож захватывает весь меш. Уменьши пластину или выбери фрагмент.');
      item.setMesh(replacement);
    }
  }
  if(!totals.changed)throw Error('Пластина не пересекла поверхность. Проверь её глубину и положение.');
  removeGeometryCompression(doc);
  await doc.transform(prune({propertyTypes:[PropertyType.MESH,PropertyType.PRIMITIVE,PropertyType.ACCESSOR,PropertyType.MATERIAL],keepAttributes:true,keepExtras:true}));
  return {bytes:await io.writeBinary(doc),...totals};
}

export async function paintCut(input,{color,memoryBudgetMiB=384}){
  const {doc,io}=await openDocument(input,memoryBudgetMiB);
  const material=doc.getRoot().listMaterials().filter(m=>m.getName()===CUT_MATERIAL).at(-1);
  if(!material)throw Error('Сначала создай закрытый срез.');
  material.setBaseColorFactor([...color,1]);
  removeGeometryCompression(doc);
  return {bytes:await io.writeBinary(doc)};
}

function pieceGeometry(mesh,primitiveIndex,face){
  const parts=mesh.listPrimitives().map(readPart), starts=[];
  let count=0;
  for(const part of parts){starts.push(count);count+=(part.indices.length/3)}
  if(count>1000000)throw Error('Выбор куска поддерживает до миллиона треугольников.');
  const selectedPart=parts[primitiveIndex];
  if(!selectedPart||!Number.isInteger(face)||face<0||face*3>=selectedPart.indices.length)
    throw Error('Коснись поверхности нужного куска.');
  let size=0;
  for(const {positions} of parts)for(const v of positions)size=Math.max(size,Math.abs(v));
  const tolerance=Math.max(1e-10,size*3e-7), parents=Int32Array.from({length:count},(_,i)=>i), edge=new Map();
  const find=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i]}return i};
  const connect=(a,b)=>{a=find(a);b=find(b);if(a!==b)parents[Math.max(a,b)]=Math.min(a,b)};
  for(const [partIndex,{positions,indices}] of parts.entries()){
    const keys=[], vector=new Vector3();
    for(let i=0;i<positions.length;i+=3)keys.push(signedKey(vector.fromArray(positions,i),tolerance));
    for(let i=0;i<indices.length;i+=3) {
      const id=starts[partIndex]+i/3;
      for(let k=0;k<3;k++){
        const a=keys[indices[i+k]], b=keys[indices[i+(k+1)%3]];
        if(a===b)continue;
        const key=a<b?a+'|'+b:b+'|'+a;
        if(edge.has(key))connect(id,edge.get(key));else edge.set(key,id);
      }
    }
  }
  const chosen=find(starts[primitiveIndex]+face), masks=parts.map((part,i)=>Uint8Array.from({length:part.indices.length/3},(_,j)=>+(find(starts[i]+j)===chosen)));
  return {parts,masks,count};
}

export async function detailPiece(input,{node,primitive,face,mode='preview',memoryBudgetMiB=384}){
  const {doc,io}=await openDocument(input,memoryBudgetMiB), root=doc.getRoot(), item=root.listNodes()[node], mesh=item?.getMesh();
  if(!mesh)throw Error('Кусок не найден.');
  const {parts,masks,count}=pieceGeometry(mesh,primitive,face);
  const faces=masks.reduce((total,mask)=>total+mask.reduce((a,b)=>a+b,0),0);
  if(mode==='preview'){
    const vertices=new Float32Array(faces*9), v=new Vector3(), world=toMat(item.getWorldMatrix());
    let at=0;
    for(const [pi,{indices,positions}] of parts.entries())for(let i=0;i<indices.length;i+=3){
      if(!masks[pi][i/3])continue;
      for(let k=0;k<3;k++,at+=3)v.fromArray(positions,indices[i+k]*3).applyMatrix4(world).toArray(vertices,at);
    }
    return {faces,count,vertices};
  }
  if(mode==='remove'&&faces===count)throw Error('У этого меша один связанный кусок. Раздели его ножом.');
  const result=doc.createMesh(mesh.getName()).setWeights(mesh.getWeights()).setExtras(mesh.getExtras()), buffer=root.listBuffers()[0];
  for(const [i,primitive] of mesh.listPrimitives().entries()){
    const {indices,positions}=parts[i], kept=[];
    for(let j=0;j<indices.length;j+=3)if(!!masks[i][j/3]===(mode==='keep'))kept.push(indices[j],indices[j+1],indices[j+2]);
    if(!kept.length)continue;
    const out=primitive.clone().setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer)
      .setArray(positions.length/3<=65535?Uint16Array.from(kept):Uint32Array.from(kept)));
    result.addPrimitive(out);
  }
  item.setMesh(result);
  removeGeometryCompression(doc);
  await doc.transform(prune({propertyTypes:[PropertyType.MESH,PropertyType.PRIMITIVE,PropertyType.ACCESSOR,PropertyType.MATERIAL],keepExtras:true}));
  return {bytes:await io.writeBinary(doc),faces};
}

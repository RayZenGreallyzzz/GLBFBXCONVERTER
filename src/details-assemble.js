import {Matrix3,Matrix4, Vector3, Quaternion} from 'three';
import {PropertyType} from '@gltf-transform/core';
import {copyToDocument,prune} from '@gltf-transform/functions';
import {attributeValues} from './static-simplify.js';
import {createCodecIO,removeGeometryCompression} from './codec-io.js';
import {inspectGlb} from './format.js';
import {tailRegion} from './detail-tail.js';
import {detailFrames,detailTurn} from './detail-motion.js';

const matrix=elements=>new Matrix4().fromArray(elements);
const unit=new Vector3(1,1,1);
const maxVertices=650000;
const MiB=1048576;

function appendAccessor(doc,buffer,type,data){
  return doc.createAccessor().setType(type).setBuffer(buffer).setArray(data);
}

function newChain(doc,buffer,skin,parent,points,bind,name,poseId){
  const joints=skin.listJoints(), first=joints.length;
  if(points.length<2||points.length>5||first+points.length-1>256)throw Error('Для детали выбери от одной до четырёх костей.');
  const ibm=Float32Array.from(skin.getInverseBindMatrices().getArray());
  const inverse=new Float32Array((first+points.length-1)*16);inverse.set(ibm);
  let basis=matrix(parent.getWorldMatrix());
  const arm=[], nodes=[];
  for(let k=0;k<points.length-1;k++){
    const head=new Vector3().fromArray(points[k]), next=new Vector3().fromArray(points[k+1]),
      axis=next.clone().sub(head), length=axis.length();
    if(!(length>1e-7)||!Number.isFinite(length))throw Error('Разнеси точки костей детали.');
    axis.normalize();
    const ref=Math.abs(axis.z)>.92?new Vector3(1,0,0):new Vector3(0,0,1);
    const x=axis.clone().cross(ref).normalize(), z=x.clone().cross(axis).normalize();
    const q=new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x,axis,z));
    // Keep each added bone local to its parent so old motion naturally
    // propagates to the horn, ear, tail or wing.
    const pose=new Matrix4().compose(head,q,unit), local=basis.clone().invert().multiply(pose);
    const p=new Vector3(), r=new Quaternion(), s=new Vector3();
    local.decompose(p,r,s);
    const newNode=doc.createNode(name+' · Кость '+(k+1)).setTranslation(p.toArray()).setRotation(r.normalize().toArray()).setScale(s.toArray());
    if(poseId)newNode.setExtras({phoenixPoseBone:[poseId,k]});
    parent.addChild(newNode);skin.addJoint(newNode);
    basis=matrix(newNode.getWorldMatrix());
    basis.clone().invert().multiply(bind).toArray(inverse,(first+k)*16);
    arm.push({head,axis,length,index:first+k});nodes.push(newNode);parent=newNode;
  }
  skin.setInverseBindMatrices(appendAccessor(doc,buffer,'MAT4',inverse));
  return {arm,nodes};
}

function assign(detail,point,region){
  const {arm,index}=detail;
  if(!arm?.length)return [[index,1]];
  let best=0, at=0, distance=Infinity;
  for(const [i,b] of arm.entries()){
    const offset=point.clone().sub(b.head), t=offset.dot(b.axis);
    const d=offset.addScaledVector(b.axis,-Math.max(0,Math.min(b.length,t))).lengthSq();
    if(d<distance){distance=d;best=i;at=t/b.length}
  }
  if(region){region.distance=Math.sqrt(distance);region.projected=at;region.segment=best}
  const a=arm[best].index;
  if(best>0&&at<.22){
    const k=.5*(1-Math.min(.22,Math.max(0,at))/.22);
    return [[a,1-k],[arm[best-1].index,k]];
  }
  if(best+1<arm.length&&at>.78){
    const k=.5*(Math.min(1,at)-.78)/.22;
    return [[a,1-k],[arm[best+1].index,k]];
  }
  return [[a,1]];
}

function bindTail(doc,buffer,sourceNodes,skin,detail,radius){
  if(!(radius>0&&Number.isFinite(radius)))throw Error('Укажи радиус весов хвоста.');
  const candidates=sourceNodes.filter(node=>node.getSkin()===skin&&node.getMesh());
  const count=node=>node.getMesh().listPrimitives().reduce((sum,p)=>sum+(p.getAttribute('POSITION')?.getCount()||0),0);
  const body=candidates.reduce((best,node)=>!best||count(node)>count(best)?node:best,null);
  if(!body||count(body)>maxVertices)throw Error('Для хвоста нужен меш персонажа со скелетом до 650 тысяч вершин.');
  const mesh=body.getMesh().clone(), point=new Vector3(), world=matrix(body.getWorldMatrix());
  const parts=body.getMesh().listPrimitives().map(primitive=>{
    const positions=primitive.getAttribute('POSITION'), joints=primitive.getAttribute('JOINTS_0'), weights=primitive.getAttribute('WEIGHTS_0');
    if(!positions||!joints||!weights||primitive.getMode()!==4||primitive.getAttribute('WEIGHTS_1'))
      throw Error('Для хвоста нужен треугольный меш с четырьмя весами на вершину.');
    const vertices=Float32Array.from(attributeValues(positions));
    for(let i=0;i<vertices.length;i+=3)point.fromArray(vertices,i).applyMatrix4(world).toArray(vertices,i);
    return {primitive,vertices,joints,weights,indices:primitive.getIndices()?.getArray()};
  });
  const amounts=tailRegion(parts,detail.arm,radius,(point,region)=>assign(detail,point,region));
  let changed=0;
  for(const [partIndex,{primitive,vertices,joints,weights}] of parts.entries()){
    const out=primitive.clone(), ids=Uint16Array.from(joints.getArray()), values=Float32Array.from(attributeValues(weights));
    for(const [i,amount] of amounts[partIndex].entries()){
      if(amount<.0001)continue;
      const influences=assign(detail,point.fromArray(vertices,i*3)), at=i*4, combined=new Map();
      for(let k=0;k<4;k++)if(values[at+k]>0)combined.set(ids[at+k],(combined.get(ids[at+k])||0)+values[at+k]*(1-amount));
      for(const [bone,w] of influences)combined.set(bone,(combined.get(bone)||0)+w*amount);
      const sorted=[...combined].filter(([,w])=>w>0).sort((a,b)=>b[1]-a[1]).slice(0,4);
      if(!sorted.some(([bone])=>bone>=detail.arm[0].index))continue;
      const sum=sorted.reduce((s,[,w])=>s+w,0);
      for(let k=0;k<4;k++){
        ids[at+k]=sorted[k]?.[0]||0;
        values[at+k]=(sorted[k]?.[1]||0)/sum;
      }
      changed++;
    }
    out.setAttribute('JOINTS_0',appendAccessor(doc,buffer,'VEC4',ids));
    out.setAttribute('WEIGHTS_0',appendAccessor(doc,buffer,'VEC4',values));
    mesh.removePrimitive(primitive).addPrimitive(out);
  }
  if(!changed)throw Error('В радиусе цепочки нет вершин хвоста. Уточни точки или увеличь радиус.');
  body.setMesh(mesh);
  return changed;
}

function transformPrimitive(doc,buffer,part,already,placement,inverseBind,detail){
  const source=part.getAttribute('POSITION');
  if(part.getMode()!==4||!source)throw Error('Для детали нужна треугольная сетка.');
  const out=part.clone();
  // clone() shares morph targets. Give this instance its own targets before
  // rewriting the deltas, since the same mesh may be placed more than once.
  for(const target of part.listTargets()){out.removeTarget(target);out.addTarget(target.clone())}
  const world=placement.clone().multiply(already), xform=inverseBind.clone().multiply(world),
    normals=new Matrix3().getNormalMatrix(xform), direction=new Matrix3().setFromMatrix4(xform), point=new Vector3();
  const det=xform.determinant();
  if(!Number.isFinite(det)||Math.abs(det)<1e-22)throw Error('У детали нулевой размер.');
  for(const [property,sourceProperty,isDelta] of [[out,part,false],...out.listTargets().map((t,i)=>[t,part.listTargets()[i],true])]){
    for(const semantic of ['POSITION','NORMAL','TANGENT']){
      const accessor=sourceProperty.getAttribute(semantic);if(!accessor)continue;
      const array=Float32Array.from(attributeValues(accessor)), n=accessor.getElementSize();
      for(let i=0;i<array.length;i+=n){
        point.fromArray(array,i);
        if(semantic==='POSITION'){
          if(isDelta)point.applyMatrix3(direction);
          else point.applyMatrix4(xform);
        }else {
          point.applyMatrix3(semantic==='NORMAL'?normals:direction);
          if(!isDelta)point.normalize();
        }
        point.toArray(array,i);
        if(n===4&&det<0)array[i+3]*=-1;
      }
      property.setAttribute(semantic,appendAccessor(doc,buffer,accessor.getType(),array));
    }
  }
  if(det<0){
    const ix=part.getIndices()?Uint32Array.from(part.getIndices().getArray()):Uint32Array.from({length:source.getCount()},(_,i)=>i);
    for(let i=0;i<ix.length;i+=3)[ix[i+1],ix[i+2]]=[ix[i+2],ix[i+1]];
    out.setIndices(appendAccessor(doc,buffer,'SCALAR',ix));
  }
  if(detail){
    const values=attributeValues(source), indices=new Uint16Array(source.getCount()*4), weights=new Float32Array(indices.length);
    for(let i=0;i<source.getCount();i++){
      const assigned=assign(detail,point.fromArray(values,i*3).applyMatrix4(world));
      assigned.forEach(([j,w],k)=>{indices[i*4+k]=j;weights[i*4+k]=w});
    }
    out.setAttribute('JOINTS_0',appendAccessor(doc,buffer,'VEC4',indices));
    out.setAttribute('WEIGHTS_0',appendAccessor(doc,buffer,'VEC4',weights));
  }
  return out;
}

function appendDetailClip(doc,buffer,baseClips,part,nodes,layers){
  const cfg=part.animation;
  if(!cfg?.tracks.some(t=>t.keys.length))return;
  const base=baseClips[cfg.body];
  let animation=base?layers.get(base):null;
  if(!animation){
    const title=base?(base.getName()||'Движение тела')+' · Детали':cfg.name||part.name+' · Движение';
    let name=title,index=2;
    while(doc.getRoot().listAnimations().some(clip=>clip.getName()===name))name=title+' '+index++;
    animation=doc.createAnimation(name);
    if(base){
      for(const s of base.listSamplers())animation.addSampler(s);
      for(const c of base.listChannels())animation.addChannel(c.clone());
      layers.set(base,animation);
    }
  }
  for(const track of cfg.tracks){
    if(!track.keys.length)continue;
    const target=nodes[track.bone];
    if(!target)throw Error('Проверь кости и ключи детали.');
    const frames=detailFrames(track.keys,cfg.duration), values=new Float32Array(frames.length*4),
      rest=new Quaternion().fromArray(target.getRotation()), offset=new Quaternion();
    frames.forEach(([,angles],i)=>{
      rest.clone().multiply(detailTurn(angles,offset)).normalize().toArray(values,i*4);
    });
    const sampler=doc.createAnimationSampler().setInput(appendAccessor(doc,buffer,'SCALAR',Float32Array.from(frames,([time])=>time)))
      .setOutput(appendAccessor(doc,buffer,'VEC4',values)).setInterpolation('LINEAR');
    animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath('rotation').setSampler(sampler));
  }
}

export async function assembleDetails(base,parts,{memoryBudgetMiB=384,onProgress=()=>{}}={}){
  const size=base.byteLength+parts.reduce((s,p)=>s+(p.bytes?.byteLength||0),0);
  if(size*3+40*MiB>memoryBudgetMiB*MiB)throw Error('Недостаточно памяти для всех деталей. Уменьши размеры моделей.');
  const io=await createCodecIO(base),doc=await io.readBinary(base), root=doc.getRoot(),
    scene=root.getDefaultScene()||root.listScenes()[0], buffer=root.listBuffers()[0]||doc.createBuffer(),
    sourceNodes=root.listNodes(), baseClips=root.listAnimations();
  if(!scene)throw Error('У персонажа нет сцены.');
  removeGeometryCompression(doc);
  let vertices=0,tailVertices=0;
  const layers=new Map();
  for(const [partIndex,part] of parts.entries()){
    const parent=sourceNodes[part.parent],
      skin=parent?root.listSkins().find(s=>s.listJoints().includes(parent)):null;
    const bind=new Matrix4();
    let detail=null, motionNodes=[];
    if(skin){
      const matrices=skin.getInverseBindMatrices()?.getArray(), first=skin.listJoints()[0];
      if(!matrices)throw Error('Для крепления детали нужны матрицы привязки скелета.');
      bind.copy(matrix(first.getWorldMatrix())).multiply(new Matrix4().fromArray(matrices));
      detail={index:skin.listJoints().indexOf(parent)};
      if(part.points?.length){
        const result=newChain(doc,buffer,skin,parent,part.points,bind,part.name+' '+(partIndex+1),part.poseId);
        detail.arm=result.arm;motionNodes=result.nodes;
      }
    }else if(part.parent>=0)throw Error('Выбери кость крепления в скелете персонажа.');
    if(part.tail){
      if(!skin||!detail?.arm?.length)throw Error('Для хвоста выбери кость таза и расставь точки цепочки.');
      tailVertices+=bindTail(doc,buffer,sourceNodes,skin,detail,part.radius);
      appendDetailClip(doc,buffer,baseClips,part,motionNodes,layers);
      onProgress(Math.round((partIndex+1)/parts.length*80));
      continue;
    }
    const sourceIo=await createCodecIO(part.bytes), source=await sourceIo.readBinary(part.bytes), partRoot=source.getRoot();
    if(partRoot.listSkins().length||partRoot.listAnimations().length)throw Error('Загрузи деталь как GLB без собственного скелета и клипов.');
    removeGeometryCompression(source);
    const sourceScene=partRoot.getDefaultScene()||partRoot.listScenes()[0], original=[];
    sourceScene?.traverse(n=>{if(n.getMesh())original.push(n)});
    if(!original.length)throw Error('В детали нет сетки.');
    const ext=copyToDocument(doc,source,[...new Set(original.map(n=>n.getMesh()))]);
    const placement=matrix(part.matrix);
    const inverse=bind.clone().invert();
    for(const node of original){
      const originalMesh=ext.get(node.getMesh()), mesh=doc.createMesh(part.name).setExtras(originalMesh.getExtras()).setWeights(originalMesh.getWeights());
      const current=matrix(node.getWorldMatrix());
      for(const primitive of originalMesh.listPrimitives()){
        vertices+=primitive.getAttribute('POSITION').getCount();
        if(vertices>maxVertices)throw Error('Общий предел для загруженных деталей — 650 тысяч вершин.');
        mesh.addPrimitive(transformPrimitive(doc,buffer,primitive,current,placement,inverse,detail));
      }
      const meshNode=doc.createNode(part.name).setMesh(mesh).setWeights(node.getWeights());
      if(skin)meshNode.setSkin(skin).setMatrix(bind.toArray());
      scene.addChild(meshNode);
    }
    appendDetailClip(doc,buffer,baseClips,part,motionNodes,layers);
    onProgress(Math.round((partIndex+1)/parts.length*80));
  }
  for(const a of root.listAccessors())a.setBuffer(buffer);
  for(const b of root.listBuffers())if(b!==buffer)b.dispose();
  await doc.transform(prune({propertyTypes:[PropertyType.MESH,PropertyType.PRIMITIVE,PropertyType.ACCESSOR,PropertyType.MATERIAL],keepAttributes:true,keepExtras:true}));
  const bytes=await io.writeBinary(doc), check=inspectGlb(bytes).json;
  if((check.animations||[]).length<baseClips.length)throw Error('Проверка не нашла все исходные анимации.');
  return {bytes,clips:check.animations?.length||0,parts:parts.length,tailVertices};
}

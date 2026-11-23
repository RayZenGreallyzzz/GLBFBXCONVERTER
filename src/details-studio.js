import * as THREE from 'three';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import {asArrayBuffer} from './binary.js';
import {inspectGlb} from './format.js';
import {detailBoneLabel} from './detail-labels.js';
import {startDetailsJob} from './details-jobs.js';

const $=id=>document.getElementById('detail-'+id);
const axis=['x','y','z'], p=v=>new THREE.Vector3().fromArray(v);
const stripName=name=>name.replace(/\.glb$/i,'').slice(0,60);
const ceil=(v,min,max)=>Math.max(min,Math.min(max,v));
const materialAt=hit=>Array.isArray(hit.object.material)?hit.object.material[hit.face?.materialIndex||0]:hit.object.material;

export class DetailsStudio {
  constructor(api){
    this.api=api;
    this.items=[];this.history=[];this.active=false;this.target='';this.tap='';this.nextId=0;
    this.group=new THREE.Group();
    this.group.visible=false;api.scene.add(this.group);
    this.helper=new THREE.Group();api.scene.add(this.helper);
    this.plate=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({
      color:0x65dbff,transparent:true,opacity:.19,depthWrite:false,side:THREE.DoubleSide
    }));
    this.plate.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.plate.geometry),new THREE.LineBasicMaterial({color:0x8beaff})));
    this.helper.add(this.plate);
    this.highlight=new THREE.Group();this.helper.add(this.highlight);
    this.markers=new THREE.Group();this.helper.add(this.markers);
    this.inverseKnife=new THREE.Matrix4();this.ray=new THREE.Raycaster();
    this.gizmo=new TransformControls(api.camera,api.canvas);
    this.gizmo.setSize(1.28);this.gizmo.enabled=false;
    this.gizmo.addEventListener('dragging-changed',e=>{if(this.active)this.api.orbit.enabled=!e.value});
    this.gizmo.addEventListener('mouseDown',()=>{this.dragged=true});
    this.gizmo.addEventListener('objectChange',()=>this.moved());
    api.scene.add(this.gizmo.getHelper());
    this.helper.visible=false;
    const on=(id,event,fn)=>$(id).addEventListener(event,e=>this.guard(()=>fn(e)));
    on('file','change',e=>{const files=[...e.target.files];e.target.value='';return this.import(files)});
    on('selected','change',()=>this.select());
    on('name','change',()=>{this.item().name=$('name').value.trim()||this.item().name;this.list()});
    on('position','click',()=>this.attach('part'));
    for(const k of axis)on('place-'+k,'change',()=>{
      const item=this.item(), value=$('place-'+k).valueAsNumber;
      if(!item||!Number.isFinite(value))return;
      item.group.position[k]=value;item.group.updateMatrixWorld(true);this.dropPiece();this.drawMarkers();
    });
    on('remove','click',()=>this.removeItem());
    on('reset-place','click',()=>this.resetPlacement());
    on('focus','click',()=>this.focus());
    on('camera','click',()=>this.attach(''));
    on('front','click',()=>this.focus('front'));
    on('side','click',()=>this.focus('side'));
    for(const [id,mode] of [['move','translate'],['turn','rotate'],['scale','scale']])on(id,'click',()=>this.mode(mode));
    on('knife','click',()=>this.beginTap('knife'));
    for(const [i,k] of axis.entries())on('size-'+k,'input',()=>{
      if(!this.placed)return;
      this.plate.scale[k]=ceil($('size-'+k).valueAsNumber||.01,.01,200)*this.reference()/100;
      this.knifeMatrix();
    });
    on('cut','click',()=>this.cut());
    on('piece','click',()=>this.beginTap('piece'));
    on('keep','click',()=>this.usePiece('keep'));
    on('delete','click',()=>this.usePiece('remove'));
    on('sample','click',()=>this.beginTap('color'));
    on('paint','click',()=>this.paint());
    on('undo','click',()=>this.undo());
    on('parent','change',()=>{this.item().parent=Number($('parent').value);this.fields()});
    on('chain','change',()=>{
      const item=this.item(), next=Number($('chain').value);
      item.points=Array.from({length:next?next+1:0},(_,i)=>item.points[i]||null);
      item.keys=item.keys.filter(k=>k.bone<next);
      this.fields();
    });
    on('point','change',()=>this.fields(false));
    on('mark','click',()=>this.beginTap('point'));
    for(const k of axis)on('point-'+k,'change',()=>this.storePoint());
    on('motion-body','change',()=>{
      const item=this.item();
      item.body=Number($('motion-body').value);
      const duration=this.duration();
      item.keys=item.keys.filter(k=>k.time<=duration);
      this.fields(false);
    });
    on('duration','change',()=>{
      const item=this.item();
      item.duration=ceil($('duration').valueAsNumber||2,.1,120);
      item.keys=item.keys.filter(k=>k.time<=item.duration);
      this.fields(false);
    });
    on('bone','change',()=>this.keyFields());
    on('time','input',()=>this.keyFields());
    on('key-pick','change',()=>{
      if($('key-pick').value!=='')$('time').value=$('key-pick').value;
      this.keyFields();
    });
    on('key','click',()=>this.addKey());
    on('key-delete','click',()=>this.deleteKey());
    on('review','click',()=>this.preview());
    on('clip','change',()=>this.playClip());
    on('return','click',()=>this.stopPreview());
    on('cancel','click',()=>this.job?.cancel());
    on('save','click',()=>this.save());
    api.canvas.addEventListener('pointerdown',e=>{
      this.dragged=!!this.gizmo.axis;
      this.down={id:e.pointerId,x:e.clientX,y:e.clientY};
    },true);
    api.canvas.addEventListener('pointerup',e=>this.guard(()=>this.picked(e)));
  }

  async guard(action){
    try{await action()}catch(error){this.message(error.message||String(error))}
  }
  message(text){$('status').textContent=text}
  item(){return this.items.find(r=>r.id===$('selected').value)}
  subject(){return this.item()||this.body}
  reference(){
    const item=this.subject();
    if(!item)return 1;
    item.root.updateWorldMatrix(true,true);
    const box=new THREE.Box3().setFromObject(item.root),size=box.getSize(new THREE.Vector3());
    return Math.max(.00001,size.x,size.y,size.z);
  }
  duration(){
    const item=this.item(), body=this.api.model().clips[item?.body];
    return body?Math.max(.1,body.duration):item?.duration||2;
  }
  setTab(active){
    if(this.active===active)return;
    this.active=active;
    if(!active){
      this.stopPreview();this.attach('');this.tap='';this.group.visible=false;this.helper.visible=false;
      if(this.body?.owned)this.body.root.visible=false;
      this.api.restoreView(this.lastView);
      return;
    }
    this.lastView=this.api.model().viewMode;
    this.api.prepare();
    this.refresh();
    this.visibility();
  }
  stopPreview(){
    this.mixer?.stopAllAction();this.mixer=null;
    if(this.result){
      this.result.scene.removeFromParent();this.api.release(this.result.scene);this.result=null;
      this.api.showOriginal();
    }
    this.visibility();this.refresh(false);
  }
  clearSession(source){
    this.stopPreview();
    this.attach('');this.dropPiece();this.hideKnife();
    if(this.body?.owned){this.body.root.removeFromParent();this.api.release(this.body.root)}
    for(const item of this.items){item.group.removeFromParent();this.api.release(item.root)}
    this.items=[];this.history=[];this.body=null;this.source=source;
    const state=this.api.model();
    if(state.type==='glb'&&source&&state.root){
      this.body={id:'body',name:'Персонаж',bytes:new Uint8Array(source),root:state.root,associations:state.rigLookup,owned:false};
      this.readAnchors();
      this.message('Выбери персонажа или добавь детали в сцену.');
    }else this.message('Сначала загрузи персонажа в формате GLB.');
    this.list();
    this.visibility();
  }
  readAnchors(){
    const j=inspectGlb(this.body.bytes).json;
    const bones=new Set((j.skins||[]).flatMap(s=>s.joints));
    this.anchors=[...bones].filter(i=>j.nodes[i]).map(i=>[i,detailBoneLabel(j.nodes[i].name,i)]);
    $('parent').replaceChildren(new Option('Без крепления',-1),...this.anchors.map(([i,label])=>new Option(label,i)));
    $('motion-body').replaceChildren(new Option('Отдельный клип',-1),
      ...this.api.model().clips.map((clip,i)=>new Option(clip.name||'Движение '+(i+1),i)));
  }
  refresh(checkSource=true){
    const state=this.api.model(), busy=state.busy;
    if(checkSource&&!busy&&this.source!==state.sourceBuffer)this.clearSession(state.sourceBuffer);
    if(!this.active)return;
    const item=this.item(), available=!!this.body, editing=available&&!busy&&!this.result;
    $('import').hidden=!available;
    $('file').disabled=!editing;
    $('controls').disabled=!editing;
    $('part').hidden=!item;
    $('animation').hidden=!item||item.parent<0||item.points.length<2;
    $('chain-controls').hidden=!item||item.parent<0||!item.points.length;
    $('knife-controls').hidden=!this.placed;
    $('cut').disabled=!editing||!this.placed;
    $('point-fields').hidden=!item?.points[Number($('point').value)];
    $('keep').disabled=!this.piece||this.piece.faces===this.piece.count;
    $('delete').disabled=$('keep').disabled;
    $('undo').disabled=!this.history.length;
    $('review').disabled=!editing||!(this.items.length||this.body?.owned);
    $('save').disabled=!available||busy||!(this.items.length||this.body?.owned);
    $('cancel').hidden=!this.job;
    $('player').hidden=!this.result;
    this.helper.visible=!!this.active&&editing;
    this.plate.visible=this.placed;
    this.gizmo.enabled=!!editing&&!!this.target;
  }
  list(){
    const selected=$('selected').value;
    const available=this.body?[this.body,...this.items]:[];
    $('selected').replaceChildren(...available.map(item=>new Option(item.name,item.id)));
    $('selected').value=available.some(i=>i.id===selected)?selected:(available[0]?.id||'');
    this.fields();
  }
  fields(full=true){
    const item=this.item();
    if(item){
      if(full){
        $('name').value=item.name;$('parent').value=String(item.parent);
        $('chain').value=String(Math.max(0,item.points.length-1));
      }
      const point=$('point').value, bone=$('bone').value;
      $('point').replaceChildren(...item.points.map((v,i)=>new Option((i===0?'Основание':i===item.points.length-1?'Кончик':'Сустав '+i)+(v?' · готово':''),i)));
      $('point').value=point&&item.points[Number(point)]!==undefined?point:'0';
      $('bone').replaceChildren(...item.points.slice(1).map((_,i)=>new Option('Кость '+(i+1),i)));
      $('bone').value=bone&&item.points[Number(bone)+1]!==undefined?bone:'0';
      $('motion-body').value=String(item.body);
      $('duration').value=String(this.duration());$('duration').disabled=item.body>=0;
      $('time').max=String(this.duration());
      $('points-count').textContent=item.points.filter(Boolean).length+' из '+item.points.length;
      this.placementFields();
      const at=item.points[Number($('point').value)];
      if(at){
        const world=p(at).applyMatrix4(item.group.matrixWorld);
        for(const k of axis)$('point-'+k).value=Number(world[k].toPrecision(7));
      }
      this.keyFields();this.drawMarkers();
    }else this.clearMarkers();
    this.refresh(false);
  }
  select(){
    this.tap='';this.attach('');this.dropPiece();this.hideKnife();
    this.fields();
  }
  visibility(){
    const state=this.api.model();
    this.group.visible=this.active&&!this.result;
    this.helper.visible=this.group.visible&&!state.busy;
    if(state.root){
      if(this.active&&(this.result||this.body?.owned))state.root.visible=false;
      else if(this.active)state.root.visible=true;
    }
    if(this.body?.owned)this.body.root.visible=this.active&&!this.result;
    for(const item of this.items)item.group.visible=true;
  }
  attach(target){
    if(target==='part'){this.dropPiece();this.hideKnife()}
    this.target=target;
    if(target==='knife'||target==='part')this.gizmo.attach(target==='knife'?this.plate:this.item().group);
    else this.gizmo.detach();
    if(target!=='')this.tap='';
    if(this.active)this.api.orbit.enabled=true;
    this.updateModes();this.refresh(false);
  }
  updateModes(){
    $('camera').setAttribute('aria-pressed',String(!this.target));
    for(const [id,mode] of [['move','translate'],['turn','rotate'],['scale','scale']]){
      $(id).setAttribute('aria-pressed',String(!!this.target&&this.gizmo.getMode()===mode));
      $(id).disabled=!this.target&&!this.placed&&!this.item();
    }
  }
  mode(mode){
    if(!this.target){
      if(this.placed)this.attach('knife');
      else if(this.item())this.attach('part');
      else return;
    }
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode==='scale'?'local':'world');
    this.updateModes();
  }
  moved(){
    if(this.target==='knife'){
      const size=this.reference();
      for(const k of axis){
        this.plate.scale[k]=ceil(this.plate.scale[k],size*.0001,size*2);
        $('size-'+k).value=Number((this.plate.scale[k]/size*100).toFixed(3));
      }
      this.knifeMatrix();
    }else if(this.target==='part'){
      const item=this.item();
      for(const k of axis)item.group.scale[k]=ceil(item.group.scale[k],.001,100);
      this.placementFields();this.drawMarkers();
    }
  }
  focus(view){
    const current=this.subject();if(!current)return;
    const box=new THREE.Box3().setFromObject(current.root), size=box.getSize(new THREE.Vector3()).length(), center=box.getCenter(new THREE.Vector3());
    if(box.isEmpty())return;
    const {camera,orbit}=this.api;
    const vector=view==='front'?new THREE.Vector3(0,0,1):view==='side'?new THREE.Vector3(1,0,0):camera.position.clone().sub(orbit.target).normalize();
    orbit.target.copy(center);
    camera.position.copy(center).addScaledVector(vector,Math.max(.01,size)*1.3/Math.min(1,camera.aspect||1));
    camera.near=Math.max(.0001,size/50000);
    camera.far=Math.max(200,size*300);
    camera.updateProjectionMatrix();orbit.update();camera.updateMatrixWorld(true);
  }
  async busyWork(action){
    if(this.api.model().busy)return;
    this.api.setBusy(true);
    try{return await action()}
    finally{this.job=null;this.api.progress(0);this.api.setBusy(false);this.visibility();this.refresh(false)}
  }
  async import(files){
    if(!this.body||!files.length)return;
    if(this.items.length+files.length>12)throw Error('За один раз можно собрать персонажа и до 12 деталей.');
    await this.busyWork(async()=>{
      const budget=await this.api.budget(), current=this.body.bytes.byteLength+this.items.reduce((s,i)=>s+i.bytes.byteLength,0);
      const total=current+files.reduce((n,f)=>n+f.size,0);
      if(total*3+40*1048576>budget*1048576)throw Error('Детали не помещаются в память. Уменьши размер моделей.');
      this.message('Загружаем детали…');
      const staged=[];
      try{
        const bodyBox=new THREE.Box3().setFromObject(this.body.root), cx=bodyBox.getCenter(new THREE.Vector3());
        let right=bodyBox.max.x;
        for(const item of this.items)right=Math.max(right,new THREE.Box3().setFromObject(item.root).max.x);
        for(const file of files){
          if(!/\.glb$/i.test(file.name))throw Error('Выбирай детали в формате GLB.');
          const bytes=new Uint8Array(await file.arrayBuffer()), j=inspectGlb(bytes).json;
          if(j.skins?.length||j.animations?.length)throw Error('Для детали нужен GLB с геометрией в исходной позе.');
          const loaded=await this.api.load(bytes), root=loaded.scene;
          root.updateMatrixWorld(true);
          const box=new THREE.Box3().setFromObject(root);
          if(box.isEmpty()){this.api.release(root);throw Error('В детали нет сетки.')}
          const origin=box.getCenter(new THREE.Vector3()), group=new THREE.Group(), offset=new THREE.Group();
          const width=box.getSize(new THREE.Vector3()).x;
          group.position.set(right+width*.7,cx.y,cx.z);right+=width*1.2;
          offset.position.copy(origin).negate();group.add(offset);offset.add(root);
          const reset=group.position.clone(), id=String(++this.nextId);
          staged.push({id,name:stripName(file.name),bytes,root,associations:loaded.parser.associations,group,offset,reset,parent:-1,body:-1,duration:2,points:[],keys:[]});
        }
      }catch(error){
        for(const item of staged)this.api.release(item.root);
        throw error;
      }
      for(const item of staged){this.group.add(item.group);this.items.push(item)}
      this.list();
      $('selected').value=staged.at(-1).id;this.select();
      this.message('Детали загружены. Выбери деталь и настрой её положение.');
    });
  }
  resetPlacement(){
    const item=this.item();if(!item)return;
    item.group.position.copy(item.reset);item.group.quaternion.identity();item.group.scale.set(1,1,1);
    item.group.updateMatrixWorld(true);this.fields();this.knifeMatrix();
  }
  placementFields(){
    const item=this.item();
    if(item)for(const k of axis)$('place-'+k).value=Number(item.group.position[k].toPrecision(7));
  }
  removeItem(){
    const item=this.item();if(!item)return;
    this.select();
    item.group.removeFromParent();this.api.release(item.root);
    this.items=this.items.filter(i=>i!==item);this.history=this.history.filter(h=>h.id!==item.id);
    this.list();
  }
  beginTap(kind){
    this.attach('');
    this.tap=kind;
    this.message({knife:'Коснись поверхности рядом со швом, чтобы поставить пластину.',
      piece:'Коснись куска, который надо оставить или удалить.',
      color:'Коснись участка с нужным цветом.',
      point:'Коснись детали, чтобы поставить выбранную точку цепочки.'}[kind]);
  }
  hit(e){
    const rect=this.api.canvas.getBoundingClientRect(), item=this.subject();
    this.ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2),this.api.camera);
    return this.ray.intersectObject(item.root,true).find(h=>h.object.isMesh);
  }
  async picked(e){
    const down=this.down;this.down=null;
    if(!this.active||this.api.model().busy||this.result||!this.tap||this.dragged||
      !down||e.pointerId!==down.id||Math.hypot(e.clientX-down.x,e.clientY-down.y)>10)return;
    const hit=this.hit(e);if(!hit)return;
    if(this.tap==='knife'){this.placeKnife(hit.point);return}
    if(this.tap==='color'){this.sampleColor(hit);this.tap='';return}
    if(this.tap==='point'){this.setPoint(hit.point);return}
    if(this.tap==='piece'){this.tap='';await this.selectPiece(hit)}
  }
  placeKnife(at){
    this.plate.position.copy(at);
    const size=this.reference();this.plate.scale.set(size*.007,size*.24,size*.35);
    this.plate.quaternion.identity();
    this.placed=true;
    this.attach('knife');this.mode('translate');this.moved();this.buildHighlight();
    this.message('Поставь пластину гизмо. Подсветка показывает участок, который будет срезан.');
  }
  knifeMatrix(){
    if(!this.placed)return;
    this.plate.updateMatrixWorld(true);
    this.inverseKnife.copy(this.plate.matrixWorld).invert();
  }
  buildHighlight(){
    this.clearHighlight();
    const material=new THREE.MeshBasicMaterial({color:0xff803a,opacity:.75,transparent:true,
      depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,side:THREE.DoubleSide});
    material.onBeforeCompile=shader=>{
      shader.uniforms.forgeKnife={value:this.inverseKnife};
      shader.vertexShader='varying vec3 forgeWorld;\n'+shader.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\nforgeWorld=(modelMatrix*vec4(transformed,1.0)).xyz;');
      shader.fragmentShader='uniform mat4 forgeKnife; varying vec3 forgeWorld;\n'+shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif(any(greaterThan(abs((forgeKnife*vec4(forgeWorld,1.0)).xyz),vec3(0.50001)))) discard;');
    };
    material.customProgramCacheKey=()=> 'forge-detail-knife';
    this.highlightMaterial=material;
    this.subject().root.traverse(obj=>{
      if(!obj.isMesh)return;
      const copy=new THREE.Mesh(obj.geometry,material);
      copy.matrixAutoUpdate=false;copy.matrix.copy(obj.matrixWorld);
      if(obj.morphTargetInfluences)copy.morphTargetInfluences=obj.morphTargetInfluences.slice();
      copy.renderOrder=25;this.highlight.add(copy);
    });
  }
  clearHighlight(){this.highlight.clear();this.highlightMaterial?.dispose();this.highlightMaterial=null}
  hideKnife(){
    this.placed=false;this.plate.visible=false;this.clearHighlight();
    if(this.target==='knife')this.attach('');
  }
  placement(item){
    if(!item.group)return new THREE.Matrix4();
    item.group.updateMatrixWorld(true);
    return item.offset.matrixWorld.clone();
  }
  async worker(operation,bytes,options={},parts=[]){
    const memoryBudgetMiB=await this.api.budget();
    this.job=startDetailsJob(operation,bytes,{...options,memoryBudgetMiB},parts,this.api.progress);
    this.refresh(false);
    try{return await this.job.promise}finally{this.job=null;this.refresh(false)}
  }
  async cut(){
    const item=this.subject();if(!item||!this.placed)return;
    this.knifeMatrix();
    const matrix=this.plate.matrixWorld.toArray(), placement=this.placement(item).toArray();
    await this.busyWork(async()=>{
      this.message('Подрезаем выбранную модель…');
      const result=await this.worker('cut',item.bytes,{matrix,placement,close:$('close').checked,color:this.color()});
      await this.replace(item,result.bytes,true);
      this.hideKnife();
      const cap=result.closed?' Закрыто контуров: '+result.closed+'.':'';
      const open=result.open?' Открытых контуров: '+result.open+'.':'';
      this.message('Срез сделан.'+cap+open+' Можно выбрать отдельный кусок.');
    });
  }
  color(){return new THREE.Color($('color').value).toArray()}
  sampleColor(hit){
    const material=materialAt(hit), color=material?.color?.clone()||new THREE.Color(.5,.5,.5);
    const map=material?.map, image=map?.image;
    if(image&&hit.uv){
      try{
        map.updateMatrix();
        const uv=map.transformUv(hit.uv.clone()), canvas=document.createElement('canvas');
        canvas.width=1;canvas.height=1;
        const ctx=canvas.getContext('2d',{willReadFrequently:true});
        const x=Math.min(image.width-1,Math.max(0,Math.floor(uv.x*image.width)));
        const y=Math.min(image.height-1,Math.max(0,Math.floor(uv.y*image.height)));
        ctx.drawImage(image,x,y,1,1,0,0,1,1);
        const [r,g,b]=ctx.getImageData(0,0,1,1).data;
        color.multiply(new THREE.Color().setRGB(r/255,g/255,b/255,THREE.SRGBColorSpace));
      }catch{
        this.message('Взят цвет материала. Эту текстуру нельзя прочитать пипеткой.');
        $('color').value='#'+color.getHexString();return;
      }
    }
    $('color').value='#'+color.getHexString();
    this.message('Цвет выбран. Нажми «Закрасить стык».');
  }
  async paint(){
    const item=this.subject();if(!item)return;
    await this.busyWork(async()=>{
      const result=await this.worker('paint',item.bytes,{color:this.color()});
      await this.replace(item,result.bytes,true);this.message('Цвет последнего закрытого среза обновлён.');
    });
  }
  metadata(item,mesh,face){
    let current=mesh,index;
    while(current&&index===undefined){index=item.associations?.get(current)?.nodes;current=current.parent}
    if(index===undefined){
      const j=inspectGlb(item.bytes).json, meshNodes=j.nodes.map((n,i)=>n.mesh!==undefined?i:null).filter(i=>i!==null);
      if(meshNodes.length===1)index=meshNodes[0];
    }
    if(index===undefined)throw Error('Не найден меш этого куска. Открой GLB заново.');
    return {node:index,primitive:item.associations?.get(mesh)?.primitives??0,face};
  }
  async selectPiece(hit){
    const item=this.subject(), pick=this.metadata(item,hit.object,hit.faceIndex);
    await this.busyWork(async()=>{
      const data=await this.worker('piece',item.bytes,pick);
      this.dropPiece();
      this.piece={...pick,id:item.id,faces:data.faces,count:data.count};
      const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(data.vertices,3));
      const material=new THREE.MeshBasicMaterial({color:0x6ae0ff,opacity:.38,transparent:true,side:THREE.DoubleSide,depthWrite:false,
        polygonOffset:true,polygonOffsetFactor:-3});
      this.pieceOverlay=new THREE.Mesh(geometry,material);
      this.pieceOverlay.applyMatrix4(this.placement(item));
      this.pieceOverlay.renderOrder=21;this.helper.add(this.pieceOverlay);
      this.message(data.faces===data.count?'У этого меша один связанный кусок. Раздели его ножом.':'Кусок выделен. Можно оставить или удалить его.');
    });
  }
  async usePiece(mode){
    const item=this.subject();if(!this.piece||this.piece.id!==item.id)return;
    await this.busyWork(async()=>{
      const result=await this.worker('piece',item.bytes,{...this.piece,mode});
      await this.replace(item,result.bytes,true);this.message(mode==='keep'?'Выбранный кусок оставлен.':'Выбранный кусок удалён.');
    });
  }
  dropPiece(){
    if(this.pieceOverlay){this.pieceOverlay.removeFromParent();this.pieceOverlay.geometry.dispose();this.pieceOverlay.material.dispose()}
    this.piece=null;this.pieceOverlay=null;
  }
  async replace(item,bytes,record){
    const loaded=await this.api.load(bytes);
    if(record){
      this.history.push({id:item.id,bytes:item.bytes,owned:item.owned});
      while(this.history.length>1&&(this.history.length>8||this.history.reduce((n,h)=>n+h.bytes.byteLength,0)>80*1048576))this.history.shift();
    }
    if(item.id==='body'){
      if(item.owned){item.root.removeFromParent();this.api.release(item.root)}
      item.owned=true;this.api.scene.add(loaded.scene);
    }else{
      item.root.removeFromParent();this.api.release(item.root);item.offset.add(loaded.scene);
    }
    item.root=loaded.scene;item.associations=loaded.parser.associations;item.bytes=bytes;
    if(item.id==='body')this.readAnchors();
    this.dropPiece();this.clearHighlight();this.visibility();
  }
  async undo(){
    const step=this.history.at(-1);if(!step)return;
    const item=step.id==='body'?this.body:this.items.find(i=>i.id===step.id);
    await this.busyWork(async()=>{
      if(item.id==='body'&&!step.owned){
        item.root.removeFromParent();this.api.release(item.root);item.root=this.api.model().root;
        item.bytes=step.bytes;item.owned=false;item.associations=this.api.model().rigLookup;this.readAnchors();
        this.dropPiece();
      }else await this.replace(item,step.bytes,false);
      this.history.pop();this.hideKnife();this.message('Последняя правка сетки отменена.');
    });
  }
  clearMarkers(){
    for(const node of [...this.markers.children]){node.removeFromParent();node.geometry.dispose();node.material.dispose()}
  }
  drawMarkers(){
    this.clearMarkers();const item=this.item();if(!item||!item.points.length||item.parent<0)return;
    item.group.updateMatrixWorld(true);
    const world=item.points.map(at=>at&&p(at).applyMatrix4(item.group.matrixWorld));
    const size=this.reference();
    for(const [i,pos] of world.entries()){
      if(!pos)continue;
      const selected=i===Number($('point').value), color=selected?0xffd476:0x57cfea;
      const dot=new THREE.Mesh(new THREE.SphereGeometry(size*(selected?.022:.014),10,8),
        new THREE.MeshBasicMaterial({color,depthTest:false}));
      dot.position.copy(pos);dot.renderOrder=110;this.markers.add(dot);
      if(world[i-1]){
        const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([world[i-1],pos]),new THREE.LineBasicMaterial({color,depthTest:false}));
        line.renderOrder=109;this.markers.add(line);
      }
    }
  }
  setPoint(world){
    const item=this.item(), index=Number($('point').value);if(!item||!item.points.length)return;
    item.group.updateMatrixWorld(true);item.points[index]=item.group.worldToLocal(world.clone()).toArray();
    const next=item.points.findIndex((pos,i)=>i>index&&!pos);
    this.tap='';
    if(next>=0){$('point').value=String(next);this.tap='point'}
    this.fields(false);
    this.message(this.tap?'Поставь следующую точку цепочки.':'Точка сохранена.');
  }
  storePoint(){
    const values=axis.map(k=>$('point-'+k).valueAsNumber);
    if(values.every(Number.isFinite))this.setPoint(p(values));
  }
  keyFields(){
    const item=this.item();if(!item)return;
    const time=Math.fround($('time').valueAsNumber||0), bone=Number($('bone').value),
      all=item.keys.filter(k=>k.bone===bone).sort((a,b)=>a.time-b.time), key=all.find(k=>k.time===time);
    $('key-pick').replaceChildren(new Option('Выбери ключ',''),...all.map(k=>new Option(k.time.toFixed(3)+' с',k.time)));
    if(key)$('key-pick').value=String(key.time);
    $('key-delete').disabled=!key;
    for(const [i,k] of axis.entries())$('angle-'+k).value=String(key?.value[i]||0);
    $('time-value').textContent=time.toFixed(3)+' с';
  }
  addKey(){
    const item=this.item();
    if(item.points.some(v=>!v))throw Error('Сначала поставь все точки цепочки.');
    const time=Math.fround($('time').valueAsNumber), bone=Number($('bone').value),
      value=axis.map(k=>ceil($('angle-'+k).valueAsNumber||0,-180,180));
    item.keys=item.keys.filter(k=>k.time!==time||k.bone!==bone);item.keys.push({time,bone,value});
    this.keyFields();this.message('Ключ движения детали записан.');
  }
  deleteKey(){
    const item=this.item(), time=Math.fround($('time').valueAsNumber), bone=Number($('bone').value);
    item.keys=item.keys.filter(k=>k.time!==time||k.bone!==bone);this.keyFields();
  }
  async assemble(){
    const parts=this.items.map(item=>{
      if(item.parent>=0&&item.points.some(v=>!v))throw Error('Поставь все точки цепочки у детали «'+item.name+'».');
      const points=item.parent<0?[]:item.points.map(at=>p(at).applyMatrix4(item.group.matrixWorld).toArray());
      const tracks=points.slice(1).map((_,i)=>({bone:i,keys:item.keys.filter(k=>k.bone===i)}));
      return {name:item.name,parent:item.parent,matrix:this.placement(item).toArray(),bytes:item.bytes,points,
        animation:{body:item.body,duration:item.body>=0?this.api.model().clips[item.body].duration:item.duration,
          name:item.name+' · '+(item.body>=0?this.api.model().clips[item.body].name||'Анимация':'Движение'),tracks}};
    });
    const input=await this.api.input(this.body.bytes);
    if(!parts.length)return {bytes:input};
    return this.worker('assemble',input,{},parts);
  }
  async preview(){
    this.attach('');this.hideKnife();this.dropPiece();this.tap='';
    await this.busyWork(async()=>{
      this.message('Собираем персонажа с деталями для проверки…');
      const {bytes}=await this.assemble(), result=await this.api.load(bytes);
      this.result={...result,bytes};
      this.api.scene.add(result.scene);
      $('clip').replaceChildren(...result.animations.map((clip,i)=>new Option(clip.name||'Движение '+(i+1),i)));
      $('clip').value=String(result.animations.length-1);
      this.visibility();this.playClip();
      this.message('Проверь движение деталей на готовой модели.');
    });
  }
  playClip(){
    if(!this.result)return;
    this.mixer?.stopAllAction();
    const clip=this.result.animations[Number($('clip').value)];
    this.mixer=new THREE.AnimationMixer(this.result.scene);
    if(clip)this.mixer.clipAction(clip).play();
  }
  update(delta){
    if(this.active&&!this.api.model().busy)this.mixer?.update(delta);
  }
  async save(){
    await this.busyWork(async()=>{
      this.message('Сохраняем GLB с деталями…');
      const bytes=this.result?.bytes||(await this.assemble()).bytes;
      const saved=await this.api.save(bytes);
      this.message(saved.message||'GLB сохранён.');
    });
  }
}

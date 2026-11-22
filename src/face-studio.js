import {AnimationMixer, LoopOnce, Mesh, MeshBasicMaterial, Raycaster, SphereGeometry, Vector2, Vector3} from 'three';
import {appendFaceClip, appendMouthShapes, faceNodes, FaceTimeline} from './face-animation.js';
import {jointGlb} from './joint-glb.js';
import {MouthShapeDraft} from './mouth-shapes.js';

const $ = id => document.getElementById('face-'+id);
const number = id => $(id).valueAsNumber;
const range = (x, min, max) => Math.max(min,Math.min(max,x));
const mouthIndex = (names, kind) => {
  const exact=names.indexOf('Mouth'+kind);
  if (exact>=0) return exact;
  const suffix=kind.toLowerCase();
  return names.findIndex(name=>['mouth'+suffix,'jaw'+suffix].includes(name.toLowerCase().replace(/[^a-z]/g,'')));
};

export class FaceStudio {
  constructor(api) {
    this.api=api;
    this.active=false;
    this.meshes=new Map();
    this.timelines=new Map();
    this.point=new Mesh(new SphereGeometry(1,12,8), new MeshBasicMaterial({color:0xffcf63,depthTest:false}));
    this.point.renderOrder=120;
    this.point.visible=false;
    api.scene.add(this.point);
    const on=(id,type,fn)=>$(id).addEventListener(type,event=>this.guard(()=>fn(event)));
    on('shape','change',()=>this.seek());
    on('time','input',()=>this.seek());
    on('weight','input',()=>{
      this.temporary=number('weight');
      this.seek(this.temporary);
    });
    on('body','change',()=>this.chooseTimeline());
    on('duration','change',()=>this.resize());
    on('key','click',()=>this.record());
    on('remove','click',()=>{this.timeline.remove(...this.selection(),number('time'));this.seek()});
    on('keys','change',()=>{
      if (!$('keys').value) return;
      $('time').value=$('keys').value;
      this.seek();
    });
    on('play','click',()=>{
      if (this.playing) {this.playing=false;this.draw();return}
      this.temporary=undefined;
      if (number('time')>=this.timeline.duration) $('time').value='0';
      this.seek();
      this.playing=true;
      this.draw();
    });
    on('template-open','click',()=>{
      if (!this.draft) return;
      $('setup').open=true;
      this.camera('front');
      const summary=$('setup').querySelector('summary');
      summary.focus({preventScroll:true});
      summary.scrollIntoView({block:'center'});
    });
    on('roar','click',()=>this.roar());
    on('save','click',()=>this.save());
    on('mesh','change',()=>this.resetDraft());
    on('front-axis','change',()=>this.resetDraft());
    on('mode','change',()=>{
      if ($('mode').value==='front' || $('mode').value==='side') this.camera($('mode').value);
      else if ($('mode').value!=='view') this.beginMarking();
    });
    for (const side of ['front','side']) on('view-'+side,'click',()=>{this.camera(side)});
    for (const axis of ['x','y','z']) on(axis,'change',()=>{
      if (!this.draft||!Number.isFinite(number(axis))) return;
      this.draft.pivot[axis]=number(axis);
      this.marker();
    });
    on('reset','click',()=>this.resetDraft());
    on('size','input',()=>{
      if (this.draft) this.draft.size=number('size');
      $('size-value').textContent=number('size').toFixed(2)+'×';
    });
    on('generate','click',()=>this.generate());
    on('setup','toggle',()=>this.refresh());
    this.ray=new Raycaster();
    api.canvas.addEventListener('pointerdown',event=>this.pointerDown(event),true);
    api.canvas.addEventListener('pointermove',event=>this.pointerMove(event),true);
    for (const type of ['pointerup','pointercancel','lostpointercapture'])
      api.canvas.addEventListener(type,event=>{if (event.pointerId===this.pointer) this.pointer=null},true);
  }

  async guard(fn) {
    try { await fn() }
    catch (error) { $('status').textContent='Ошибка. '+error.message }
  }

  setTab(active) {
    this.active=active;
    if (!active) this.stop();
    this.refresh();
  }

  refresh() {
    const model=this.api.model();
    if (!this.active) {
      if (!model.busy&&this.source&&this.source!==model.sourceBuffer) {
        this.source=null;
        this.glb=null;
        this.timeline=null;
        this.draft=null;
        this.timelines.clear();
        this.meshes.clear();
      }
      return;
    }
    if (!model.busy && this.source!==model.sourceBuffer) this.guard(()=>this.loadModel(model));
    const ready=!!this.glb&&!model.busy;
    const hasShapes=!!$('shape').options.length&&!!this.glb;
    $('editor').hidden=!hasShapes;
    $('editor').disabled=!ready||!hasShapes;
    $('jaw-controls').disabled=!ready||!this.draft;
    $('save').disabled=!ready || (!this.timeline?.keys.size && !this.generated);
    const open=!!this.draft, roar=!!this.roarTarget();
    $('template-open').disabled=!ready||!open;
    $('roar').disabled=!ready||!roar;
    const hint=!this.glb?'Загрузи модель GLB, чтобы включить шаблоны.'
      :roar?'Формы рта готовы. Выбери анимацию тела ниже и нажми «Рёв», чтобы добавить ключи.'
      :open?'Выбери «Открытый рот» и создай формы челюсти. После этого включится «Рёв».'
      :'Для шаблона открытого рта нужен GLB с одним экземпляром меша лица в одной части.';
    if ($('guide').textContent!==hint) $('guide').textContent=hint;
    this.point.visible=!!this.draft&&ready&&$('setup').open;
  }

  loadModel(model) {
    this.stop();
    this.source=model.sourceBuffer;
    this.glb=null;
    this.draft=null;
    this.timeline=null;
    this.timelines.clear();
    this.meshes.clear();
    this.generated=false;
    if (model.type!=='glb'||!this.source) {
      $('setup').hidden=true;
      $('status').textContent='';
      return;
    }
    this.glb=jointGlb(this.source);
    const {json}=this.glb;
    model.root.traverse(mesh=>{
      if (!mesh.isMesh) return;
      let node=mesh, id;
      while (node&&id===undefined) {id=model.rigLookup?.get(node)?.nodes;node=node.parent}
      if (id===undefined) return;
      const group=this.meshes.get(id)||[];
      group.push(mesh);
      this.meshes.set(id,group);
    });
    $('shape').replaceChildren(...faceNodes(json).filter(n=>this.meshes.has(n.id)).map(n=>{
      const group=document.createElement('optgroup');group.label=n.name;
      group.append(...n.names.map((name,i)=>new Option(name,n.id+':'+i)));
      return group;
    }));
    $('body').replaceChildren(new Option('Отдельная мимика',-1),
      ...(json.animations||[]).map(({name},i)=>new Option(name||'Клип '+(i+1),i)));
    const counts=new Map();
    for (const node of json.nodes) if (node.mesh!==undefined) counts.set(node.mesh,(counts.get(node.mesh)||0)+1);
    const eligible=[...this.meshes].filter(([id, group])=>{
      const meshId=json.nodes[id]?.mesh, m=json.meshes[meshId];
      return group.length===1&&m?.primitives.length===1&&counts.get(meshId)===1&&
        group[0].geometry.attributes.position.count<=500000&&
        !json.extras?.phoenixJointForms?.meshes.some(m=>m.node===id||m.nodeName===json.nodes[id].name)&&
        !m.extras?.targetNames?.some(name=>name==='MouthOpen'||name==='MouthClose');
    });
    $('mesh').replaceChildren(...eligible.map(([id,[mesh]])=>new Option(mesh.name||'Меш '+(id+1),id)));
    $('setup').hidden=!eligible.length;
    this.chooseTimeline(false);
    this.resetDraft();
    $('status').textContent=$('shape').options.length?'Выбери форму и поставь ключ на шкале времени.'
      :eligible.length?'Создай формы рта по шаблону или настрой челюсть вручную.'
      :'Для ключей нужны Blend Shapes. Для построения форм выбери неподелённый меш в GLB.';
  }

  chooseTimeline(show=true) {
    this.stop();
    const body=Number($('body').value), clip=this.api.model().clips[body];
    if (!this.timelines.has(body)) this.timelines.set(body,new FaceTimeline(this.glb,body,clip?.duration||3));
    this.timeline=this.timelines.get(body);
    $('duration-field').hidden=body>=0;
    $('duration').value=String(this.timeline.duration);
    $('time').max=String(this.timeline.duration);
    $('time').value='0';
    const root=clip?.name?clip.name.slice(0,42)+' · Мимика':'Мимика';
    let name=root,i=2;
    while (this.glb.json.animations?.some(clip=>clip.name===name)) name=root+' '+i++;
    $('name').value=name;
    if (show&&$('shape').value) this.seek();
    else this.draw();
  }

  resize() {
    const old=this.timeline.duration, duration=range(number('duration')||3,.1,60);
    this.timeline.duration=Math.fround(duration);
    for (const shapes of this.timeline.keys.values()) for (const keys of shapes.values()) {
      const resized=[...keys].map(([time,value])=>[this.timeline.time(time/old*duration),value]);
      keys.clear();
      for (const [time,value] of resized) keys.set(time,value);
      this.timeline.ordered.delete(keys);
    }
    $('duration').value=String(duration);
    $('time').max=String(duration);
    this.seek();
  }

  selection() {
    return $('shape').value.split(':').map(Number);
  }

  begin() {
    if (this.mixer) return;
    this.api.prepare();
    const state=this.api.model(), clip=state.clips[this.timeline.body];
    this.mixer=new AnimationMixer(state.root);
    if (clip) {
      this.action=this.mixer.clipAction(clip).setLoop(LoopOnce,1);
      this.action.clampWhenFinished=true;
      this.action.play();
      this.action.paused=true;
    }
    this.before=new Map();
    for (const meshes of this.meshes.values()) for (const mesh of meshes)
      if (mesh.morphTargetInfluences) this.before.set(mesh,mesh.morphTargetInfluences.slice());
  }

  sample(t,temporary) {
    this.begin();
    if (this.action) {this.action.time=t;this.mixer.update(0)}
    const [selected,index]=this.selection();
    for (const id of new Set([...this.timeline.keys.keys(),selected])) {
      if (!this.timeline.shapes.has(id)) continue;
      const weights=this.timeline.sample(id,t);
      if (id===selected&&temporary!==undefined) weights[index]=temporary;
      for (const mesh of this.meshes.get(id)||[]) for (let k=0;k<weights.length;k++) mesh.morphTargetInfluences[k]=weights[k];
    }
    this.api.model().root.updateMatrixWorld(true);
  }

  seek(temporary) {
    this.playing=false;
    const time=number('time');
    this.sample(time,temporary);
    this.temporary=temporary;
    this.draw();
  }

  draw(rebuild=true) {
    const [node,shape]=this.selection(), time=this.timeline.time(number('time'));
    const target=this.timeline.shapes.get(node);
    const value=this.temporary??(target?this.timeline.sample(node,time)[shape]:0);
    $('weight').value=String(range(value,-1,1));
    $('weight-value').textContent=Math.round(value*100)+'%';
    $('time-value').textContent=time.toFixed(3)+' / '+this.timeline.duration.toFixed(2)+' с';
    $('play').textContent=this.playing?'Ⅱ Пауза':'▶ Проверить';
    if (rebuild) {
      const keys=this.timeline.getKeys(node,shape);
      $('keys').replaceChildren(new Option(keys?.size?'Перейти к ключу':'Ключей пока нет',''),
        ...[...(keys?.keys()||[])].sort((a,b)=>a-b).map(t=>new Option(t.toFixed(3)+' с',t)));
      if (keys?.has(time)) $('keys').value=String(time);
      $('remove').disabled=!keys?.has(time);
      $('key').textContent=keys?.has(time)?'Обновить ключ':'Записать ключ';
      this.refresh();
    }
  }

  record() {
    this.timeline.set(...this.selection(), number('time'), number('weight'));
    this.seek();
    $('status').textContent='Ключ мимики записан.';
  }

  roarTarget() {
    if (!this.timeline) return null;
    const [selected]=this.selection(), shapes=this.timeline.shapes;
    const nodes=[shapes.get(selected),...shapes.values()];
    for (const node of nodes) {
      if (!node||!this.meshes.has(node.id)) continue;
      const open=mouthIndex(node.names,'Open'), close=mouthIndex(node.names,'Close');
      if (open>=0||close>=0) return {id:node.id,open,close};
    }
    return null;
  }

  roar() {
    const target=this.roarTarget();
    if (!target) return;
    const {id,open,close}=target;
    const keys=[[close,[[0,0],[.18,.4],[.32,0],[1,0]]],[open,[[0,0],[.18,0],[.38,1],[.7,.8],[1,0]]]];
    for (const [index,points] of keys) {
      if (index<0) continue;
      for (const [at,value] of points) this.timeline.set(id,index,at*this.timeline.duration,value);
    }
    $('shape').value=id+':'+(open>=0?open:close);
    this.seek();
    $('status').textContent='Ключи шаблона «Рёв» добавлены.';
  }

  update(dt) {
    if (!this.active||!this.playing||this.api.model().busy) return;
    const next=(number('time')+dt)%this.timeline.duration;
    $('time').value=String(next);
    this.sample(next);
    this.draw(false);
  }

  stop() {
    this.playing=false;
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
      for (const [mesh,values] of this.before) for (let i=0;i<values.length;i++) mesh.morphTargetInfluences[i]=values[i];
    }
    this.mixer=null;
    this.action=null;
    this.temporary=undefined;
    this.point.visible=false;
    $('play').textContent='▶ Проверить';
  }

  resetDraft() {
    this.draft=null;
    if ($('mesh').value==='') return;
    this.api.prepare();
    const [mesh]=this.meshes.get(Number($('mesh').value));
    this.draft=new MouthShapeDraft(this.api.model().root,mesh,$('front-axis').value);
    $('mode').value='view';
    $('size').value='1';
    $('size-value').textContent='1.00×';
    this.marker();
  }

  marker() {
    for (const axis of ['x','y','z']) $(axis).value=this.draft.pivot[axis].toFixed(5);
    this.point.position.copy(this.draft.pivot);
    this.point.scale.setScalar(this.draft.height*.004);
    this.refresh();
  }

  beginMarking() {
    this.api.prepare();
    this.marker();
  }

  camera(side) {
    this.beginMarking();
    const {camera,orbit}=this.api;
    const draft=this.draft;
    orbit.target.copy(draft.pivot).addScaledVector(draft.front,draft.unit*.05);
    camera.position.copy(orbit.target).addScaledVector(side==='side'?draft.right:draft.front,Math.max(.01,draft.unit*.72));
    orbit.update();
    camera.updateMatrixWorld(true);
  }

  hit(event) {
    const rect=this.api.canvas.getBoundingClientRect();
    const at=new Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
    this.ray.setFromCamera(at,this.api.camera);
    return this.ray.intersectObject(this.draft.mesh,false)[0]?.point;
  }

  pointerDown(event) {
    const mode=$('mode').value;
    if (!this.active||!$('setup').open||!this.draft||mode==='view'||this.api.model().busy||event.button>0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.guard(()=>{
      const hit=this.hit(event);
      if (!hit) return;
      if (mode==='front'||mode==='side') {
        const axis=mode==='front'?this.draft.right:this.draft.front;
        const difference=hit.clone().sub(this.draft.pivot);
        this.draft.pivot.addScaledVector(axis,difference.dot(axis));
        this.draft.pivot.y=hit.y;
        this.marker();
        $('status').textContent='Шарнир отмечен. Проверь точку с другого ракурса.';
        return;
      }
      this.pointer=event.pointerId;
      this.api.canvas.setPointerCapture?.(this.pointer);
      this.paint(hit,mode);
    });
  }

  pointerMove(event) {
    if (event.pointerId!==this.pointer||!this.active||this.api.model().busy||performance.now()-(this.dabTime||0)<45) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.guard(()=>{
      const hit=this.hit(event);
      if (hit) this.paint(hit,$('mode').value);
    });
  }

  paint(hit,mode) {
    if (mode!=='add'&&mode!=='erase') return;
    this.dabTime=performance.now();
    const radius=range(number('radius')||1.2,.2,8);
    const strength=range(number('strength')||55,1,100);
    const count=this.draft.paint(hit,this.draft.height*radius/200,strength/100,mode==='add');
    $('status').textContent=count?'Кисть изменила влияние на '+count+' вершинах.':'Кисть не попала в вершины.';
  }

  async generate() {
    if (!this.draft||this.api.model().busy) return;
    this.api.prepare();
    this.api.busy(true);
    try {
      $('status').textContent='Создаём формы рта…';
      const budget=await this.api.budget();
      const forms=this.draft.forms(range(number('close')||20,1,45),range(number('open')||13,1,35));
      const node=Number($('mesh').value), data=appendMouthShapes(this.source,node,forms,budget);
      const drafts=[...this.timelines], body=this.timeline.body;
      await this.api.install(data);
      this.loadModel(this.api.model());
      for (const [index, draft] of drafts) {
        const updated=new FaceTimeline(this.glb,index,draft.duration);
        updated.keys=draft.keys;
        this.timelines.set(index,updated);
      }
      $('body').value=String(body);
      const index=this.timelines.get(body).shapes.get(node).names.indexOf('MouthClose');
      $('shape').value=node+':'+index;
      this.chooseTimeline(false);
      this.generated=true;
      $('status').textContent='Формы готовы. Выбери MouthClose или MouthOpen и проверь на шкале времени.';
    } finally {this.api.busy(false)}
  }

  async save() {
    if (this.api.model().busy) return;
    this.api.prepare();
    this.api.busy(true);
    try {
      const budget=await this.api.budget();
      const source=await this.api.exportSource(budget);
      const data=this.timeline.keys.size?appendFaceClip(source,this.timeline,$('name').value.trim(),budget):source;
      $('status').textContent=(await this.api.save(data)).message;
    } finally {this.api.busy(false)}
  }
}

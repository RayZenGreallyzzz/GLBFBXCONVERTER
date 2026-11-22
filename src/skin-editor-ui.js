import * as THREE from 'three';
import {openSkinDocument,skinEditEligibility,setSkinJointPoints,SKIN_PIVOT_BONES,writeSkinDocument,resetSkinDocument} from './skin-document.js';
import {SkinHistory,makePaintIndex,brushDab,boneWeight,suggestShoulderPoints,protectShoulderTorso} from './skin-weights.js';
import {makeSkinEditPreview,syncSkinEditPreview,SkinPickSurface} from './skin-preview.js';
import {headWeightRegion,headWeightTargets} from './head-weights.js';
import {headTurnTestClip} from './rig-preview.js';
import {ModelPlayback} from './model-playback.js';
const $=id=>document.getElementById(id),frame=()=>new Promise(r=>requestAnimationFrame(r));
const viewDirections={front:[0,0,1],back:[0,0,-1],left:[1,0,0],right:[-1,0,0]};
export class SkinEditorUI{
 constructor(api){this.api=api;this.doc=null;this.tab=false;this.sourceId=null;this.mode='view';this.heatStates=new Map();this.feedback='Открой GLB со скелетом. Исходный файл сохраняется до применения результата.';this.eligibility={eligible:false};this.stroke=0;this.headTest=new ModelPlayback();this.overlay=new THREE.Group();api.scene.add(this.overlay);this.brushCursor=new THREE.Mesh(new THREE.RingGeometry(.97,1,48),new THREE.MeshBasicMaterial({color:0xffdc78,side:THREE.DoubleSide,depthTest:false,transparent:true,opacity:.9}));this.brushCursor.visible=false;this.brushCursor.renderOrder=101;api.scene.add(this.brushCursor);
  $('skin-open').addEventListener('click',()=>this.open());$('skin-close').addEventListener('click',()=>api.discard());$('skin-save').addEventListener('click',()=>this.save());$('skin-use').addEventListener('click',()=>this.use());
  $('skin-canvas-brush').addEventListener('click',()=>this.setMode('brush'));
  $('skin-canvas-rotate').addEventListener('click',()=>this.setMode('view'));
  $('skin-piece-apply').addEventListener('click',()=>this.applyDetail());
  $('skin-operation').addEventListener('change',()=>{this.setMode('brush')});
  $('skin-mode').addEventListener('change',()=>this.setMode($('skin-mode').value));$('skin-bone').addEventListener('change',()=>this.colors());$('skin-heat').addEventListener('change',()=>this.colors());for(const id of ['skin-radius','skin-strength'])$(id).addEventListener('input',()=>this.refresh());
  $('skin-undo').addEventListener('click',()=>this.historyAction('undo'));$('skin-redo').addEventListener('click',()=>this.historyAction('redo'));$('skin-reset').addEventListener('click',()=>{if(!this.doc)return;this.rest();resetSkinDocument(this.doc);this.history.clear();this.clearDetail();this.drafts={};this.resetDrafts();this.sync();this.feedback='Все правки сброшены. Исходные веса и точки восстановлены.';this.refresh()});
  this.viewButtons=[...$('skin-views').querySelectorAll('button')];
  for(const button of this.viewButtons)button.addEventListener('click',()=>this.view(button.dataset.skinView));
  api.orbit.addEventListener('start',()=>{
   if(!this.doc||!this.tab)return;
   this.activeView=null;
   this.updateViewButtons();
  });
  $('skin-shoulder-side').addEventListener('change',()=>this.fields());
  for(const axis of ['x','y','z']){
   $('skin-shoulder-'+axis).addEventListener('change',()=>this.setDraftCoordinate($('skin-shoulder-side').value,'skin-shoulder-',axis));
   $('skin-head-'+axis).addEventListener('change',()=>this.setDraftCoordinate('Head','skin-head-',axis));
  }
  $('skin-head-pivot').addEventListener('click',()=>this.applyHeadPivot());
  $('skin-head-adjust').addEventListener('click',()=>this.applyHeadWeights());
  $('skin-head-play').addEventListener('click',()=>this.playHeadTest());
  $('skin-head-stop').addEventListener('click',()=>{this.stopHeadTest();this.refresh()});
  $('skin-head-strength').addEventListener('input',()=>this.refresh());
  $('skin-suggest').addEventListener('click',()=>this.suggest());$('skin-shoulder-apply').addEventListener('click',()=>this.applyShoulders());$('skin-protect').addEventListener('input',()=>{$('skin-shoulder-apply').disabled=false;$('skin-protect-value').textContent=$('skin-protect').value+'%'});
  api.canvas.addEventListener('pointerdown',e=>this.down(e),{capture:true});api.canvas.addEventListener('pointermove',e=>this.move(e),{capture:true});for(const type of ['pointerup','pointercancel','lostpointercapture'])api.canvas.addEventListener(type,e=>this.up(e,type==='pointercancel'));
 }
 refresh(){const model=this.api.model();if(this.sourceId!==model.root?.uuid){this.sourceId=model.root?.uuid;this.eligibility=model.type==='glb'&&model.sourceBuffer?skinEditEligibility(model.sourceBuffer):{eligible:false,reason:'Открой GLB со скелетом.'}}
  const busy=this.api.busy(),active=!!this.doc;$('skin-open').disabled=busy||active||!this.eligibility.eligible;$('skin-tools').hidden=!active;for(const e of $('skin-tools').querySelectorAll('button,select,input'))e.disabled=busy;for(const id of ['skin-save','skin-use','skin-close'])$(id).disabled=busy||!active;
  $('skin-undo').disabled=busy||!this.history?.undoStack.length;$('skin-redo').disabled=busy||!this.history?.redoStack.length;$('skin-mode').value=this.mode;$('skin-radius-value').textContent=$('skin-radius').value+'% роста';$('skin-strength-value').textContent=$('skin-strength').value+'%';
  const toolbar=$('skin-canvas-tools');
  toolbar.hidden=!active||!this.tab;
  for(const [id,mode] of [['skin-canvas-brush','brush'],['skin-canvas-rotate','view']]){
   $(id).disabled=busy;$(id).setAttribute('aria-pressed',String(this.mode===mode));
  }
  const rigid=$('skin-operation').value==='rigid';
  $('skin-strength').disabled=busy||rigid;
  if(rigid)$('skin-strength-value').textContent='100%';
  $('skin-piece-controls').hidden=this.mode!=='detail';
  $('skin-piece-apply').disabled=busy||!this.detail;
  const forge=this.doc?.j.extras?.phoenixRig?.profile==='humanoid-body';
  const head=forge&&!!this.doc.bones.find(b=>b.name===SKIN_PIVOT_BONES.Head)&&!!this.doc.bones.find(b=>b.name==='mixamorigNeck');
  $('skin-shoulder-tools').hidden=!forge;$('skin-head-tools').hidden=!head;
  $('skin-head-stop').disabled=busy||!this.headTest.active;
  $('skin-head-strength-value').textContent=$('skin-head-strength').value+'%';
  $('skin-head-adjust').disabled=busy||!head||Number($('skin-head-strength').value)===0;
  $('skin-status').textContent=active?this.feedback:this.eligibility.reason||this.feedback;
  $('skin-mode').querySelector('[value=joint]').disabled=!forge;
  $('skin-mode').querySelector('[value=head]').disabled=!head;
  if(!(active&&this.tab&&this.mode==='brush'&&!busy))this.brushCursor.visible=false;
  this.overlay.visible=active&&this.tab&&['joint','head'].includes(this.mode)&&!busy;
  const owns=active&&this.tab&&this.mode!=='view'&&!busy;
  if(owns)this.api.orbit.enabled=false;else if(this.ownsOrbit)this.api.orbit.enabled=true;
  this.ownsOrbit=owns;this.api.canvas.style.cursor=active&&this.tab&&this.mode==='brush'?'crosshair':'';
 }
 setTab(tab){this.tab=tab;if(!tab)this.setMode('view');this.refresh()}
 setMode(mode){
  if((mode==='joint'||mode==='head')&&this.doc?.j.extras?.phoenixRig?.profile!=='humanoid-body')mode='view';
  if(mode==='head'&&!this.drafts?.Head)mode='view';
  if(this.pointer!==undefined)this.up({pointerId:this.pointer});this.stopHeadTest();if(mode!=='detail')this.clearDetail();this.mode=mode;
  if(mode!=='view'&&this.doc){
   if(['head','joint'].includes(mode)&&!this.activeView)this.view(this.projection);
   else this.rest();
   this.api.showResult();
  }
  this.markers();this.refresh()
 }
 rest(){this.api.stop();this.preview?.root.updateMatrixWorld(true)}
 async open(){if(this.api.busy()||this.doc)return;this.api.setBusy(true);let preview,pick;
  try{this.api.stop();this.feedback='Готовим копию для ручных весов…';$('skin-status').textContent=this.feedback;await frame();const doc=openSkinDocument(this.api.model().sourceBuffer,{memoryBudgetMiB:await this.api.memoryBudget()});preview=makeSkinEditPreview(this.api.model().root,this.api.model().rigLookup,doc);pick=new SkinPickSurface(preview,doc);const indices=doc.parts.map(p=>makePaintIndex(p,doc.height));const result={kind:'skin-editor',bytes:doc.bytes,beforeBytes:doc.bytes.length,afterBytes:doc.bytes.length,sourceTriangles:doc.parts.reduce((s,p)=>s+p.triangles.length/3,0),optimizedTriangles:doc.parts.reduce((s,p)=>s+p.triangles.length/3,0),note:'Сравни поворот головы и движения суставов перед сохранением.',getBytes:()=>writeSkinDocument(doc),associations:preview.associations};this.api.result(result,preview.root);this.doc=doc;this.preview=preview;this.pick=pick;this.indices=indices;this.result=result;this.history=new SkinHistory(doc,points=>setSkinJointPoints(doc,points));this.drafts={};this.resetDrafts();const select=$('skin-bone');select.replaceChildren();for(const b of doc.bones){const o=document.createElement('option');o.value=String(b.id);o.textContent=b.name.replace('mixamorig','');select.append(o)}select.value=String(doc.bones.find(b=>b.name===SKIN_PIVOT_BONES.Head)?.id??0);this.feedback='Кисть включена. Выбери кость и коснись модели.';this.mode='brush';this.colors();this.fields();this.view('front',true);
  }catch(e){pick?.dispose();if(preview&&!this.doc)this.api.release(preview.root);this.feedback='Ошибка редактора: '+e.message}finally{this.api.setBusy(false);this.refresh()}
 }
 resetDrafts(){
  if(!this.doc)return;
  for(const [key,name] of Object.entries(SKIN_PIVOT_BONES)){
   const bone=this.doc.bones.find(b=>b.name===name);
   if(bone)this.drafts[key]=(this.doc.jointPoints[key]||bone.position).slice();
  }
  this.fields();this.markers();
 }
 setDraftCoordinate(key,prefix,axis){
  const p=this.drafts?.[key],input=$(prefix+axis),value=input.valueAsNumber;
  if(!p)return;
  if(Number.isFinite(value))p[['x','y','z'].indexOf(axis)]=value;
  this.fields();this.markers();
 }
 fields(){
  for(const [key,prefix] of [[$('skin-shoulder-side').value,'skin-shoulder-'],['Head','skin-head-']]){
   const p=this.drafts?.[key];
   if(p)for(const [i,axis] of ['x','y','z'].entries())$(prefix+axis).value=String(Number(p[i].toFixed(6)));
  }
 }
 markers(){
  for(const o of [...this.overlay.children]){this.overlay.remove(o);o.geometry?.dispose();o.material?.dispose()}
  if(!this.doc||!['joint','head'].includes(this.mode))return;
  for(const [key,point] of Object.entries(this.drafts)){
   if((key==='Head')!==(this.mode==='head'))continue;
   const marker=new THREE.Mesh(new THREE.SphereGeometry(this.doc.height*.009,10,8),new THREE.MeshBasicMaterial({color:key==='Right'?0x4ad8f4:0xffbf55,depthTest:false}));
   marker.position.fromArray(point);marker.renderOrder=100;this.overlay.add(marker);
  }
 }
 applyHeadPivot(){
  if(!this.drafts?.Head||this.api.busy())return;
  this.rest();this.api.showResult();this.history.begin();
  try{
   setSkinJointPoints(this.doc,{...this.doc.jointPoints,Head:this.drafts.Head});
   this.history.end();this.sync();
   this.feedback='Точка Head применена к копии. Проверь поворот головы.';
  }catch(e){this.history.cancel();this.sync();this.feedback=e.message}
  this.refresh();
 }
 async applyHeadWeights(){
  if(!this.doc||this.api.busy())return;
  this.rest();this.api.showResult();this.api.setBusy(true);
  try{
   await frame();
   const region=headWeightRegion(this.doc.bones,this.doc.height,this.doc.jointPoints.Head);
   if(!region)throw Error('Проверь положение Head относительно основания шеи.');
   const strength=Number($('skin-head-strength').value)/100;
   const targets=this.doc.parts.map(p=>headWeightTargets(p,region,strength));
   const count=this.history.applyBoneWeights(region.head,region.neck,targets);
   this.sync();
   this.feedback=count?'Коррекция головы: '+count+' вершин. Проверь поворот и при необходимости уточни веса кистью.':'При этой настройке веса головы совпадают с текущими.';
  }catch(e){this.feedback=e.message}
  finally{this.api.setBusy(false);this.refresh()}
 }
 playHeadTest(){
  if(!this.doc||this.api.busy())return;
  this.setMode('view');this.rest();
  try{
   const original=this.api.model().root,copy=this.preview.root;
   this.headTest.setModels(original,[headTurnTestClip(original)],copy,[headTurnTestClip(copy)]);
   this.headTest.play();this.api.showResult();
   this.feedback='Поворачивается только Head. Сравни «Исходник / Результат» в одной позе.';
  }catch(e){this.feedback=e.message}
  this.refresh();
 }
 stopHeadTest(){if(this.headTest.active)this.headTest.dispose()}
 update(delta){this.headTest.update(delta)}
 async suggest(){if(!this.doc||this.api.busy())return;this.rest();this.api.setBusy(true);try{await frame();const result=suggestShoulderPoints(this.doc);for(const side of ['Left','Right'])this.drafts[side]=result[side].point;this.feedback='Это черновик по сечениям модели. Проверь точки спереди и сбоку, поправь касанием или координатами и нажми «Применить плечи».';this.fields();this.mode='joint';this.view('front');this.markers()}catch(e){this.feedback=e.message}finally{this.api.setBusy(false);this.refresh()}}
 applyShoulders(){if(!this.doc||this.api.busy())return;this.rest();this.history.begin();try{setSkinJointPoints(this.doc,{...this.doc.jointPoints,Left:this.drafts.Left,Right:this.drafts.Right});const count=protectShoulderTorso(this.doc,Number($('skin-protect').value)/100,this.history);this.history.end();this.sync();this.feedback='Плечи применены, изменено вершин корпуса: '+count+'. Проверь исходник/результат на тех же анимациях. Действие можно отменить.'}catch(e){this.history.cancel();this.sync();this.feedback='Ошибка плеч: '+e.message}this.refresh()}
 clearDetail(){
  if(this.detail){
   this.api.scene.remove(this.detail.highlight);
   this.detail.highlight.geometry.dispose();
   this.detail.highlight.material.dispose();
   this.detail=null;
  }
  $('skin-piece-status').textContent='Коснись отдельной детали на модели.';
 }
 selectDetail(event){
  this.clearDetail();
  const hit=this.pick.hit(this.ndc(event),this.api.camera);
  const partIndex=hit?.object.userData.part??-1;
  if(partIndex<0)return;
  const part=this.doc.parts[partIndex],vertices=this.indices[partIndex].component(hit.face.a);
  const total=this.doc.parts.reduce((sum,p)=>sum+p.positions.length/3,0);
  if(vertices.length===total){
   $('skin-piece-status').textContent='Выбрана вся модель. Для участка цельной сетки используй кисть 100%.';
   return;
  }
  const mask=new Uint8Array(part.positions.length/3);
  for(const vertex of vertices)mask[vertex]=1;
  const triangles=part.triangles.filter(vertex=>mask[vertex]);
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(part.positions,3));
  geometry.setIndex(new THREE.BufferAttribute(triangles,1));
  const highlight=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({
   color:0xffce63,side:THREE.DoubleSide,transparent:true,opacity:.65,
   depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-2
  }));
  highlight.renderOrder=3;this.api.scene.add(highlight);
  this.detail={partIndex,vertices,highlight};
  $('skin-piece-status').textContent='Выделено вершин: '+vertices.length.toLocaleString('ru-RU')+'. Проверь выделение и выбери кость.';
 }
 applyDetail(){
  if(!this.doc||!this.detail||this.api.busy())return;
  this.rest();this.api.showResult();
  const {partIndex,vertices}=this.detail,bone=Number($('skin-bone').value);
  const part=this.doc.parts[partIndex];
  const targets=this.doc.parts.map((p,i)=>new Float32Array(i===partIndex?p.weights.length/4:0).fill(NaN));
  for(const n of vertices)if(boneWeight(part,n,bone)<1)targets[partIndex][n]=1;
  const count=this.history.applyBoneWeights(bone,-1,targets);
  this.clearDetail();this.sync();
  this.feedback=count?'Деталь закреплена на кости '+$('skin-bone').selectedOptions[0].textContent+'. Изменено вершин: '+count+'.':'У детали уже полный вес выбранной кости.';
  $('skin-piece-status').textContent=this.feedback;
  this.refresh();
 }
 updateViewButtons(){
  for(const button of this.viewButtons)button.setAttribute('aria-pressed',String(button.dataset.skinView===this.activeView));
 }
 view(side,fit=false){
  if(!this.doc)return;
  this.rest();
  const {camera,orbit}=this.api;
  this.projection=side;this.activeView=side;
  let center=orbit.target.clone(),distance=camera.position.distanceTo(center);
  if(fit){
   const bounds=new THREE.Box3(new THREE.Vector3(...this.doc.bounds.min),new THREE.Vector3(...this.doc.bounds.max));
   center=bounds.getCenter(center);
   distance=bounds.getSize(new THREE.Vector3()).length()*1.3;
  }
  // Drain any old pan or rotation still stored by OrbitControls damping.
  const damping=orbit.enableDamping;
  orbit.enableDamping=false;orbit.update();
  orbit.target.copy(center);camera.up.set(0,1,0);
  camera.position.copy(center).addScaledVector(new THREE.Vector3(...viewDirections[side]),distance);
  orbit.update();orbit.enableDamping=damping;camera.updateMatrixWorld(true);
  this.updateViewButtons();
 }
 placeJoint(event){
  const draft=this.drafts[this.mode==='head'?'Head':$('skin-shoulder-side').value];
  const sideView=this.projection==='left'||this.projection==='right';
  const normal=sideView?new THREE.Vector3(1,0,0):new THREE.Vector3(0,0,1);
  const plane=new THREE.Plane(normal,-draft[sideView?0:2]);
  const ray=new THREE.Raycaster(),point=new THREE.Vector3();
  ray.setFromCamera(this.ndc(event),this.api.camera);
  if(!ray.ray.intersectPlane(plane,point))return;
  draft[1]=point.y;
  draft[sideView?2:0]=sideView?point.z:point.x;
  this.fields();this.markers();
 }
 ndc(e){const r=this.api.canvas.getBoundingClientRect();return new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1)}
 down(e){if(!this.doc||!this.tab||this.api.busy()||this.mode==='view'||e.button>0)return;if(this.pointer!==undefined){e.preventDefault();e.stopImmediatePropagation();return}e.preventDefault();e.stopImmediatePropagation();this.rest();this.api.showResult();this.pointer=e.pointerId;this.api.canvas.setPointerCapture?.(e.pointerId);this.stroke=0;
  this.strokeHint='Коснись видимой поверхности персонажа.';
  if(this.mode==='detail'){this.selectDetail(e);this.refresh();return}
  if(this.mode==='joint'||this.mode==='head'){this.placeJoint(e);return}
  this.history.begin();this.lastDab=0;this.lastPoint={x:e.clientX,y:e.clientY};this.dab(e);
 }
 cursor(e){if(!this.doc||!this.tab||this.mode!=='brush'||this.api.busy())return;const hit=this.pick.hit(this.ndc(e),this.api.camera);this.brushCursor.visible=!!hit;if(!hit)return;const normal=hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));this.brushCursor.position.copy(hit.point).addScaledVector(normal,this.doc.height*.0005);this.brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),normal);this.brushCursor.scale.setScalar(this.doc.height*Number($('skin-radius').value)/200)}
 move(e){this.cursor(e);if(this.pointer!==e.pointerId||this.mode!=='brush')return;e.preventDefault();e.stopImmediatePropagation();if(performance.now()-this.lastDab<45)return;this.strokeTo(e)}
 strokeTo(e){const last=this.lastPoint||{x:e.clientX,y:e.clientY},distance=Math.hypot(e.clientX-last.x,e.clientY-last.y),radius=this.doc.height*Number($('skin-radius').value)/200,depth=this.api.camera.position.distanceTo(this.api.orbit.target),pixels=radius*this.api.canvas.clientHeight/(2*Math.tan(THREE.MathUtils.degToRad(this.api.camera.fov/2))*depth),steps=Math.min(20,Math.max(1,Math.ceil(distance/Math.max(1,pixels*.5))));for(let i=1;i<=steps;i++){if(!this.history.active)break;this.dab({clientX:last.x+(e.clientX-last.x)*i/steps,clientY:last.y+(e.clientY-last.y)*i/steps,batch:true})}if(this.history.active)this.sync();this.lastPoint={x:e.clientX,y:e.clientY}}
 dab(e){
  this.lastDab=performance.now();
  try{
   const hit=this.pick.hit(this.ndc(e),this.api.camera);
   const pi=hit?.object.userData.part??-1;
   if(pi<0)return;
   const p=this.doc.parts[pi],radius=this.doc.height*Number($('skin-radius').value)/200;
   const center=hit.point.toArray(),mode=$('skin-operation').value;
   const candidates=this.indices[pi].near(center,radius);
   if(!candidates.length&&mode==='rigid'){
    // A coarse triangle can be wider than the whole brush. Snap a rigid
    // tap to the nearest corner of the face actually hit by the pointer.
    const corners=[hit.face.a,hit.face.b,hit.face.c].map(n=>[
     n,Math.hypot(p.positions[n*3]-center[0],p.positions[n*3+1]-center[1],p.positions[n*3+2]-center[2])
    ]);
    corners.sort((a,b)=>a[1]-b[1]);candidates.push(corners[0]);
   }
   this.strokeHint=candidates.length?'На этом участке вес не изменился. Проверь кость и действие кисти.':'Под кистью нет вершин. Увеличь её диаметр.';
   this.stroke+=brushDab(this.doc,pi,candidates,{
    bone:Number($('skin-bone').value),radius,strength:Number($('skin-strength').value)/100,mode,
    index:this.indices[pi],history:this.history,
    visible:n=>this.pick.visible(new THREE.Vector3().fromArray(p.positions,n*3),this.api.camera)
   });
   if(!e.batch)this.sync();
   this.feedback=this.stroke?'Мазок: '+this.stroke+' изменений. Отпусти палец для завершения.':this.strokeHint;
   $('skin-status').textContent=this.feedback;
  }catch(e){
   this.history.cancel();this.sync();this.feedback=e.message;this.pointer=undefined;this.refresh();
  }
 }
 up(e,cancel=false){if(this.pointer!==e.pointerId)return;if(this.mode==='brush'&&!cancel&&Number.isFinite(e.clientX)&&this.lastPoint&&Math.hypot(e.clientX-this.lastPoint.x,e.clientY-this.lastPoint.y)>1)this.strokeTo(e);this.pointer=undefined;if(this.mode==='brush'){if(!this.history.active){this.refresh();return}cancel?this.history.cancel():this.history.end();this.sync();this.feedback=cancel?'Мазок отменён.':this.stroke?'Мазок завершён: '+this.stroke+' изменений. Можно отменить или проверить анимацию.':this.strokeHint}this.refresh()}
 colors(){if(!this.doc)return;const selected=Number($('skin-bone').value),heat=$('skin-heat').checked;
  for(const [i,mesh]of this.preview.parts.entries()){if(heat){let state=this.heatStates.get(mesh);if(!state){state={material:mesh.material,color:mesh.geometry.getAttribute('color'),heat:new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide})};this.heatStates.set(mesh,state);mesh.geometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(this.doc.parts[i].weights.length/4*3),3))}const colors=mesh.geometry.attributes.color,c=new THREE.Color();for(let n=0;n<colors.count;n++){const w=boneWeight(this.doc.parts[i],n,selected);c.setHSL((1-w)*.66,1,.48);colors.setXYZ(n,c.r,c.g,c.b)}colors.needsUpdate=true;mesh.material=state.heat}else this.restoreColor(mesh)}
 }
 restoreColor(mesh){const state=this.heatStates.get(mesh);if(!state)return;mesh.material=state.material;state.heat.dispose();if(state.color)mesh.geometry.setAttribute('color',state.color);else mesh.geometry.deleteAttribute('color');this.heatStates.delete(mesh)}
 sync(){if(!this.doc)return;syncSkinEditPreview(this.preview,this.doc);this.colors();this.markers()}
 historyAction(action){if(!this.doc)return;this.rest();this.history[action]();this.resetDrafts();this.sync();this.feedback=action==='undo'?'Последнее действие отменено.':'Действие возвращено.';this.refresh()}
 async save(){if(!this.doc||this.api.busy())return;if(this.pointer!==undefined)this.up({pointerId:this.pointer});this.rest();this.api.setBusy(true);try{await frame();const result=await this.api.save(writeSkinDocument(this.doc),this.api.model().name+'_weights.glb');this.feedback=result.kind==='cancelled'?result.message+' Правки остались в редакторе.':result.message}catch(e){this.feedback='Ошибка сохранения: '+e.message}finally{this.api.setBusy(false);this.refresh()}}
 use(){if(!this.doc||this.api.busy())return;this.rest();const result=this.result;result.bytes=writeSkinDocument(this.doc);for(const mesh of this.preview.parts)this.restoreColor(mesh);this.api.use(result);this.cleanup();this.refresh()}
 cleanup(){this.stopHeadTest();this.clearDetail();if(this.pointer!==undefined)this.up({pointerId:this.pointer},true);for(const mesh of this.preview?.parts||[])this.restoreColor(mesh);this.pick?.dispose();this.doc=null;this.preview=null;this.pick=null;this.indices=null;this.history=null;this.result=null;this.mode='view';this.drafts={};this.markers();this.api.orbit.enabled=true;this.api.canvas.style.cursor='';this.brushCursor.visible=false;this.refresh()}
}

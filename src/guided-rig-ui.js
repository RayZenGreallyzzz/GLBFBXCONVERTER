import * as THREE from 'three';
import {RIG_GUIDES,suggestRigGuides} from './rig-guides.js';
import {startGuidedRig} from './guided-rig-client.js';
import {rigBendTestClip} from './rig-preview.js';
import {setCameraView,viewDirections} from './view-presets.js';

const $=id=>document.getElementById(id);
export class GuidedRigUI{
 constructor(api){
  this.api=api;this.guides=null;this.bounds=null;this.result=null;this.sourceId=null;this.job=null;this.mixer=null;this.testRoot=null;this.view='front';this.tab=false;this.feedback=null;
  this.overlay=new THREE.Group();this.overlay.visible=false;api.scene.add(this.overlay);
  for(const [key,label]of RIG_GUIDES){const o=document.createElement('option');o.value=key;o.textContent=label;$('rig-joint').append(o)}
  this.views=[...$('rig-views').querySelectorAll('button')];
  $('rig-draft').addEventListener('click',()=>this.draft());
  for(const button of this.views)button.addEventListener('click',()=>this.setView(button.dataset.rigView));
  $('rig-joint').addEventListener('change',()=>{this.fields();this.markers()});
  for(const axis of ['x','y','z'])$('rig-'+axis).addEventListener('change',()=>{if(!this.guides||api.busy())return;const value=Number($('rig-'+axis).value);if(!Number.isFinite(value)){this.fields();return}this.invalidate();this.guides[$('rig-joint').value][['x','y','z'].indexOf(axis)]=value;this.markers();this.refresh()});
  for(const id of ['rig-confirm','rig-edit'])$(id).addEventListener('change',()=>this.refresh());
  $('rig-resolution').addEventListener('change',()=>{this.invalidate();this.refresh()});
  $('rig-head-strength').addEventListener('change',()=>{this.invalidate({keepConfirmation:true});this.refresh()});
  $('rig-head-strength').addEventListener('input',()=>{$('rig-head-strength-value').textContent=$('rig-head-strength').value+'%'});
  $('rig-build').addEventListener('click',()=>this.build());$('rig-cancel').addEventListener('click',()=>this.job?.cancel());
  $('rig-test-play').addEventListener('click',()=>this.play());$('rig-test-stop').addEventListener('click',()=>this.stop());
  $('rig-export').addEventListener('click',()=>this.export());$('rig-use').addEventListener('click',()=>this.use());$('rig-edit-weights').addEventListener('click',()=>this.use(true));$('rig-use-fingers').addEventListener('click',()=>this.use('fingers'));
  let down=null;api.canvas.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY}});
  api.canvas.addEventListener('pointerup',e=>{if(!down||Math.hypot(e.clientX-down.x,e.clientY-down.y)>8)return;this.place(e)});
 }
 eligible(){const s=this.api.model();if(!s.root||s.type!=='glb'||!s.sourceBuffer)return false;let rig=false;s.root.traverse(n=>{if(n.isSkinnedMesh||n.morphTargetInfluences?.length)rig=true});return !rig&&!s.clips.length}
 refresh(){
  const s=this.api.model(),id=s.root?.uuid||null;
  if(id!==this.sourceId){this.sourceId=id;this.guides=null;this.bounds=null;this.clearResult();this.feedback=null;$('rig-confirm').checked=false;this.clearMarkers()}
  const eligible=this.eligible(),busy=this.api.busy();
  $('rig-draft').disabled=!eligible||busy;$('rig-build').disabled=!eligible||busy||!this.guides||!$('rig-confirm').checked;
  for(const e of [...this.views,...['rig-joint','rig-x','rig-y','rig-z','rig-edit','rig-confirm','rig-resolution','rig-head-strength'].map($)])e.disabled=busy||!this.guides;
  for(const id of ['rig-export','rig-use','rig-edit-weights','rig-use-fingers','rig-test-play'])$(id).disabled=busy||!this.result;
  $('rig-test-stop').disabled=busy||!this.mixer;$('rig-cancel').hidden=!this.job;
  this.overlay.visible=this.tab&&!!this.guides&&$('rig-edit').checked&&!busy;
  const ownsOrbit=this.overlay.visible;
  if(ownsOrbit||this.ownsOrbit)this.api.orbit.enabled=!ownsOrbit;
  this.ownsOrbit=ownsOrbit;
  if(!this.job&&!this.result)$('rig-status').textContent=this.feedback||(!s.root?'Загрузи GLB без скелета, анимаций и форм.':!eligible?'Для готового скелета открой «Детали», чтобы добавить кости хвоста или привязать оружие.':!this.guides?'Создай черновик точек и проверь суставы с четырёх сторон.':'Выбери сустав и поставь его центр. Левая и правая стороны относятся к персонажу.');
 }
 setTab(value){this.tab=value;this.refresh()}
 clearMarkers(){for(const o of [...this.overlay.children]){this.overlay.remove(o);o.geometry?.dispose();o.material?.dispose()}}
 markers(){
  this.clearMarkers();if(!this.guides||!this.bounds)return;
  const h=this.bounds.max[1]-this.bounds.min[1],selected=$('rig-joint').value;
  for(const [key,p]of Object.entries(this.guides)){const sphere=new THREE.Mesh(new THREE.SphereGeometry(h*(key===selected ? .018 : .011),8,6),new THREE.MeshBasicMaterial({color:key===selected?0xffcf59:0x34d3ed,depthTest:false,transparent:true,opacity:.95}));sphere.position.fromArray(p);sphere.renderOrder=100;this.overlay.add(sphere)}
 }
 fields(){if(!this.guides)return;const p=this.guides[$('rig-joint').value];for(let i=0;i<3;i++)$('rig-'+['x','y','z'][i]).value=String(Number(p[i].toFixed(6)))}
 draft(){
  if(!this.eligible()||this.api.busy())return;this.invalidate();this.api.stopPlayback();const root=this.api.model().root;root.updateMatrixWorld(true);
  const positions=[],v=new THREE.Vector3();let count=0;root.traverse(n=>{if(n.isMesh)count+=n.geometry.attributes.position?.count||0});
  if(count>650000){$('rig-status').textContent='Для точек нужно не больше 650 тысяч вершин. Сначала подготовь сетку в оптимизации.';return}
  const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  root.traverse(n=>{if(!n.isMesh)return;const p=n.geometry.getAttribute('position');for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).applyMatrix4(n.matrixWorld);positions.push(v.x,v.y,v.z);for(let k=0;k<3;k++){bounds.min[k]=Math.min(bounds.min[k],v.getComponent(k));bounds.max[k]=Math.max(bounds.max[k],v.getComponent(k))}}});
  try{this.bounds=bounds;this.guides=suggestRigGuides(bounds,positions);this.fields();this.markers();this.setView('front');this.refresh()}catch(e){$('rig-status').textContent=e.message}
 }
 invalidate({keepConfirmation=false}={}){this.stop();if(this.result)this.api.invalidate();this.result=null;this.feedback=null;if(!keepConfirmation)$('rig-confirm').checked=false}
 setView(view){
  if(!this.bounds)return;this.view=view;const box=new THREE.Box3(new THREE.Vector3(...this.bounds.min),new THREE.Vector3(...this.bounds.max)),center=box.getCenter(new THREE.Vector3()),h=box.getSize(new THREE.Vector3()).length();
  const {camera,orbit}=this.api;
  setCameraView(camera,orbit,center,viewDirections[view],h*1.3/Math.min(1,camera.aspect));
  for(const button of this.views)button.setAttribute('aria-pressed',String(button.dataset.rigView===view));
  this.refresh();
 }
 place(event){
  if(!this.tab||!this.guides||this.api.busy()||!$('rig-edit').checked)return;
  const rect=this.api.canvas.getBoundingClientRect(),p=this.guides[$('rig-joint').value],ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),this.api.camera);
  const side=this.view==='left'||this.view==='right';
  const plane=new THREE.Plane(side?new THREE.Vector3(1,0,0):new THREE.Vector3(0,0,1),-p[side?0:2]),point=new THREE.Vector3();
  if(!ray.ray.intersectPlane(plane,point))return;const h=this.bounds.max[1]-this.bounds.min[1];if(point.toArray().some((x,k)=>x<this.bounds.min[k]-h*.2||x>this.bounds.max[k]+h*.2))return;
  this.invalidate();p[1]=point.y;p[side?2:0]=side?point.z:point.x;this.fields();this.markers();this.refresh();
 }
 clearResult(){this.stop();this.result=null;this.testRoot=null;this.refreshResultButtons()}
 refreshResultButtons(){for(const id of ['rig-export','rig-use','rig-edit-weights','rig-use-fingers','rig-test-play','rig-test-stop'])$(id).disabled=true}
 stop(){if(this.mixer){this.mixer.stopAllAction();if(this.testRoot){this.mixer.uncacheRoot(this.testRoot);this.testRoot.updateMatrixWorld(true)}this.mixer=null}$('rig-test-stop').disabled=true}
 play(){if(!this.result||this.api.busy())return;this.api.stopPlayback();this.stop();this.testRoot=this.api.resultRoot();if(!this.testRoot)return;this.api.showResult();this.mixer=new THREE.AnimationMixer(this.testRoot);this.mixer.clipAction(rigBendTestClip(this.testRoot)).play();this.refresh()}
 update(delta){if(!this.api.busy())this.mixer?.update(delta)}
 async build(){
  if(!this.guides||!this.eligible()||this.api.busy()||!$('rig-confirm').checked)return;
  this.stop();this.feedback=null;this.api.stopPlayback();this.api.setBusy(true);this.refresh();
  try{const memoryBudgetMiB=await this.api.memoryBudget();this.job=startGuidedRig(this.api.model().sourceBuffer,{guides:structuredClone(this.guides),resolution:Number($('rig-resolution').value),headWeightStrength:Number($('rig-head-strength').value)/100,memoryBudgetMiB},(p,s)=>{this.api.progress(p);$('rig-status').textContent=s});this.refresh();const result=await this.job.promise;await this.api.result(result);this.result=result;this.testRoot=this.api.resultRoot();$('rig-status').textContent=result.bones+' костей. '+result.optimizedTriangles.toLocaleString('ru-RU')+' треугольников сохранены. Запусти проверку сгибов и сравни результат.';$('rig-edit').checked=false;
  }catch(e){this.feedback=(e.name==='AbortError'?'':'Ошибка скелета: ')+e.message;$('rig-status').textContent=this.feedback}
  finally{this.job=null;this.api.setBusy(false);this.api.progress(0);this.refresh()}
 }
 async export(){if(!this.result||this.api.busy())return;this.stop();this.api.setBusy(true);try{await this.api.save(this.result.bytes,this.api.model().name+'_rig.glb')}catch(e){$('rig-status').textContent=e.message}finally{this.api.setBusy(false);this.refresh()}}
 use(editWeights=false){if(!this.result||this.api.busy())return;this.stop();const result=this.result;this.api.use(result,editWeights);this.clearResult();this.refresh()}
}

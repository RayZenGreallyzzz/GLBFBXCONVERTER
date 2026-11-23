import {Group,Line,LineBasicMaterial,BufferGeometry,Mesh,MeshBasicMaterial,Plane,Quaternion,Raycaster,SphereGeometry,Vector2,Vector3} from 'three';
import {canonicalBone,characterBones} from './animation-retarget.js';
import {DIGITS,HANDS,fingerRigEligibility} from './finger-rig.js';
import {startGuidedRig} from './guided-rig-client.js';

const $=id=>document.getElementById('finger-'+id);
const point=xyz=>new Vector3().fromArray(xyz);
const curl=new Vector3(1,0,0);
const role=/^(left|right)hand(thumb|index|middle|ring|pinky)([123])$/;
const inputIds=['hand','digit','joint','enabled','radius','palm','edge','edit','x','y','z','confirm','build'];

export class FingerStudio {
  constructor(api) {
    this.api=api;
    this.active=false;
    this.overlay=new Group();
    this.overlay.visible=false;
    api.scene.add(this.overlay);
    this.ray=new Raycaster();
    const bind=(id,type,fn)=>$(id).addEventListener(type,event=>fn(event));
    bind('open','click',()=>this.open());
    bind('hand','change',()=>{this.populateDigits();this.setView(this.view||'palm')});
    bind('digit','change',()=>this.fields());
    bind('joint','change',()=>this.fields());
    bind('palm','click',()=>this.setView('palm'));
    bind('edge','click',()=>this.setView('edge'));
    for (const [k,axis] of ['x','y','z'].entries()) bind(axis,'change',()=>{
      const value=$(axis).valueAsNumber;
      if (Number.isFinite(value)&&this.guide()) {
        this.invalidate();
        this.guide().points[this.joint()][k]=value;
        this.markers();
      }
      this.fields();
    });
    bind('enabled','change',()=>{
      const guide=this.guide();
      if (!guide||guide.existing) return;
      this.invalidate();guide.enabled=$('enabled').checked;
      this.populateDigits($('digit').value);
    });
    bind('radius','input',()=>$('radius-value').textContent=$('radius').value+'%');
    bind('radius','change',()=>{
      if (!this.guide()||this.guide().existing) return;
      this.invalidate();this.guide().radius=$('radius').valueAsNumber/100;this.fields();
    });
    bind('confirm','change',()=>this.refresh());
    bind('edit','change',()=>this.refresh());
    bind('build','click',()=>this.build());
    bind('cancel','click',()=>this.job?.cancel());
    bind('test','input',()=>this.bend($('test').valueAsNumber));
    bind('test-reset','click',()=>this.stop());
    bind('save','click',()=>this.save());
    bind('use','click',()=>this.use(false));
    bind('weights','click',()=>this.use(true));
    api.canvas.addEventListener('pointerdown',event=>{this.down={id:event.pointerId,x:event.clientX,y:event.clientY}});
    api.canvas.addEventListener('pointerup',event=>this.place(event));
  }

  hand() {return this.draft?.hands[$('hand').value]}
  guide() {return this.hand()?.fingers[$('digit').value]}
  joint() {return Number($('joint').value)}

  refresh() {
    const source=this.api.model().sourceBuffer,busy=this.api.busy();
    if (source!==this.source) {
      this.source=source;
      this.draft=null;
      this.clearResult();
      this.clearMarkers();
      this.eligible=this.api.model().type==='glb'&&source?fingerRigEligibility(source):{eligible:false,reason:'Загрузи GLB со скелетом или создай скелет тела.'};
      $('status').textContent=this.eligible.eligible?'Создай черновик и проверь положение фаланг.':this.eligible.reason;
    }
    const guide=this.guide(), editable=!!guide&&!guide.existing;
    $('open').disabled=busy||!this.eligible?.eligible;
    $('tools').hidden=!this.draft;
    for (const id of inputIds) $(id).disabled=busy||!this.draft;
    for (const id of ['joint','enabled','radius','x','y','z']) $(id).disabled=busy||!editable;
    $('build').disabled=busy||!this.draft||!$('confirm').checked||
      !Object.values(this.draft.hands).some(h=>Object.values(h.fingers).some(f=>f.enabled));
    $('cancel').hidden=!this.job;
    $('result').hidden=!this.result;
    for (const id of ['test','test-reset','save','use','weights']) $(id).disabled=busy||!this.result;
    const placing=this.active&&editable&&$('edit').checked&&!busy&&!this.result;
    this.overlay.visible=placing;
    if (this.active&&this.draft) this.api.orbit.enabled=!placing;
  }

  setTab(active) {
    this.active=active;
    if (!active) this.stop();
    this.refresh();
  }

  async run(operation,draft) {
    this.api.busy(true);
    let destination;
    try {
      const memoryBudgetMiB=await this.api.budget();
      this.job=startGuidedRig(this.source,{operation,draft,memoryBudgetMiB},(value,message)=>{
        this.api.progress(value);$('status').textContent=message;
      });
      this.refresh();
      const result=await this.job.promise;
      if (operation==='finger-rig') {
        await this.api.result(result);
        this.result=result;
        $('status').textContent='Добавлено '+result.added+' костей. Согни пальцы и проверь деформацию.';
        destination=$('result');
      }else{
        this.draft=result;
        $('hand').replaceChildren(...HANDS.filter(([id])=>result.hands[id]).map(([id,label])=>new Option(label,id)));
        this.populateDigits();
        this.setView('palm');
        $('status').textContent='Проверь основания, сгибы и кончики на обеих кистях. Отключи пальцы, которых нет на модели.';
      }
    }catch(error){$('status').textContent=error.message;destination=$('status')}
    finally{
      this.job=null;this.api.busy(false);this.api.progress(0);this.refresh();
      if (this.active) destination?.scrollIntoView({block:'center'});
    }
  }

  async open() {
    if (!this.eligible?.eligible||this.api.busy()) return;
    this.invalidate();
    this.api.prepare();
    $('status').textContent='Ищем кисти и предлагаем точки пальцев…';
    await this.run('finger-draft');
  }

  async build() {
    if ($('build').disabled) return;
    this.stop();
    this.api.prepare();
    $('status').textContent='Проверяем положение и веса пальцев…';
    await this.run('finger-rig',structuredClone(this.draft));
  }

  invalidate() {
    if (this.result) this.api.discard();
    $('confirm').checked=false;
  }

  populateDigits(selected='') {
    const select=$('digit'), hand=this.hand();
    select.replaceChildren(...DIGITS.map(([id,label])=>{
      const guide=hand.fingers[id];
      return new Option(label+(guide.existing?' · уже есть':guide.enabled?'':' · выключен'),id);
    }));
    if (selected) select.value=selected;
    else select.value=DIGITS.find(([id])=>!hand.fingers[id].existing)?.[0]||DIGITS[0][0];
    $('joint').value='0';
    this.fields();
  }

  fields() {
    const guide=this.guide();
    if (!guide) return;
    $('enabled').checked=guide.enabled;
    $('radius').value=String(guide.radius*100);
    $('radius-value').textContent=$('radius').value+'%';
    for (const [k,axis] of ['x','y','z'].entries()) $(axis).value=String(Number(guide.points[this.joint()][k].toPrecision(7)));
    this.markers();
    this.refresh();
  }

  clearMarkers() {
    for (const child of [...this.overlay.children]) {
      this.overlay.remove(child);child.geometry.dispose();child.material.dispose();
    }
  }

  markers() {
    this.clearMarkers();
    const hand=this.hand();
    if (!hand) return;
    for (const [id,guide] of Object.entries(hand.fingers)) {
      if (guide.existing||(!guide.enabled&&id!==$('digit').value)) continue;
      const picked=id===$('digit').value, verts=guide.points.map(point);
      const line=new Line(new BufferGeometry().setFromPoints(verts),new LineBasicMaterial({
        color:picked?0xffc950:0x47cee8,depthTest:false
      }));
      line.renderOrder=110;
      this.overlay.add(line);
      for (const [j,location] of verts.entries()) {
        const chosen=picked&&j===this.joint();
        const dot=new Mesh(new SphereGeometry(hand.length*(chosen?.026:.014),8,6),new MeshBasicMaterial({
          color:chosen?0xffca54:0x60ddf0,depthTest:false
        }));
        dot.position.copy(location);dot.renderOrder=111;this.overlay.add(dot);
      }
    }
  }

  setView(view) {
    const hand=this.hand();
    if (!hand) return;
    this.view=view;
    const {camera,orbit}=this.api;
    const out=point(view==='palm'?hand.palmDown:hand.spread);
    this.viewNormal=out;
    this.api.showOriginal();
    orbit.target.copy(point(hand.wrist)).addScaledVector(point(hand.along),hand.length*.56);
    camera.up.copy(point(view==='palm'?hand.spread:hand.palmDown));
    camera.position.copy(orbit.target).addScaledVector(out,hand.length*1.9/Math.min(1,camera.aspect));
    const damp=orbit.enableDamping;
    orbit.enableDamping=false;orbit.update();orbit.enableDamping=damp;
    camera.updateMatrixWorld(true);
    $('palm').setAttribute('aria-pressed',String(view==='palm'));
    $('edge').setAttribute('aria-pressed',String(view==='edge'));
    this.refresh();
  }

  place(event) {
    const down=this.down;
    this.down=null;
    if (!this.overlay.visible||!down||down.id!==event.pointerId||Math.hypot(down.x-event.clientX,down.y-event.clientY)>9) return;
    const guide=this.guide(), selected=this.joint(), rect=this.api.canvas.getBoundingClientRect();
    const plane=new Plane().setFromNormalAndCoplanarPoint(this.viewNormal,point(guide.points[selected]));
    this.ray.setFromCamera(new Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2),this.api.camera);
    const hit=this.ray.ray.intersectPlane(plane,new Vector3());
    if (!hit) return;
    this.invalidate();guide.points[selected]=hit.toArray();this.fields();
  }

  bend(degrees) {
    if (!this.result||this.api.busy()) return;
    if (!this.pose) {
      this.api.prepare();this.api.showResult();
      this.pose=characterBones(this.api.resultRoot()).flatMap(bone=>{
        const match=canonicalBone(bone.name).match(role);
        return match?[[bone,bone.quaternion.clone(),Number(match[3])]]:[];
      });
    }
    $('test').value=String(degrees);
    $('test-value').textContent=degrees+'°';
    const delta=new Quaternion(), angle=degrees*Math.PI/180;
    for (const [bone,rotation,segment] of this.pose)
      bone.quaternion.copy(rotation).multiply(delta.setFromAxisAngle(curl,angle*[.85,1,.66][segment-1]));
    this.api.resultRoot().updateMatrixWorld(true);
  }

  stop() {
    for (const [bone,rotation] of this.pose||[]) bone.quaternion.copy(rotation);
    if (this.pose) this.api.resultRoot()?.updateMatrixWorld(true);
    this.pose=null;$('test').value='0';$('test-value').textContent='0°';
  }

  clearResult() {this.stop();this.result=null;$('result').hidden=true}

  async save() {
    if (!this.result||this.api.busy()) return;
    this.stop();this.api.busy(true);
    try {$('status').textContent=(await this.api.save(this.result.bytes)).message}
    catch(error){$('status').textContent=error.message}
    finally{this.api.busy(false)}
  }

  use(editWeights) {
    if (!this.result||this.api.busy()) return;
    this.stop();
    this.api.use(this.result,editWeights);
  }
}

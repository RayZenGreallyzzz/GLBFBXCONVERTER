import {armRepairEligibility} from './arm-weight-repair.js';
import {startGuidedRig} from './guided-rig-client.js';
const $=id=>document.getElementById(id);
export class ArmWeightsUI{
 constructor(api){this.api=api;this.sourceId=null;this.result=null;this.job=null;this.feedback=null;this.eligibility={eligible:false,reason:'Открой GLB со скелетом тела Forge.'};
  $('arms-build').addEventListener('click',()=>this.build());$('arms-cancel').addEventListener('click',()=>this.job?.cancel());$('arms-save').addEventListener('click',()=>this.save());$('arms-use').addEventListener('click',()=>this.use());
 }
 refresh(){const model=this.api.model();if(this.sourceId!==model.root?.uuid){this.sourceId=model.root?.uuid;this.result=null;this.feedback=null;this.eligibility=model.type==='glb'&&model.sourceBuffer?armRepairEligibility(model.sourceBuffer):{eligible:false,reason:'Открой GLB со скелетом тела Forge (27 костей).'}}
  if(this.result&&this.api.preview()!==this.result)this.result=null;const busy=this.api.busy();$('arms-build').disabled=busy||!this.eligibility.eligible||!!this.result;for(const id of ['arms-save','arms-use'])$(id).disabled=busy||!this.result;$('arms-cancel').hidden=!this.job;
  if(!this.job)$('arms-status').textContent=this.feedback||this.eligibility.reason||'Исправь веса готового скелета Forge. После расчёта сравни исходник и результат в движении.';
 }
 clearResult(){this.result=null;this.feedback=null}
 async build(){if(!this.eligibility.eligible||this.api.busy())return;this.api.stop();this.feedback=null;this.api.setBusy(true);
  try{this.job=startGuidedRig(this.api.model().sourceBuffer,{operation:'arm-weights',memoryBudgetMiB:await this.api.memoryBudget()},(p,message)=>{this.api.progress(p);$('arms-status').textContent=message});this.refresh();const result=await this.job.promise;await this.api.result(result);this.result=result;this.feedback='Обновлено вершин: '+result.changedVertices.toLocaleString('ru-RU')+'. Выбери удар в проигрывателе и сравни «Исходник» / «Результат». Затем сохрани GLB или примени веса.';
  }catch(error){this.feedback=(error.name==='AbortError'?'':'Ошибка весов: ')+error.message}finally{this.job=null;this.api.setBusy(false);this.api.progress(0);this.refresh()}
 }
 async save(){if(!this.result||this.api.busy())return;this.api.stop();this.api.setBusy(true);try{await this.api.save(this.result.bytes,this.api.model().name+'_arms_fixed.glb')}catch(error){this.feedback=error.message}finally{this.api.setBusy(false);this.refresh()}}
 use(){if(!this.result||this.api.busy())return;this.api.stop();this.api.use(this.result);this.clearResult();this.refresh()}
}

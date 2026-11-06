import {AnimationMixer,LoopRepeat} from 'three';

// View-only playback: both graphs use one absolute time. Stopping restores
// their bound properties before either graph is optimized or scene-exported.
export class ModelPlayback{
 constructor(){this.models=[];this.mixers=[];this.playing=false;this.time=0;this.index=-1}
 get active(){return this.mixers.length>0}
 setModels(source,clips=[],preview=null,previewClips=[]){
  this.dispose();
  if(source&&clips.length)this.models.push({root:source,clips});
  if(preview&&previewClips.length)this.models.push({root:preview,clips:previewClips});
 }
 play(index=0){
  const clip=this.models[0]?.clips[index];if(!clip)throw Error('Анимация не найдена');
  if(!(clip.duration>0)||!Number.isFinite(clip.duration))throw Error('У анимации нет длительности');
  if(!this.active||this.index!==index){
   this.stop();this.index=index;
   try{
    for(const model of this.models){
     const candidate=model.clips[index];
     if(!candidate||candidate.name!==clip.name)throw Error('Анимации исходника и результата не совпадают');
     if(!(candidate.duration>0)||!Number.isFinite(candidate.duration))throw Error('У анимации нет длительности');
     const mixer=new AnimationMixer(model.root);this.mixers.push({mixer,root:model.root});
     mixer.clipAction(candidate).reset().setLoop(LoopRepeat,Infinity).play();
    }
    this.applyTime();
   }catch(e){this.stop();throw e}
  }
  this.playing=true;
 }
 pause(){this.playing=false}
 update(delta){
  if(!this.playing||!Number.isFinite(delta)||delta<0)return;
  this.time+=Math.min(delta,.1);this.applyTime();
 }
 applyTime(){
  for(const {mixer,root}of this.mixers){mixer.setTime(this.time);root.updateMatrixWorld(true)}
 }
 stop(){
  for(const {mixer,root}of this.mixers){mixer.stopAllAction();mixer.uncacheRoot(root);root.updateMatrixWorld(true)}
  this.mixers=[];this.playing=false;this.time=0;this.index=-1;
 }
 dispose(){this.stop();this.models=[]}
}

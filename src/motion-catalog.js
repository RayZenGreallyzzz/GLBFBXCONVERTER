import {createMotionVisual,MotionCanvas} from './motion-visual.js';
const $=id=>document.getElementById(id);
export class MotionCatalog{
 constructor(api){
  this.api=api;this.entries=[];this.cache=new Map();this.players=[];this.page=0;this.pageSize=6;this.query='';this.epoch=0;this.opened=false;this.ownsBusy=false;this.job=Promise.resolve();this.controller=null;this.closing=null;this.selecting=false;this.playing=true;
  this.dialog=$('motion-catalog');$('anim-browse').addEventListener('click',()=>this.open());$('motion-catalog-close').addEventListener('click',()=>this.close());this.dialog.addEventListener('cancel',e=>{e.preventDefault();this.close()});
  this.dialog.addEventListener('click',e=>{const r=this.dialog.getBoundingClientRect();if(e.target===this.dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))this.close()});
  $('motion-catalog-search').addEventListener('input',()=>{clearTimeout(this.searchTimer);this.query=$('motion-catalog-search').value;this.page=0;this.searchTimer=setTimeout(()=>this.render(),180)});
  $('motion-catalog-prev').addEventListener('click',()=>{if(this.page>0){this.page--;this.render()}});$('motion-catalog-next').addEventListener('click',()=>{if((this.page+1)*this.pageSize<this.filtered().length){this.page++;this.render()}});
  $('motion-catalog-toggle').addEventListener('click',()=>{this.playing=!this.playing;$('motion-catalog-toggle').textContent=this.playing?'Ⅱ Пауза миниатюр':'▶ Играть миниатюры';$('motion-catalog-toggle').setAttribute('aria-pressed',String(this.playing))});
 }
 get isOpen(){return this.opened}
 setEntries(entries){this.epoch++;this.controller?.abort();this.entries=entries;this.cache.clear();this.page=0;this.players=[];$('motion-catalog-grid').replaceChildren();if(this.opened)this.close()}
 remember(index,data){this.cache.delete(index);this.cache.set(index,{data});while(this.cache.size>24)this.cache.delete(this.cache.keys().next().value)}
 cached(index){const item=this.cache.get(index);if(item){this.cache.delete(index);this.cache.set(index,item)}return item}
 filtered(){const words=this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);return this.entries.map((entry,index)=>({entry,index})).filter(({entry})=>words.every(w=>entry.label.toLocaleLowerCase().includes(w)))}
 open(){
  if(this.opened||this.api.busy()||!this.entries.length)return;this.opener=document.activeElement;this.api.stop();this.api.setBusy(true);this.ownsBusy=true;this.opened=true;const query=this.api.filter()||'';if(query!==this.query)this.page=0;this.query=query;$('motion-catalog-search').value=this.query;this.playing=true;$('motion-catalog-toggle').textContent='Ⅱ Пауза миниатюр';$('motion-catalog-toggle').setAttribute('aria-pressed','true');
  if(this.dialog.showModal)this.dialog.showModal();else this.dialog.setAttribute('open','');this.render();$('motion-catalog-close').focus({preventScroll:true});
 }
 async close(){
  if(this.closing)return this.closing;if(!this.opened&&!this.ownsBusy)return;
  this.opened=false;this.epoch++;clearTimeout(this.searchTimer);this.controller?.abort();this.players=[];if(this.dialog.close)this.dialog.close();else this.dialog.removeAttribute('open');
  this.closing=(async()=>{try{await this.job}catch{}finally{if(this.ownsBusy){this.ownsBusy=false;this.api.setBusy(false)}this.closing=null;this.opener?.focus?.({preventScroll:true})}})();return this.closing;
 }
 async pick(index){if(this.selecting)return;this.selecting=true;try{await this.close();await this.api.select(index,this.query)}catch(error){this.api.error(error.message)}finally{this.selecting=false}}
 render(){
  if(!this.opened)return;const previous=this.job;this.controller?.abort();const controller=new AbortController();this.controller=controller;const epoch=++this.epoch,filtered=this.filtered(),pages=Math.max(1,Math.ceil(filtered.length/this.pageSize));this.page=Math.min(this.page,pages-1);const visible=filtered.slice(this.page*this.pageSize,(this.page+1)*this.pageSize),grid=$('motion-catalog-grid');grid.replaceChildren();this.players=[];
  $('motion-catalog-page').textContent=(this.page+1)+' / '+pages+' · файлов: '+filtered.length;$('motion-catalog-prev').disabled=this.page===0;$('motion-catalog-next').disabled=this.page+1>=pages;$('motion-catalog-state').textContent=visible.length?'Готовим миниатюры…':'Ничего не найдено. Измени поиск.';
  const cards=visible.map(({entry,index})=>{const card=document.createElement('article');card.className='motion-card';if(this.api.current(index))card.classList.add('motion-card-selected');card.dataset.entry=String(index);const canvas=document.createElement('canvas');canvas.width=320;canvas.height=224;canvas.setAttribute('role','img');canvas.setAttribute('aria-label','Предпросмотр '+entry.path);const title=document.createElement('strong');title.textContent=entry.path.split('/').at(-1).replace(/\.[^.]+$/,'');const path=document.createElement('small');path.className='motion-card-path';path.textContent=entry.path.split('/').slice(-2).join('/');path.title=entry.path;const meta=document.createElement('small');meta.className='motion-card-meta';meta.textContent='Читаем движение…';const button=document.createElement('button');button.type='button';button.textContent='На персонаже';button.disabled=true;button.addEventListener('click',()=>this.pick(index));card.append(canvas,title,path,meta,button);grid.append(card);return {entry,index,card,canvas,title,meta,button}});
  this.job=(async()=>{try{await previous}catch{}let ready=0;for(const view of cards){if(!this.opened||epoch!==this.epoch)return;
   let item=this.cached(view.index);if(!item){try{const current=this.api.current(view.index),source=current||await this.api.load(view.entry,controller.signal);if(controller.signal.aborted)return;item={data:createMotionVisual(source,source.clips?.[0]||source.clip)}}catch(error){if(error.name==='AbortError')return;item={error:error.message}}
    if(epoch!==this.epoch||!this.opened)return;this.cache.set(view.index,item);while(this.cache.size>24)this.cache.delete(this.cache.keys().next().value);
   }
   if(item.data){const data=item.data,player=new MotionCanvas(view.canvas);player.set(data);this.players.push(player);view.title.textContent=data.name;view.meta.textContent=data.fullDuration.toFixed(2)+' с'+(data.clipCount>1?' · клипов: '+data.clipCount+' (показан первый)':'')+(data.fullDuration>data.duration+.01?' · первые '+data.duration.toFixed(0)+' с':'');view.button.disabled=false;view.card.dataset.ready='true';}
   else{view.meta.textContent=item.error;view.card.classList.add('motion-card-error');view.card.dataset.ready='error';view.button.textContent='Нет предпросмотра'}
   ready++;$('motion-catalog-state').textContent='Готово: '+ready+' / '+cards.length;
  }})();
 }
 update(now){for(const player of this.players)player.update(now,this.opened&&this.playing&&document.visibilityState!=='hidden')}
}

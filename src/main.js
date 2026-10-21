import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {Capacitor,registerPlugin} from '@capacitor/core';
import {inspectGlb,inspectFbx,modelStats,assertGlbPreserved} from './format.js';
import { optimizeGlb, MOBILE_PRESETS, formatSize } from './glb-optimize.js';
import { importAdditional, exportAdditional, getExportWarnings, outputNameExt,
 SUPPORTED_INPUTS, STATIC_EXPORTS, validateImportFiles } from './model-formats.js';
import './style.css';
const $=id=>document.getElementById(id),saver=registerPlugin('ModelSaver');
const scene=new THREE.Scene();scene.background=new THREE.Color('#0a1423');
scene.add(new THREE.HemisphereLight(0xe6f0ff,0x314256,2.6));
const sunlight=new THREE.DirectionalLight(0xffffff,2.4);sunlight.position.set(5,9,7);scene.add(sunlight);
scene.add(new THREE.GridHelper(12,24,0x367da6,0x20394a));
const camera=new THREE.PerspectiveCamera(45,1,.001,2000);camera.position.set(3,2,5);
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.7));
renderer.outputColorSpace=THREE.SRGBColorSpace;
$('viewport').append(renderer.domElement);
const orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;
const state={root:null,clips:[],name:'model',bytes:0,type:'',sourceBuffer:null,busy:false,info:'',preview:null,previewRoot:null};
function status(t){$('status').textContent=t}
function progress(n){$('progress').style.width=n+'%'}
function buttons(){
 const ready=!!state.root&&!state.busy;
 $('preview-opt').disabled=!ready;
 $('opt-export').disabled=!ready||!state.preview;
 $('convert-export').disabled=!ready;
 document.querySelectorAll('[data-quality]').forEach(b=>b.disabled=state.busy);
 $('view-original').disabled=!ready||!state.previewRoot;
 $('view-optimized').disabled=!ready||!state.previewRoot;
}
function fit(){
  const bounds=new THREE.Box3().setFromObject(state.root);if(bounds.isEmpty())return;
  const center=bounds.getCenter(new THREE.Vector3()),dist=Math.max(.5,bounds.getSize(new THREE.Vector3()).length());
  orbit.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(.7*dist,.4*dist,1.5*dist));
  camera.near=Math.max(.0001,dist/50000);camera.far=Math.max(200,dist*300);
  camera.updateProjectionMatrix();orbit.update();
}
function release(root){root?.traverse(obj=>{if(!obj.isMesh)return;obj.geometry?.dispose();for(const m of Array.isArray(obj.material)?obj.material:[obj.material])if(m){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose()}})}
function showComparison(optimized=false){
 const isPreview=optimized&&!!state.previewRoot;
 if(state.root)state.root.visible=!isPreview;
 if(state.previewRoot)state.previewRoot.visible=isPreview;
 $('view-original').classList.toggle('active',!isPreview);
 $('view-optimized').classList.toggle('active',isPreview);
 $('view-original').setAttribute('aria-pressed',String(!isPreview));
 $('view-optimized').setAttribute('aria-pressed',String(isPreview));
 $('view-label').textContent=isPreview?'После оптимизации':'Исходная модель';
}
function discardPreview(){
 if(state.previewRoot){
   scene.remove(state.previewRoot);release(state.previewRoot);
 }
 state.previewRoot=null;state.preview=null;
 if(state.root)state.root.visible=true;
 $('preview-switch').hidden=true;$('view-label').hidden=true;
 showComparison(false);
 $('compare-report').textContent='Выбери качество и нажми «Создать предпросмотр».';
 buttons();
}
function appendStats(container,title,size,triangles){
 const card=document.createElement('article'),head=document.createElement('strong');
 head.textContent=title;
 const bytes=document.createElement('b');bytes.textContent=formatSize(size);
 const detail=document.createElement('small');detail.textContent=
   triangles.toLocaleString('ru-RU')+' треугольников';
 card.append(head,bytes,detail);container.append(card);
}
function displayComparison(result){
 const report=$('compare-report');report.replaceChildren();
 const wrapper=document.createElement('div');wrapper.className='compare-stats';
 appendStats(wrapper,'До',result.beforeBytes,result.sourceTriangles);
 appendStats(wrapper,'После',result.afterBytes,result.optimizedTriangles);
 report.append(wrapper);
 const p=document.createElement('p');p.className='compare-note';
 const reduction=result.sourceTriangles>0
   ?Math.round(100*(1-result.optimizedTriangles/result.sourceTriangles)):0;
 p.textContent='Сетка: −'+reduction+'% · Размер: −'+
   Math.max(0,Math.round(100*(1-result.afterBytes/result.beforeBytes)))+'%. '+
   (result.note||'Переключай «Исходник / Результат» и сравнивай детали.');
 report.append(p);
}
function display(){
 const m=modelStats(state.root,state.clips),metrics=[['Размер',(state.bytes/1048576).toFixed(1)+' МБ'],['Меши',m.meshes],['Полигоны',m.triangles],['Вершины',m.vertices],['Материалы',m.materials],['Текстуры',m.textures],['Кости',m.bones],['Анимации',m.animations]];
 $('metrics').replaceChildren();
 for(const [label,value] of metrics){const row=document.createElement('div');row.className='metric';const l=document.createElement('span');l.textContent=label;const n=document.createElement('strong');n.textContent=value;row.append(l,n);$('metrics').append(row)}
 $('compat').textContent=state.info+'\n'+
   (m.skinned?'Есть привязка к скелету; проверь анимацию в Godot.':'Скелет отсутствует либо не привязан.')+
   '\nПоддерживаемые входные форматы: '+SUPPORTED_INPUTS.map(x=>x.toUpperCase()).join(', ')+
   '\nUSD/USDC и VRM-экспорт в текущей версии не поддерживаются.';
}
async function load(file,attachments=[file]){
 if(!file||state.busy)return;
 if(file.size>250*1048576){status('Большой файл: больше 250 МБ. Отмена для защиты памяти Android.');return}
 state.busy=true;buttons();progress(10);status('Читаем и проверяем модель…');
 let root=null;
 try{
   const ext=file.name.split('.').at(-1).toLowerCase(),data=await file.arrayBuffer();progress(35);
   let clips=[],info='';
   if(ext==='glb'){
     const check=inspectGlb(data),loaded=await new GLTFLoader().parseAsync(data,'');
     root=loaded.scene;clips=loaded.animations||[];
     info='GLB 2.0. Мешей: '+check.meshes+'. Анимаций: '+check.animations+'. Доп. расширения: '+(check.required.join(', ')||'нет')+'.';
   }else if(ext==='fbx'){
     const check=inspectFbx(data);root=new FBXLoader().parse(data,'');clips=root.animations||[];
     info=check.label+'. FBX может импортироваться не полностью: проверь материалы и движения.';
   }else if(['gltf','vrm','obj','ply','stl','dae','usdz'].includes(ext)){
     const result=await importAdditional(file,data,attachments);
     root=result.root;clips=result.clips||[];info=result.notice;
   }else throw Error('Неизвестный входной формат: '+ext);
   if(!root)throw Error('Модель не найдена');
   discardPreview();
   if(state.root){scene.remove(state.root);release(state.root)}
   scene.add(root);state.root=root;state.clips=clips;
   state.name=file.name.replace(/\.[^.]+$/,'').replace(/[^\p{L}\p{N}_ -]/gu,'_').slice(0,55);
   state.bytes=file.size;state.type=ext;state.sourceBuffer=ext==='glb'?data:null;state.info=info;
   updateExportWarnings();
   $('filename').textContent=file.name;$('empty').style.display='none';fit();display();progress(100);status('✓ Загружено, можно экспортировать');
 }catch(error){console.error(error);status('Ошибка загрузки: '+(error.message||error));if(root&&root!==state.root)release(root)}
 finally{state.busy=false;buttons();setTimeout(()=>progress(0),900)}
}
function downloadBrowser(value,name,mime){
 const link=document.createElement('a'),url=URL.createObjectURL(new Blob([value],{type:mime}));
 link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function save(value,name,mime){
 if(!Capacitor.isNativePlatform()){downloadBrowser(value,name,mime);status('✓ Отправлено в загрузки: '+name);return}
 const b=typeof value==='string'?new TextEncoder().encode(value):value instanceof Uint8Array?value:new Uint8Array(value);
 await saver.begin({name,mime});
 try{
   for(let offset=0;offset<b.length;offset+=75000){
     const part=b.subarray(offset,Math.min(offset+75000,b.length));let binary='';
     for(let i=0;i<part.length;i++)binary+=String.fromCharCode(part[i]);
     await saver.append({data:btoa(binary)});
     progress(Math.round((offset+part.length)/b.length*100));
     if(offset%750000===0)await new Promise(r=>setTimeout(r,0));
   }
   const r=await saver.finish();
   status(r.cancelled?'Сохранение отменено. Исходная модель не изменена.':'✓ Сохранён новый файл: '+name);
 }catch(e){await saver.abort().catch(()=>{});throw e}
}

async function preparePreview(){
 if(!state.root||state.busy)return;
 discardPreview();
 state.busy=true;buttons();progress(5);
 let loaded=null;
 try{
   // On Android, avoid re-exporting texture payloads when source is already GLB.
   const source=state.sourceBuffer||
     await new GLTFExporter().parseAsync(state.root,{
       binary:true,trs:true,onlyVisible:false,animations:state.clips,
       includeCustomExtensions:false
     });
   const preset=MOBILE_PRESETS[$('preset').value]||MOBILE_PRESETS.balanced;
   const value=$('geometry').value;
   const ratio=value==='none'?1:Number(value)||preset.ratio;
   const optimized=await optimizeGlb(source,{
     texture:Number($('texture').value),ratio,error:preset.error,
     geometry:ratio<1,
     onProgress:(percent,message)=>{progress(percent);status(message)}
   });
   const parsed=inspectGlb(optimized.bytes);
   assertGlbPreserved(modelStats(state.root,state.clips),parsed,state.clips);
   status('Подготавливаем 3D-предпросмотр…');
   progress(93);
   const b=optimized.bytes;
   const ab=b.byteOffset===0&&b.byteLength===b.buffer.byteLength
      ?b.buffer:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
   loaded=(await new GLTFLoader().parseAsync(ab,'')).scene;
   loaded.visible=false;scene.add(loaded);
   state.previewRoot=loaded;state.preview=optimized;
   loaded=null;
   $('preview-switch').hidden=false;$('view-label').hidden=false;
   displayComparison(optimized);
   showComparison(true);
   progress(100);
   status('✓ Предпросмотр готов. Сравни результат и сохрани нужное качество.');
 }catch(error){
   if(loaded){scene.remove(loaded);release(loaded)}
   console.error('Preview',error);
   discardPreview();
   status('Ошибка предпросмотра: '+(error?.message||error));
 }finally{
   state.busy=false;buttons();
   setTimeout(()=>progress(0),1000);
 }
}

async function savePreview(){
 if(!state.preview||state.busy)return;
 state.busy=true;buttons();
 try{
   const name=state.name+'_android_'+$('texture').value+'px.glb';
   await save(state.preview.bytes,name,'model/gltf-binary');
 }catch(error){
   console.error('Save preview',error);
   status('Ошибка сохранения: '+(error?.message||error));
 }finally{state.busy=false;buttons();setTimeout(()=>progress(0),1000)}
}

async function exportAs(target){
 if(!state.root||state.busy)return;
 state.busy=true;buttons();progress(3);
 try{
   const current=modelStats(state.root,state.clips);
   if(target==='glb'){
     if(state.type==='glb'&&state.sourceBuffer){
       // A GLB-to-GLB conversion is not needed: re-exporting an already
       // optimized file with Three.js can rewrite texture payloads, change
       // material extensions, or inflate the binary. The exact original
       // bytes are retained, including UV transforms and quantization.
       const original=state.sourceBuffer;
       const result=inspectGlb(original);
       if(result.meshes<1)throw Error('GLB не содержит геометрии');
       status('GLB уже готов: сохраняем исходные данные без повторного кодирования.');
       progress(70);
       await save(original,state.name+'_copy.glb','model/gltf-binary');
     }else{
       status('Конвертируем FBX → GLB 2.0...');
       const file=await new GLTFExporter().parseAsync(state.root,{
         binary:true,trs:true,onlyVisible:false,animations:state.clips,
         maxTextureSize:4096,includeCustomExtensions:false
       });
       const result=inspectGlb(file);
       assertGlbPreserved(current,result,state.clips);
       progress(70);
       await save(file,state.name+'_converted.glb','model/gltf-binary');
     }
   }else if(['gltf','obj','ply','ply-lite','stl','usdz'].includes(target)){
     const messages=getExportWarnings(target,current);
     if(messages.length&&!window.confirm(
        target.toUpperCase()+' может потерять данные:\n• '+messages.join('\n• ')+
        '\n\nПродолжить экспорт статичной модели?'))return;
     status('Готовим '+target.toUpperCase()+'…');
     const file=await exportAdditional(target,state.root,state.clips,{name:state.name});
     const content=file.content;
     if(!content||(typeof content==='string'&&!content.length))throw Error('Экспорт создал пустой файл');
     progress(70);
     await save(content,state.name+'_converted'+outputNameExt(target),file.mime);
   }else{
     const version=Number(target);
     if(![7300,7400,7500].includes(version))
       throw Error('Этот FBX нельзя достоверно экспортировать в текущем движке');
     const mixamo=version===7300;
     if(mixamo && current.skinned>0){
       if(!window.confirm('Модель уже содержит скелет. Mixamo может принять его для анимаций, '+
         'но для автоматического создания нового скелета обычно нужна модель без рига. '+
         'Экспортировать FBX '+version+' с существующими костями?'))return;
     }
     status((mixamo?'Готовим старый FBX для Mixamo ':'Создаём FBX ')+version+'…');
     const {FBXExporter}=await import('@comfyorg/fbx-exporter-three');
     let file,details='';
     if(mixamo){
       const {exportMixamoDiffuse}=await import('./mixamo-diffuse.js');
       const output=await exportMixamoDiffuse(state.root,state.clips,version,FBXExporter,
         {maxTextureSize:2048});
       file=output.bytes;
       details=output.flatMeshHierarchy
         ?' Без пустых узлов скелета. Встроено цветных PNG: '+output.manifest.embeddedPNG+'.'
         :' Сохранена существующая иерархия скелета.';
     }else{
       file=await new FBXExporter().parseAsync(state.root,{
         version,preset:'blender',fps:30,
         animations:state.clips,embedTextures:true,onlyVisible:false
       });
     }
     const checked=inspectFbx(file);
     if(checked.version!==version||!checked.binary)
       throw Error('Экспортёр выдал неверный формат FBX: '+checked.label);
     if(mixamo){
       const {verifyLegacyFbxMetadata}=await import('./legacy-fbx.js');
       verifyLegacyFbxMetadata(file,version);
     }
     progress(70);
     await save(file,state.name+(mixamo?'_mixamo_clean_':'_fbx')+version+'.fbx',
       'application/vnd.autodesk.fbx');
     if(details)status('✓ FBX '+version+' сохранён.'+details+
       ' Android может показывать тип «BIN» — содержимое остаётся FBX.');
   }
 }catch(error){console.error(error);status('Ошибка экспорта: '+(error.message||String(error)))}
 finally{state.busy=false;buttons();setTimeout(()=>progress(0),1000)}
}
$('model-file').addEventListener('change',e=>{
 const files=Array.from(e.target.files||[]);
 e.target.value='';
 try{const file=validateImportFiles(files);load(file,files)}
 catch(error){status('Ошибка выбора файла: '+error.message)}
});
function changeQuality(id){
 if(state.busy)return;
 const preset=MOBILE_PRESETS[id]||MOBILE_PRESETS.balanced;
 $('preset').value=id;
 $('texture').value=String(preset.texture);
 $('geometry').value=id==='original'?'none':String(preset.ratio);
 document.querySelectorAll('[data-quality]').forEach(b=>{
   const active=b.dataset.quality===id;
   b.classList.toggle('active',active);
   b.setAttribute('aria-pressed',String(active));
 });
 discardPreview();
 status('Качество выбрано. Нажми «Создать предпросмотр».');
}
document.querySelectorAll('[data-quality]').forEach(b=>
 b.addEventListener('click',()=>changeQuality(b.dataset.quality)));
for(const id of ['texture','geometry'])$(id).addEventListener('change',()=>{
 if(state.busy)return;
 discardPreview();status('Настройки изменены. Создай предпросмотр заново.');
});
$('view-original').addEventListener('click',()=>showComparison(false));
$('view-optimized').addEventListener('click',()=>showComparison(true));
$('preview-opt').addEventListener('click',preparePreview);
$('opt-export').addEventListener('click',savePreview);
function updateExportWarnings(){
 const target=$('target').value;
 const version=Number(target);
 $('mixamo-notice').hidden=!(version===7300);
 const warnings=state.root?getExportWarnings(target,modelStats(state.root,state.clips)):[];
 $('export-warning').hidden=!warnings.length;
 $('export-warning').textContent=warnings.length?'Важно: '+warnings.join('; ')+'.':'';
}
$('target').addEventListener('change',updateExportWarnings);
$('convert-export').addEventListener('click',()=>exportAs($('target').value));
for(const button of document.querySelectorAll('[data-tab]'))button.addEventListener('click',()=>{
 for(const b of document.querySelectorAll('[data-tab]'))b.classList.toggle('active',b===button);
 for(const panel of document.querySelectorAll('.tab-panel'))panel.classList.toggle('hidden',panel.id!=='tab-'+button.dataset.tab);
});
new ResizeObserver(()=>{
 const area=$('viewport');if(area.clientWidth<5||area.clientHeight<5)return;
 renderer.setSize(area.clientWidth,area.clientHeight,false);
 camera.aspect=area.clientWidth/area.clientHeight;camera.updateProjectionMatrix();
}).observe($('viewport'));
function tick(){requestAnimationFrame(tick);orbit.update();renderer.render(scene,camera)}tick();buttons();

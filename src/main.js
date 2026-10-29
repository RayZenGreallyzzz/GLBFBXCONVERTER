import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {Capacitor,registerPlugin} from '@capacitor/core';
import {inspectGlb,inspectFbx,modelStats,assertGlbPreserved} from './format.js';
import { optimizeGlb, MOBILE_PRESETS, formatSize } from './glb-optimize.js';
import { inspectVrm } from './vrm-safe.js';
import {makeVrm1} from './vrm-export.js';
import {inspectVRChatAvatar,assertVRChatReady} from './vrchat-preflight.js';
import {extractModelZip} from './model-archive.js';
import {parseBvhForRetarget,suggestBoneMappings,isRiggedCharacter,characterBones}
 from './animation-retarget.js';
import {autoAdaptBvhClip,estimateRigScale,detectCmuCalibration} from './bvh-auto-adapt.js';
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
const state={root:null,clips:[],name:'model',bytes:0,type:'',sourceBuffer:null,busy:false,info:'',preview:null,previewRoot:null,bvhOnly:false,mixer:null};
const motion={source:null,rows:[],preview:null,extras:[],pose:null};
function status(t){$('status').textContent=t}
function progress(n){$('progress').style.width=n+'%'}
function buttons(){
 const ready=!!state.root&&!state.busy;
 const hasMesh=ready&&!state.bvhOnly;
 $('preview-opt').disabled=!hasMesh;
 $('opt-export').disabled=!ready||!state.preview;
 $('convert-export').disabled=!hasMesh;
 const rig=ready&&!state.bvhOnly&&isRiggedCharacter(state.root);
 $('anim-bvh-file').disabled=!rig;
 $('anim-preview').disabled=!rig||!motion.source;
 $('anim-stop').disabled=!rig||!state.mixer;
 $('anim-add').disabled=!rig||!motion.preview;
 $('anim-export').disabled=!rig||!motion.extras.length;
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
 const m=modelStats(state.root,state.clips);
 $('opt-geometry').disabled=false;
 $('opt-animation').disabled=m.animations===0;
 if(m.animations===0)$('opt-animation').checked=false;
 $('selective-note').textContent=m.skinned>0
   ?'Скелет найден: доступно осторожное упрощение с защитой UV, суставов и весов. Перед сохранением сравни движения рук и ног. Исходник не перезаписывается.'
   :'Включай только те части, которые хочешь обработать. При отсутствии улучшений исходный GLB остаётся неизменным.';
 const metrics=[['Размер',(state.bytes/1048576).toFixed(1)+' МБ'],['Меши',m.meshes],['Полигоны',m.triangles],['Вершины',m.vertices],['Материалы',m.materials],['Текстуры',m.textures],['Кости',m.bones],['Анимации',m.animations]];
 $('metrics').replaceChildren();
 for(const [label,value] of metrics){const row=document.createElement('div');row.className='metric';const l=document.createElement('span');l.textContent=label;const n=document.createElement('strong');n.textContent=value;row.append(l,n);$('metrics').append(row)}
 $('compat').textContent=state.info+'\n'+
   (m.skinned?'Есть привязка к скелету; проверь анимацию в Godot.':'Скелет отсутствует либо не привязан.')+
   '\nПоддерживаемые входные форматы: '+SUPPORTED_INPUTS.map(x=>x.toUpperCase()).join(', ')+
   '\nUSD/USDC и создание нового VRM из GLB пока не поддерживаются. VRM-источник можно сохранить без изменений.';
}
async function load(file,attachments=[file]){
 if(!file||state.busy)return;
 if(file.size>250*1048576){status('Большой файл: больше 250 МБ. Отмена для защиты памяти Android.');return}
 state.busy=true;buttons();progress(10);status('Читаем и проверяем модель…');
 let root=null;
 try{
   let source=file,attached=attachments;
   let ext=file.name.split('.').at(-1).toLowerCase(),data=await file.arrayBuffer();progress(35);
   if(ext==='zip'){
     const archive=extractModelZip(data);
     source=archive.file;attached=archive.files;
     ext=archive.format;data=await source.arrayBuffer();
     status('ZIP распакован: '+archive.entryCount+' ресурсов. Основной файл: '+source.name);
   }
   let clips=[],info='';
   if(ext==='glb'){
     const check=inspectGlb(data),loaded=await new GLTFLoader().parseAsync(data,'');
     root=loaded.scene;clips=loaded.animations||[];
     info='GLB 2.0. Мешей: '+check.meshes+'. Анимаций: '+check.animations+'. Доп. расширения: '+(check.required.join(', ')||'нет')+'.';
   }else if(ext==='fbx'){
     const check=inspectFbx(data);root=new FBXLoader().parse(data,'');clips=root.animations||[];
     info=check.label+'. FBX может импортироваться не полностью: проверь материалы и движения.';
   }else if(['gltf','vrm','obj','ply','stl','dae','usdz','3mf','bvh'].includes(ext)){
     const result=await importAdditional(source,data,attached);
     root=result.root;clips=result.clips||[];info=result.notice;
   }else throw Error('Неизвестный входной формат: '+ext);
   if(!root)throw Error('Модель не найдена');
   stopMotionPlayback();
   resetMotionStudio();
   discardPreview();
   if(state.mixer){state.mixer.stopAllAction();state.mixer.uncacheRoot(state.root);state.mixer=null;}
   if(state.root){scene.remove(state.root);release(state.root)}
   scene.add(root);state.root=root;state.clips=clips;
   state.bvhOnly=ext==='bvh';
   if(state.bvhOnly && clips.length){
     state.mixer=new THREE.AnimationMixer(root);
     state.mixer.clipAction(clips[0]).play();
   }
   state.name=source.name.replace(/\.[^.]+$/,'').replace(/[^\p{L}\p{N}_ -]/gu,'_').slice(0,55);
   state.bytes=source.size;state.type=ext;state.sourceBuffer=['glb','vrm'].includes(ext)?data:null;state.info=info;
   updateExportWarnings();
   $('filename').textContent=file.name+(source!==file?' → '+source.name:'');$('empty').style.display='none';fit();display();progress(100);status('✓ Загружено, можно экспортировать');
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
   const useGeometry=$('opt-geometry').checked&&!$('opt-geometry').disabled;
   const useTextures=$('opt-textures').checked;
   const useAnimation=$('opt-animation').checked&&!$('opt-animation').disabled;
   if(!useGeometry&&!useTextures&&!useAnimation)
     throw Error('Выбери, что оптимизировать: сетку, текстуры или анимационные ключи.');
   const optimized=await optimizeGlb(source,{
     texture:Number($('texture').value),ratio,error:preset.error,
     geometry:useGeometry, textures:useTextures,animationKeys:useAnimation,
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
   status(optimized.unchanged
     ?'Новых улучшений не найдено — исходный GLB оставлен без изменений.'
     :'✓ Предпросмотр готов. Сравни результат и сохрани нужное качество.');
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
   }else if(target==='vrchat-fbx'){
     const report=inspectVRChatAvatar(state.root,current);
     assertVRChatReady(report);
     if(report.pcHeavy&&!window.confirm(
       'VRChat PC: '+current.triangles.toLocaleString('ru-RU')+
       ' треугольников — рейтинг Very Poor. Android/Quest требует гораздо более лёгкую версию. '+
       'Экспортировать исходную высокополигональную модель без изменения качества?'))return;
     status('Готовим FBX для импорта в Unity / VRChat…');
     const {FBXExporter}=await import('@comfyorg/fbx-exporter-three');
     const file=await new FBXExporter().parseAsync(state.root,{
       version:7500,preset:'blender',fps:30,animations:state.clips,
       embedTextures:true,onlyVisible:false
     });
     const info=inspectFbx(file);
     if(!info.binary||info.version!==7500)
       throw Error('VRChat: FBX-экспортёр создал неверный формат');
     progress(70);
     await save(file,state.name+'_VRChat_Unity.fbx','application/vnd.autodesk.fbx');
   }else if(target==='vrm'){
     if(!window.confirm('Создать VRM 1.0 из гуманоидной модели? Для VRM требуются обязательные кости; анимации сохраняй отдельно в GLB.'))return;
     status('Проверяем гуманоидные кости и создаём VRM 1.0…');
     const glb=await new GLTFExporter().parseAsync(state.root,{
       binary:true,trs:true,onlyVisible:false,animations:[],maxTextureSize:4096,
       includeCustomExtensions:false
     });
     const avatar=makeVrm1(glb,{name:state.name,author:$('vrm-author').value});
     progress(70);
     await save(avatar,state.name+'_avatar_vrm1.vrm','model/gltf-binary');
   }else if(target==='vrm-source'){
     if(state.type!=='vrm'||!state.sourceBuffer)
       throw Error('Точная VRM-копия доступна только для исходного файла .vrm. GLB требует настройки VRM Humanoid.');
     const checked=inspectVrm(state.sourceBuffer);
     status('Сохраняем '+checked.vrmVersion+' без изменения выражений, физики, рига и метаданных…');
     await save(state.sourceBuffer,state.name+'_original.vrm','model/gltf-binary');
   }else if(['gltf','obj','obj-mixamo','ply','ply-lite','stl','usdz','3mf'].includes(target)){
     const messages=getExportWarnings(target,current);
     if(messages.length&&!window.confirm(
        target.toUpperCase()+' может потерять данные:\n• '+messages.join('\n• ')+
        '\n\nПродолжить экспорт статичной модели?'))return;
     const mixamoObj=target==='obj-mixamo';
     const useOptimized=mixamoObj&&$('mixamo-obj-source').value==='preview';
     if(useOptimized&&!state.previewRoot)throw Error(
       'Сначала создай предпросмотр на вкладке «Оптимизация» или выбери исходную сетку.');
     const exportRoot=useOptimized?state.previewRoot:state.root;
     const triangles=mixamoObj?modelStats(exportRoot,[]).triangles:0;
     if(mixamoObj&&triangles>350000&&!window.confirm(
       'В выбранной сетке '+triangles.toLocaleString('ru-RU')+
       ' треугольников. OBJ ZIP может получиться большим, а Mixamo не всегда обрабатывает тяжёлые модели.'+
       '\\n\\nПродолжить сохранение без упрощения?'))return;
     status(mixamoObj?'Готовим OBJ ZIP для Mixamo'+
       (useOptimized?' из предпросмотра':' из исходной модели')+'…':
       'Готовим '+target.toUpperCase()+'…');
     if(target==='3mf'&&current.triangles>650000)status(
       '3MF: высокая детализация ('+current.triangles.toLocaleString('ru-RU')+
       ' треугольников). Пишем ZIP частями, без уменьшения сетки…');
     const file=await exportAdditional(target,exportRoot,state.clips,{
       name:state.name,
       mixamoTextureSize:mixamoObj?Number($('mixamo-obj-texture').value):undefined,
       printTextureSize:target==='3mf'?Number($('print-texture').value):undefined,
       printUnitScale:target==='3mf'?Number($('print-scale').value):undefined,
       printProgress:target==='3mf'?(percent)=>{
         progress(Math.min(65,Math.round(percent*.65)));
         status('3MF: подготовка ZIP '+percent+'% · треугольников: '+
           current.triangles.toLocaleString('ru-RU'));
       }:undefined
     });
     const content=file.content;
     if(!content||(typeof content==='string'&&!content.length))throw Error('Экспорт создал пустой файл');
     progress(70);
     await save(content,state.name+
       (target==='obj-mixamo'?'_mixamo':'_converted')+
       outputNameExt(target),file.mime);
     if(mixamoObj && file.largeForMixamo)
       status('ZIP создан ('+formatSize(content.byteLength)+
         '). Размер большой: если Mixamo не примет архив, попробуй более лёгкую сетку.');
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
function motionStatus(message){$('anim-status').textContent=message}
function stopMotionPlayback(){
 if(state.mixer){
   state.mixer.stopAllAction();
   if(state.root)state.mixer.uncacheRoot(state.root);
   state.mixer=null;
 }
 if(motion.pose){
   for(const [bone,pose] of motion.pose){
     bone.position.copy(pose.position);bone.quaternion.copy(pose.quaternion);
     bone.scale.copy(pose.scale);
   }
   state.root?.updateMatrixWorld(true);
   motion.pose=null;
 }
 buttons();
}
function resetMotionStudio(){
 motion.source=null;motion.rows=[];motion.preview=null;motion.extras=[];motion.pose=null;
 $('anim-map').replaceChildren();
 $('anim-map').textContent='Загрузи BVH для списка костей.';
 $('anim-library').textContent='Дополнительных анимаций пока нет.';
 motionStatus('Загрузи персонажа со скелетом, затем BVH для переноса.');
 buttons();
}
function readMotionMapping(){
 return motion.rows.map(row=>({
   source:row.source,
   target:row.select.value
 }));
}
function renderMotionMapping(data){
 const list=$('anim-map');list.replaceChildren();
 const explanation=document.createElement('p');
 explanation.className='tip';
 explanation.textContent='Автоматически найдено '+data.matched+' из '+data.total+
   ' костей. Неизвестные кости оставлены пустыми. Исправь назначения до предпросмотра.';
 list.append(explanation);
 motion.rows=[];
 for(const match of data.mappings){
   const line=document.createElement('label');
   line.className='bone-mapping-row';
   const label=document.createElement('span');label.textContent=match.source;
   const select=document.createElement('select');
   const none=document.createElement('option');none.value='';none.textContent='— Пропустить —';
   select.append(none);
   for(const name of data.targets){
     const option=document.createElement('option');option.value=name;option.textContent=name;
     select.append(option);
   }
   select.value=match.target;
   select.addEventListener('change',()=>{
     stopMotionPlayback();motion.preview=null;buttons();
     motionStatus('Соответствия костей изменены. Запусти предпросмотр заново.');
   });
   line.append(label,select);list.append(line);
   motion.rows.push({source:match.source,select});
 }
}
$('anim-bvh-file').addEventListener('change',async e=>{
 const file=e.target.files?.[0];e.target.value='';
 if(!file||state.busy)return;
 if(!state.root||!isRiggedCharacter(state.root)){
   motionStatus('Для переноса BVH сначала загрузи GLB/FBX/VRM со скелетом.');return;
 }
 state.busy=true;buttons();
 try{
   if(file.size>20*1048576)throw Error('BVH больше 20 МБ');
   const source=parseBvhForRetarget(await file.text(),file.name.replace(/\.bvh$/i,''));
   const mapping=suggestBoneMappings(source.skeleton,state.root);
   if(mapping.total>200)throw Error('BVH содержит больше 200 костей');
   stopMotionPlayback();
   motion.source=source;motion.preview=null;
   $('anim-clip-name').value=source.clip.name;
   $('anim-trim-calibration').checked=detectCmuCalibration(source.skeleton,source.clip);
   renderMotionMapping(mapping);
   const sizing=estimateRigScale(source.skeleton,state.root);
   motionStatus('BVH загружен: '+source.skeleton.bones.length+' костей, '+
     source.clip.duration.toFixed(2)+' сек. Найдено '+mapping.matched+' из '+mapping.total+
     ' соответствий. '+(sizing.measured?'Масштаб перемещения ≈ '+sizing.ratio.toFixed(4)+'×. ':'')+
     ($('anim-trim-calibration').checked?'CMU T-поза распознана; первый кадр будет исключён.':'Проверь, есть ли в первом кадре отдельная T-поза.'));
 }catch(err){motionStatus('Ошибка BVH: '+(err.message||err))}
 finally{state.busy=false;buttons()}
});
function previewMotion(){
 if(!motion.source||!state.root||state.busy)return;
 try{
   stopMotionPlayback();
   const mapping=readMotionMapping();
   const newClip=autoAdaptBvhClip({
     targetRoot:state.root,
     sourceSkeleton:motion.source.skeleton,sourceClip:motion.source.clip,
     mappings:mapping,name:$('anim-clip-name').value,
     rootMotion:$('anim-root-motion').checked,
     scale:Number($('anim-root-scale').value),
     autoScale:$('anim-auto-scale').checked,
     alignAxes:$('anim-align-axes').checked,
     trimCalibration:$('anim-trim-calibration').checked
   });
   const mapped=mapping.filter(row=>row.target).length;
   if(mapped<Math.min(5,mapping.length)&&
     !window.confirm('Сопоставлено только '+mapped+' костей. Предпросмотр может быть неполным. Продолжить?'))return;
   motion.pose=new Map(characterBones(state.root).map(b=>[b,{
     position:b.position.clone(),quaternion:b.quaternion.clone(),scale:b.scale.clone()
   }]));
   state.mixer=new THREE.AnimationMixer(state.root);
   state.mixer.clipAction(newClip).play();
   motion.preview=newClip;
   motionStatus('▶ '+newClip.name+': '+mapped+' костей, '+newClip.tracks.length+
     ' дорожек. '+(newClip.userData.calibrationFrameRemoved?'Калибровочная T-поза пропущена. ':'')+
     (newClip.userData.autoScaleMeasured?'Масштаб Hips '+newClip.userData.autoScaleRatio.toFixed(4)+'×. ':'')+
     'Проверь плечи, колени, одежду и направление движения.');
 }catch(e){stopMotionPlayback();motion.preview=null;motionStatus('Ошибка переноса: '+(e.message||e))}
 buttons();
}
for(const id of ['anim-clip-name','anim-root-motion','anim-root-scale','anim-auto-scale','anim-align-axes','anim-trim-calibration']){
 $(id).addEventListener('change',()=>{
   stopMotionPlayback();motion.preview=null;buttons();
   motionStatus('Настройки изменены. Нажми «Адаптировать и посмотреть» для пересчёта.');
 });
}
$('anim-preview').addEventListener('click',previewMotion);
$('anim-stop').addEventListener('click',()=>{
 stopMotionPlayback();motionStatus('Воспроизведение остановлено, исходная поза восстановлена.');
});
$('anim-add').addEventListener('click',()=>{
 if(!motion.preview)return;
 const existing=new Set([...state.clips,...motion.extras].map(x=>x.name));
 if(existing.has(motion.preview.name)){
   motionStatus('Анимация с названием '+motion.preview.name+' уже есть. Переименуй её перед добавлением.');return;
 }
 motion.extras.push(motion.preview.clone());
 motionStatus('Добавлено в набор: '+motion.preview.name+'. Можно загрузить следующий BVH.');
 $('anim-library').textContent='Добавленные движения ('+motion.extras.length+'): '+
   motion.extras.map(clip=>clip.name).join(', ');
 buttons();
});
$('anim-export').addEventListener('click',async()=>{
 if(!state.root||!isRiggedCharacter(state.root)||!motion.extras.length||state.busy)return;
 if(state.type==='vrm'&&!window.confirm(
   'Экспорт VRM в обычный GLB может потерять VRM-мимику и специальные настройки. '+
   'Исходный VRM останется без изменений. Продолжить?'))return;
 stopMotionPlayback();
 state.busy=true;buttons();progress(10);
 try{
   const clips=[...state.clips,...motion.extras];
   motionStatus('Сохраняем персонажа с '+clips.length+' анимациями…');
   const content=await new GLTFExporter().parseAsync(state.root,{
     binary:true,trs:true,onlyVisible:false,animations:clips,
     maxTextureSize:4096,includeCustomExtensions:false
   });
   const checked=inspectGlb(content);
   assertGlbPreserved({...modelStats(state.root,state.clips),animations:clips.length},checked,clips);
   if(checked.animations!==clips.length)
     throw Error('Часть анимаций не была сохранена');
   progress(70);
   await save(content,state.name+'_with_bvh_animations.glb','model/gltf-binary');
   motionStatus('✓ GLB сохранён: '+clips.length+' анимаций, '+checked.skins+' скелетов. '+
     'Проверь движения в Godot — корректность A/T-поз зависит от исходного BVH.');
 }catch(e){motionStatus('Ошибка экспорта BVH: '+(e.message||e))}
 finally{state.busy=false;buttons();setTimeout(()=>progress(0),1000)}
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
for(const id of ['texture','geometry','opt-geometry','opt-textures','opt-animation'])
 $(id).addEventListener('change',()=>{
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
 $('mixamo-obj-quality').hidden=target!=='obj-mixamo';
 $('vrm-settings').hidden=target!=='vrm';
 $('vrchat-settings').hidden=target!=='vrchat-fbx';
 if(target==='vrchat-fbx'&&state.root){
   const r=inspectVRChatAvatar(state.root,modelStats(state.root,state.clips));
   $('vrchat-readiness').textContent=(r.rigged?'✓ Скелет для Unity найден. ':'Нужен гуманоидный скин. ')+
     (r.issues.join(' ')||'Число треугольников в рекомендованном диапазоне.')+
     ' Далее: FBX → Unity Humanoid → VRChat SDK Avatar Descriptor → проверка PC/Android.';
 }
 $('print-settings').hidden=target!=='3mf';
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
const playbackClock=new THREE.Clock();
function tick(){requestAnimationFrame(tick);if(state.mixer)state.mixer.update(Math.min(playbackClock.getDelta(),.1));else playbackClock.getDelta();orbit.update();renderer.render(scene,camera)}tick();buttons();

// Launcher overlay only; model processing and preview stay intact.
function hideBrandSplash(){
 const el=document.getElementById('brand-splash');
 if(!el)return;
 el.classList.add('brand-splash--hide');
 el.addEventListener('transitionend',()=>el.remove(),{once:true});
 setTimeout(()=>el.remove(),800);
}
if(document.readyState==='complete')setTimeout(hideBrandSplash,1700);
else window.addEventListener('load',()=>setTimeout(hideBrandSplash,1700),{once:true});

import * as THREE from 'three';
import {ModelPlayback} from './model-playback.js';
import {MorphPreview} from './morph-preview.js';
import {GuidedRigUI} from './guided-rig-ui.js';
import {makeRigPreview,makeArmWeightsPreview} from './rig-preview.js';
import {ArmWeightsUI} from './arm-weights-ui.js';
import {SkinEditorUI} from './skin-editor-ui.js';
import {JointCorrectionUI} from './joint-ui.js';
import {makeJointPreview} from './joint-preview.js';
import {withJointFormTracks} from './joint-form-animation.js';
import {appendGlbAnimations} from './glb-add-animations.js';
import {openMotionPack} from './motion-pack.js';
import {loadMotionSource} from './motion-import.js';
import {createMotionVisual,MotionCanvas} from './motion-visual.js';
import {MotionCatalog} from './motion-catalog.js';
import {openEmbeddedMotions} from './embedded-motions.js';
import {matchesMotion,fillMotionCategories,fillMotionFamilies,motionFamily} from './motion-categories.js';
import {inspectMorphJson} from './morph-policy.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {configureGltfCodecs,createModelLoader,createModelExporter} from './gltf-codecs.js';
import {asArrayBuffer} from './binary.js';
import {compressGlbOffThread} from './compression-client.js';
import {bakeGlbOffThread} from './surface-bake-client.js';
import {resolveBakeMemoryBudget} from './bake-memory.js';
import {geometryHistory,geometryPlan,optimizationHistory,geometryTargetNote,markGeometryGlb} from './geometry-policy.js';
import {Capacitor,registerPlugin} from '@capacitor/core';
import {inspectGlb,inspectFbx,modelStats,assertGlbPreserved} from './format.js';
import { optimizeGlb, MOBILE_PRESETS, formatSize } from './glb-optimize.js';
import { inspectVrm } from './vrm-safe.js';
import {makeVrm1} from './vrm-export.js';
import {inspectVRChatAvatar,assertVRChatReady} from './vrchat-preflight.js';
import {extractModelZip} from './model-archive.js';
import {make3mfLightPreview,dispose3mfLightPreview} from './3mf-preview.js';
import {simplify3mfScene,release3mfSimplifiedGeometry} from './3mf-optimize.js';
import {suggestBoneMappings,isRiggedCharacter,characterBones}
 from './animation-retarget.js';
import {autoAdaptBvhClip,estimateRigScale,detectCmuCalibration} from './bvh-auto-adapt.js';
import { importAdditional, exportAdditional, getExportWarnings, outputNameExt,
 SUPPORTED_INPUTS, STATIC_EXPORTS, validateImportFiles } from './model-formats.js';
import './style.css';
const $=id=>document.getElementById(id),saver=registerPlugin('ModelSaver');
const deviceMemory=registerPlugin('DeviceMemory');
const scene=new THREE.Scene();scene.background=new THREE.Color('#0a1423');
scene.add(new THREE.HemisphereLight(0xe6f0ff,0x314256,2.6));
const sunlight=new THREE.DirectionalLight(0xffffff,2.4);sunlight.position.set(5,9,7);scene.add(sunlight);
scene.add(new THREE.GridHelper(12,24,0x367da6,0x20394a));
const camera=new THREE.PerspectiveCamera(45,1,.001,2000);camera.position.set(3,2,5);
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.7));
renderer.outputColorSpace=THREE.SRGBColorSpace;
configureGltfCodecs(renderer);
$('viewport').append(renderer.domElement);
const orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;
const state={root:null,clips:[],name:'model',bytes:0,type:'',sourceBuffer:null,sourceFile:null,busy:false,info:'',preview:null,previewRoot:null,previewClips:[],sourceMetrics:null,previewMetrics:null,viewMode:'original',hasMorphs:false,viewProxyRoot:null,bvhOnly:false,mixer:null,rigLookup:null,jointConfig:null};
const motion={source:null,rows:[],preview:null,extras:[],pose:null,pack:[],bundle:null};
let embeddedMotions=[],importedMotions=[],selectedMotionFamily='humanoid';
const modelPlayback=new ModelPlayback(),morphPreview=new MorphPreview();
let activeBake=null;
let guidedRigUi=null,armWeightsUi=null,skinEditorUi=null,jointUi=null;
let sourceVisual=null,motionCatalog=null;
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
 $('anim-source-file').disabled=!rig||!motion.pack.length;
 $('anim-source-filter').disabled=state.busy||!motion.pack.length;
 $('anim-category').disabled=state.busy||!motion.pack.length;
 $('anim-family').querySelectorAll('button').forEach(button=>button.disabled=state.busy||!motion.pack.length);
 $('anim-library-source').disabled=state.busy;
 $('anim-source-clip').disabled=!rig||!motion.bundle?.clips.length;
 $('anim-browse').disabled=state.busy||!motion.pack.length;
 $('anim-source-visual-toggle').disabled=!rig||!sourceVisual?.data;
 $('anim-trim-calibration').disabled=!rig||motion.source?.kind!=='bvh';
 $('anim-preview').disabled=!rig||!motion.source;
 $('anim-stop').disabled=!rig||!state.mixer;
 $('anim-add').disabled=!rig||!motion.preview;
 $('anim-export').disabled=!rig||!motion.extras.length;
 document.querySelectorAll('[data-quality]').forEach(b=>b.disabled=state.busy);
 $('view-original').disabled=!ready||!state.previewRoot;
 $('view-optimized').disabled=!ready||!state.previewRoot;
 $('cancel-bake').hidden=!activeBake;
 updateGeometryControls();
 updatePlaybackButtons();
 updateMorphButtons();
 guidedRigUi?.refresh();
 armWeightsUi?.refresh();
 skinEditorUi?.refresh();
 jointUi?.refresh();
}
function suspendGpu(root){
 const textures=new Set();
 root.traverse(n=>{if(!n.isMesh)return;n.geometry?.dispose();
  for(const m of Array.isArray(n.material)?n.material:[n.material])if(m)for(const v of Object.values(m))if(v?.isTexture)textures.add(v);
 });
 for(const t of textures)t.dispose();
}
function suspendStaticBakeSource(){
 guidedRigUi?.clearResult();
 modelPlayback.dispose();morphPreview.dispose();
 const geometries=new Set(),images=new Set();
 state.root.traverse(n=>{if(!n.isMesh)return;geometries.add(n.geometry);for(const m of Array.isArray(n.material)?n.material:[n.material])if(m)for(const v of Object.values(m))if(v?.isTexture&&typeof v.image?.close==='function')images.add(v.image)});
 scene.remove(state.root);release(state.root);
 for(const image of images)image.close();
 // This discarded static graph is rebuilt from File. Clear CPU buffers even
 // if renderer bookkeeping briefly retains the old mesh objects.
 for(const geometry of geometries)if(geometry){geometry.attributes={};geometry.setIndex(null);geometry.morphAttributes={}}
 state.root=null;state.sourceBuffer=null;state.rigLookup=null;
 renderer.renderLists.dispose();
}
async function restoreStaticBakeSource(){
 if(state.root)return;
 const data=await state.sourceFile.arrayBuffer(),loaded=await createModelLoader().parseAsync(data,'');
 state.sourceBuffer=data;state.root=loaded.scene;state.clips=loaded.animations||[];state.rigLookup=new WeakMap(loaded.parser.associations);state.root.visible=false;scene.add(state.root);
}
function fit(){
  const bounds=new THREE.Box3().setFromObject(state.root);if(bounds.isEmpty())return;
  const center=bounds.getCenter(new THREE.Vector3()),dist=Math.max(.5,bounds.getSize(new THREE.Vector3()).length());
  orbit.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(.7*dist,.4*dist,1.5*dist));
  camera.near=Math.max(.0001,dist/50000);camera.far=Math.max(200,dist*300);
  camera.updateProjectionMatrix();orbit.update();
}
function release(root,{keepTextures=false}={}){keepTextures=keepTextures||!!root?.userData.phoenixSharedTextures;const skeletons=new Set();root?.traverse(obj=>{if(!obj.isMesh)return;obj.geometry?.dispose();if(obj.skeleton)skeletons.add(obj.skeleton);for(const m of Array.isArray(obj.material)?obj.material:[obj.material])if(m){if(!keepTextures)for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose()}});for(const skeleton of skeletons)skeleton.dispose()}
function showComparison(optimized=false){
 const isPreview=optimized&&!!state.previewRoot;
 state.viewMode=isPreview?'optimized':'original';
 if(state.root)state.root.visible=!isPreview&&!state.viewProxyRoot;
 if(state.viewProxyRoot)state.viewProxyRoot.visible=!isPreview;
 if(state.previewRoot)state.previewRoot.visible=isPreview;
 $('view-original').classList.toggle('active',!isPreview);
 $('view-optimized').classList.toggle('active',isPreview);
 $('view-original').setAttribute('aria-pressed',String(!isPreview));
 $('view-optimized').setAttribute('aria-pressed',String(isPreview));
 $('view-label').textContent=isPreview?(state.preview?.kind==='rig'?'Скелет и веса':state.preview?.kind==='arm-weights'?'Исправленные веса рук':state.preview?.kind==='skin-editor'?'Ручные веса и плечи':state.preview?.kind==='joint-forms'?'Коррекция суставов':'После оптимизации'):'Исходная модель';
 displayMetrics();
}
function clear3mfViewport(){
 if(state.viewProxyRoot){
   scene.remove(state.viewProxyRoot);
   dispose3mfLightPreview(state.viewProxyRoot);
   state.viewProxyRoot=null;
 }
}
function set3mfViewQuality(percent){
 clear3mfViewport();
 const p=Number(percent);
 if(state.type==='3mf'&&state.root&&p<100)
   state.viewProxyRoot=make3mfLightPreview(state.root,p);
 if(state.viewProxyRoot)scene.add(state.viewProxyRoot);
 $('view-quality-picker').hidden=state.type!=='3mf';
 $('view-quality').value=String(p);
 const count=state.viewProxyRoot?.userData;
 $('view-quality-note').textContent=count
   ?'Лёгкий просмотр: '+count.displayFaces.toLocaleString('ru-RU')+
     ' из '+count.sourceFaces.toLocaleString('ru-RU')+
     ' треугольников. Экспорт всегда использует исходную модель.'
   :'Полное качество просмотра. Экспорт не изменяется.';
 showComparison(false);
}
function discardPreview(){
 jointUi?.clear();
 skinEditorUi?.cleanup();
 guidedRigUi?.clearResult();
 armWeightsUi?.clearResult();
 modelPlayback.stop();
 if(state.previewRoot){
   scene.remove(state.previewRoot);release(state.previewRoot);
 }
 state.previewRoot=null;state.preview=null;state.previewClips=[];state.previewMetrics=null;
 refreshModelPlayback();
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
function displayMetrics(){
 const isPreview=state.viewMode==='optimized'&&state.previewRoot&&state.preview;
 const m=isPreview?state.previewMetrics:state.sourceMetrics;
 const title=$('metrics-title');title.hidden=!m;$('metrics').replaceChildren();if(!m)return;
 const variant=isPreview?'optimized':'original',size=isPreview?state.preview.bytes.byteLength:state.bytes;
 title.textContent=isPreview?'Результат оптимизации':'Исходная модель';
 $('metrics').dataset.variant=variant;$('metrics').setAttribute('aria-label',title.textContent);
 const metrics=[['size','Размер',formatSize(size)],['meshes','Меши',m.meshes],['triangles','Полигоны',m.triangles],['vertices','Вершины',m.vertices],['materials','Материалы',m.materials],['textures','Текстуры',m.textures],['bones','Кости',m.bones],['animations','Анимации',m.animations],['morphs','Формы',m.morphs||0]];
 for(const [key,label,value]of metrics){
  const row=document.createElement('div');row.className='metric';row.dataset.metric=key;
  const l=document.createElement('span');l.textContent=label;const n=document.createElement('strong');n.textContent=value;row.append(l,n);$('metrics').append(row);
 }
}
function updatePlaybackButtons(){
 const available=!!state.root&&!state.bvhOnly&&state.clips.length>0;
 $('model-playback').hidden=!available;
 $('model-clip').disabled=!available||state.busy;
 $('model-play').disabled=!available||state.busy;
 $('model-stop').disabled=!available||state.busy||!modelPlayback.active;
 $('model-play').textContent=modelPlayback.playing?'❚❚ Пауза':'▶ Воспроизвести';
 $('model-play').setAttribute('aria-pressed',String(modelPlayback.playing));
 $('model-playback').dataset.state=modelPlayback.playing?'playing':modelPlayback.active?'paused':'stopped';
}
function refreshModelPlayback(){
 modelPlayback.setModels(state.bvhOnly?null:state.root,state.clips,state.previewRoot,state.previewClips);
 refreshMorphControls();
 const picker=$('model-clip'),selected=picker.value;picker.replaceChildren();
 for(let i=0;i<state.clips.length;i++){const option=document.createElement('option');option.value=String(i);option.textContent=state.clips[i].name||'Анимация '+(i+1);picker.append(option)}
 if(Array.from(picker.options).some(o=>o.value===selected))picker.value=selected;
 updatePlaybackButtons();
}
function updateMorphButtons(){
 const has=morphPreview.entries.length>0;$('morph-preview').hidden=!has;
 for(const id of ['morph-select','morph-weight','morph-reset'])$(id).disabled=!has||state.busy||!morphPreview.compatible;
 $('morph-note').textContent=morphPreview.compatible?'Ручная проверка форм останавливает клип. Изменения просмотра не записываются в GLB.':'Для ручной проверки форм сохрани результат и открой его как GLB: структура просмотра исходника и результата отличается.';
}
function updateMorphValue(){
 const [mesh,index]=$('morph-select').value.split(':').map(Number),e=morphPreview.entries[mesh];if(!e)return;
 const value=e.values[index];$('morph-weight').min=String(Math.min(-1,value));$('morph-weight').max=String(Math.max(1,value));$('morph-weight').value=String(value);$('morph-value').textContent=Math.round(value*100)+'%';
}
function refreshMorphControls(){
 morphPreview.setModels(state.root,state.previewRoot);const picker=$('morph-select'),selected=picker.value;picker.replaceChildren();
 for(let mesh=0;mesh<morphPreview.entries.length;mesh++){
  const e=morphPreview.entries[mesh],group=document.createElement('optgroup');group.label=e.node.name||'Меш '+(mesh+1);
  e.names.forEach((name,index)=>{const option=document.createElement('option');option.value=mesh+':'+index;option.textContent=name;group.append(option)});picker.append(group);
 }
 if(Array.from(picker.options).some(o=>o.value===selected))picker.value=selected;updateMorphValue();updateMorphButtons();
}
function display(){
 const m=state.sourceMetrics=modelStats(state.root,state.clips);
 const history=state.sourceBuffer?geometryHistory(inspectGlb(state.sourceBuffer).json.extras):null;
 $('opt-geometry').disabled=!!history;
 if(history)$('opt-geometry').checked=false;
 $('opt-animation').disabled=m.animations===0;
 if(m.animations===0)$('opt-animation').checked=false;
 $('selective-note').textContent=history
   ?'Эта сетка уже упрощена: '+history.sourceTriangles.toLocaleString('ru-RU')+' → '+history.triangles.toLocaleString('ru-RU')+' треугольников. Для другой цели открой исходный GLB. Текстуры и кодеки доступны отдельно.'
   :m.skinned>0
   ?'Скелет найден: доступно осторожное упрощение с защитой UV, суставов и весов. Перед сохранением сравни движения рук и ног. Исходник не перезаписывается.'
   :'Включай только те части, которые хочешь обработать. При отсутствии улучшений исходный GLB остаётся неизменным.';
 updateGeometryControls();
 displayMetrics();
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
   let ext=file.name.split('.').at(-1).toLowerCase();
   // Large 3MF: stream File slices instead of retaining the whole ZIP in RAM.
   let data=ext==='3mf'?null:await file.arrayBuffer();progress(35);
   if(ext==='zip'){
     const archive=extractModelZip(data);
     source=archive.file;attached=archive.files;
     ext=archive.format;data=await source.arrayBuffer();
     status('ZIP распакован: '+archive.entryCount+' ресурсов. Основной файл: '+source.name);
   }
   let clips=[],info='',hasMorphs=false,rigLookup=null,jointConfig=null;
   if(ext==='glb'){
     const check=inspectGlb(data);jointConfig=check.json.extras?.phoenixJointForms||null;hasMorphs=inspectMorphJson(check.json).targets>0;const loaded=await createModelLoader().parseAsync(data,'');
     root=loaded.scene;clips=loaded.animations||[];rigLookup=new WeakMap(loaded.parser.associations);
     info='GLB 2.0. Мешей: '+check.meshes+'. Анимаций: '+check.animations+'. Доп. расширения: '+(check.required.join(', ')||'нет')+'.';
   }else if(ext==='fbx'){
     const check=inspectFbx(data);root=new FBXLoader().parse(data,'');clips=root.animations||[];
     info=check.label+'. FBX может импортироваться не полностью: проверь материалы и движения.';
   }else if(['gltf','vrm','obj','ply','stl','dae','usdz','3mf','bvh'].includes(ext)){
     const result=await importAdditional(source,data,attached,{
       onProgress:percent=>{
         progress(Math.min(95,35+Math.round(percent*.6)));
         status('3MF: открываем геометрию и текстуры '+percent+'%…');
       }
     });
     root=result.root;clips=result.clips||[];info=result.notice;
   }else throw Error('Неизвестный входной формат: '+ext);
   if(!root)throw Error('Модель не найдена');
   stopMotionPlayback();
   resetMotionStudio();
   discardPreview();
   clear3mfViewport();
   if(state.mixer){state.mixer.stopAllAction();state.mixer.uncacheRoot(state.root);state.mixer=null;}
   if(state.root){scene.remove(state.root);release(state.root)}
   scene.add(root);state.root=root;state.clips=clips;state.rigLookup=rigLookup;state.hasMorphs=hasMorphs||modelStats(root,clips).morphs>0;
   state.bvhOnly=ext==='bvh';
   if(state.bvhOnly && clips.length){
     state.mixer=new THREE.AnimationMixer(root);
     state.mixer.clipAction(clips[0]).play();
   }
   state.name=source.name.replace(/\.[^.]+$/,'').replace(/[^\p{L}\p{N}_ -]/gu,'_').slice(0,55);
   state.bytes=source.size;state.type=ext;state.jointConfig=jointConfig;state.sourceBuffer=['glb','vrm'].includes(ext)?data:null;state.sourceFile=ext==='glb'&&source===file?source:null;state.info=info;
   refreshModelPlayback();
   updateExportWarnings();
   const faces=modelStats(state.root).triangles;
   set3mfViewQuality(ext==='3mf'&&faces>350000?25:100);
   $('filename').textContent=file.name+(source!==file?' → '+source.name:'');$('empty').style.display='none';fit();display();progress(100);
   status(ext==='3mf'&&faces>350000
     ?'✓ 3MF загружен. Включён экономный просмотр 25%; экспорт использует все полигоны.'
     :'✓ Загружено, можно экспортировать');
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
 stopMotionPlayback();
 discardPreview();
 state.busy=true;buttons();progress(5);
 let loaded=null,baking=false,suspended=false,sourceStats=null;
 try{
   const preset=MOBILE_PRESETS[$('preset').value]||MOBILE_PRESETS.balanced;
   const value=$('geometry').value;
   const ratio=value==='none'?1:Number(value)||preset.ratio;
   const useGeometry=$('opt-geometry').checked&&!$('opt-geometry').disabled;
   const useTextures=$('opt-textures').checked;
   const useAnimation=$('opt-animation').checked&&!$('opt-animation').disabled;
   const useBake=$('bake-details').checked;
   const targetTriangles=$('geometry-mode').value==='target'?Number($('geometry-target').value):null;
   const geometryError=Number($('geometry-error').value);
   const geometryCodec=$('geometry-codec').value;
   const textureCodec=useTextures?$('texture-codec').value:'keep';
   if(!useGeometry&&!useTextures&&!useAnimation&&geometryCodec==='keep')
     throw Error('Выбери, что оптимизировать: сетку, текстуры или анимационные ключи.');
   let optimized;
   if(useBake){
     if(state.type!=='glb'||!state.sourceBuffer||!useGeometry||!useTextures)throw Error('Для переноса деталей загрузи исходный GLB и включи сетку и текстуры.');
     sourceStats=modelStats(state.root,state.clips);
     const lowMemory=!!state.sourceFile&&sourceStats.triangles>262144&&!sourceStats.skinned&&!sourceStats.bones&&!sourceStats.animations&&!state.hasMorphs;
     baking=true;activeBake=new AbortController();buttons();
     if(lowMemory){suspendStaticBakeSource();suspended=true}else{state.root.visible=false;suspendGpu(state.root)}
     optimized=await bakeGlbOffThread(lowMemory?state.sourceFile:state.sourceBuffer,{
       ratio,targetTriangles,error:geometryError,resolution:Math.min(2048,Number($('texture').value)),
       animationKeys:useAnimation,lowMemory
     },{signal:activeBake.signal,onProgress:(percent,message)=>{progress(percent);status(message)},
       readMemoryBudget:()=>resolveBakeMemoryBudget({android:Capacitor.getPlatform()==='android',deviceMemory:navigator.deviceMemory,readNative:()=>deviceMemory.getInfo()})});
     activeBake=null;buttons();
   }else if(state.type==='3mf'){
     // A 1.94M-face 3MF must not be exported to a full-size GLB, loaded
     // again by glTF-Transform, and then optimized: Android runs out of RAM.
     const stats=modelStats(state.root,state.clips);
     const goal=useGeometry?geometryPlan({sourceTriangles:stats.triangles,ratio,targetTriangles,error:geometryError}):null;
     if(!useGeometry&&stats.triangles>600000)
       throw Error('Для тяжёлого 3MF включи оптимизацию сетки. Прямой экспорт полной модели без упрощения доступен во вкладке «Конвертация».');
     const prepared=await simplify3mfScene(state.root,{
       ratio:goal?.ratio??1,error:geometryError,
       onProgress:(percent,message)=>{progress(percent);status(message)}
     });
     let bytes;
     try{
       progress(72);status('Собираем компактный GLB из упрощённого 3MF…');
       bytes=await createModelExporter().parseAsync(prepared.root,{
         binary:true,trs:true,onlyVisible:false,animations:[],
         maxTextureSize:useTextures?Number($('texture').value):4096,
         includeCustomExtensions:false
       });
     }finally{
       // The compact preview shares the original materials, not geometry.
       release3mfSimplifiedGeometry(prepared.root);
     }
     if(prepared.optimizedTriangles<prepared.sourceTriangles)
       bytes=markGeometryGlb(bytes,optimizationHistory(prepared.sourceTriangles,prepared.optimizedTriangles,goal?.targetTriangles,geometryError));
     optimized={
       bytes,beforeBytes:state.bytes,afterBytes:bytes.byteLength,
       sourceTriangles:prepared.sourceTriangles,
       optimizedTriangles:prepared.optimizedTriangles,
       unchanged:false,
       note:prepared.optimizedTriangles<prepared.sourceTriangles
         ?'Сетка реально упрощена через Meshoptimizer с сохранением UV; оригинал не менялся.'
         :'Упрощение без потери формы не уменьшило число треугольников; сохранён GLB с исходной сеткой.'
     };
     if(goal&&targetTriangles!==null)optimized.note+=' '+geometryTargetNote(goal.targetTriangles,prepared.optimizedTriangles);
   }else{
     // Ordinary GLBs keep the original fast path and byte-for-byte fallback.
     const source=state.sourceBuffer||
       await createModelExporter().parseAsync(state.root,{
         binary:true,trs:true,onlyVisible:false,animations:state.clips,
         includeCustomExtensions:false
       });
     optimized=await optimizeGlb(source,{
       texture:Number($('texture').value),ratio,error:geometryError,targetTriangles,
       geometry:useGeometry, textures:useTextures&&textureCodec==='keep',animationKeys:useAnimation,
       onProgress:(percent,message)=>{progress(percent);status(message)}
     });
   }
   if(geometryCodec!=='keep'||textureCodec!=='keep'){
     const packed=await compressGlbOffThread(optimized.bytes,{geometryCodec,textureCodec,
       maxTextureSize:Number($('texture').value)},(percent,message)=>{
         progress(percent);status(message);
       });
     optimized={...optimized,bytes:packed.bytes,afterBytes:packed.bytes.byteLength,
       unchanged:false,codecSuffix:(optimized.codecSuffix||'')+'_'+[geometryCodec,textureCodec].filter(x=>x!=='keep').join('_'),
       note:(optimized.note||'')+' '+packed.codecNote};
   }
   const parsed=inspectGlb(optimized.bytes);
   if(suspended){await restoreStaticBakeSource();suspended=false}
   assertGlbPreserved(sourceStats||modelStats(state.root,state.clips),parsed,state.clips);
   status('Подготавливаем 3D-предпросмотр…');
   progress(93);
   const ab=asArrayBuffer(optimized.bytes);
   const previewModel=await createModelLoader().parseAsync(ab,'');loaded=previewModel.scene;
   loaded.visible=false;scene.add(loaded);
   state.previewRoot=loaded;state.preview=optimized;state.previewClips=previewModel.animations||[];
   state.previewMetrics=modelStats(loaded,state.previewClips);refreshModelPlayback();
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
   status(error?.name==='AbortError'?error.message:'Ошибка предпросмотра: '+(error?.message||error));
 }finally{
   activeBake=null;
   if(suspended){try{await restoreStaticBakeSource()}catch(e){status('Не удалось вернуть просмотр исходника: '+e.message+'. Открой исходный GLB заново.')}}
   if(baking&&!state.previewRoot)showComparison(false);
   state.busy=false;buttons();
   setTimeout(()=>progress(0),1000);
 }
}

async function savePreview(){
 if(!state.preview||state.busy)return;
 state.busy=true;buttons();
 try{
   const name=state.preview.kind==='rig'?state.name+'_rig.glb':state.preview.kind==='arm-weights'?state.name+'_arms_fixed.glb':state.name+'_android_'+(state.preview.textureLimit||$('texture').value)+'px'+
      (state.preview.codecSuffix||'')+'.glb';
   await save(state.preview.getBytes?.()||state.preview.bytes,state.preview.kind==='skin-editor'?state.name+'_weights.glb':state.preview.kind==='joint-forms'?state.name+'_joints.glb':name,'model/gltf-binary');
 }catch(error){
   console.error('Save preview',error);
   status('Ошибка сохранения: '+(error?.message||error));
 }finally{state.busy=false;buttons();setTimeout(()=>progress(0),1000)}
}

async function exportAs(target){
 if(!state.root||state.busy)return;
 stopMotionPlayback();
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
       const file=await createModelExporter().parseAsync(state.root,{
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
     const glb=await createModelExporter().parseAsync(state.root,{
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
$('view-quality').addEventListener('change',e=>{
 if(!state.root||state.type!=='3mf'||state.busy)return;
 try{
   set3mfViewQuality(Number(e.target.value));
   status(e.target.value==='100'
     ?'Полное качество просмотра: может потребоваться больше видеопамяти.'
     :'Облегчённый просмотр. Исходная геометрия сохранена для экспорта.');
 }catch(error){status('Ошибка настройки просмотра: '+error.message)}
});
$('model-file').addEventListener('change',e=>{
 const files=Array.from(e.target.files||[]);
 e.target.value='';
 try{const file=validateImportFiles(files);load(file,files)}
 catch(error){status('Ошибка выбора файла: '+error.message)}
});
function motionStatus(message){$('anim-status').textContent=message}
function stopMotionPlayback(){
 jointUi?.stopPose();
 guidedRigUi?.stop();
 modelPlayback.stop();morphPreview.reset();updateMorphValue();
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
 motion.extras=[];motion.pose=null;setMotionPack($('anim-library-source').value==='imported'?importedMotions:embeddedMotions);
 $('anim-library').textContent='Дополнительных анимаций пока нет.';
 motionStatus('Выбери раздел и движение из встроенной библиотеки или своих файлов. Для переноса нужен персонаж со скелетом.');
 buttons();
}
function clearMotionSelection(){
 stopMotionPlayback();motion.source=null;motion.bundle=null;motion.preview=null;motion.rows=[];
 sourceVisual?.clear();$('anim-source-visual').hidden=true;$('anim-source-clip').replaceChildren();$('anim-map').textContent='Выбери движение для списка костей.';
}
function setMotionPack(pack){
 clearMotionSelection();motion.pack=pack;
 $('anim-source-filter').value='';fillMotionFamilies($('anim-family'),pack,selectedMotionFamily);fillMotionCategories($('anim-category'),pack.filter(e=>motionFamily(e)===selectedMotionFamily));motionCatalog?.setEntries(pack);renderMotionFiles(-1);buttons();
}
$('anim-family').addEventListener('click',event=>{const family=event.target.closest('button')?.dataset.family;if(state.busy||!family||family===selectedMotionFamily)return;clearMotionSelection();selectedMotionFamily=family;fillMotionFamilies($('anim-family'),motion.pack,family);fillMotionCategories($('anim-category'),motion.pack.filter(e=>motionFamily(e)===family),$('anim-category').value);renderMotionFiles(-1);buttons()});
async function initializeEmbeddedMotions(){
 try{embeddedMotions=await openEmbeddedMotions();$('anim-embedded-status').textContent='Встроено движений: '+embeddedMotions.length+'. Доступны без интернета.';if($('anim-library-source').value==='embedded')setMotionPack(embeddedMotions)}
 catch(error){$('anim-embedded-status').textContent='Встроенная библиотека недоступна: '+error.message+'. Можно открыть свои ZIP и файлы.'}
}
$('anim-library-source').addEventListener('change',()=>{if(state.busy)return;setMotionPack($('anim-library-source').value==='imported'?importedMotions:embeddedMotions);motionStatus('Выбери движение в библиотеке.')});
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
function renderMotionFiles(selected=Number($('anim-source-file').value||-1)){
 const query=$('anim-source-filter').value,category=$('anim-category').value||'all',list=$('anim-source-file');list.replaceChildren();let matches=0,kept=false;
 if(selected<0){const placeholder=document.createElement('option');placeholder.value='-1';placeholder.textContent='Выбери движение';placeholder.disabled=true;list.append(placeholder)}
 motion.pack.forEach((entry,i)=>{const match=matchesMotion(entry,query,category,selectedMotionFamily);if(match)matches++;if(!match&&i!==selected)return;if(!match)kept=true;const option=document.createElement('option');option.value=i;option.textContent=entry.label+(!match?' (выбрано ранее)':'');list.append(option)});
 list.value=String(selected);const familyCount=motion.pack.filter(e=>motionFamily(e)===selectedMotionFamily).length;$('anim-source-count').textContent=(selectedMotionFamily==='monster'?'Монстры':'Гуманоиды')+': найдено '+matches+' из '+familyCount+(kept?'. Текущий файл остаётся в списке.':'.');
}
$('anim-source-filter').addEventListener('input',()=>renderMotionFiles());
$('anim-category').addEventListener('change',()=>renderMotionFiles());
function chooseMotionClip(index){
 if(!motion.bundle?.clips[index])return;
 $('anim-source-clip').value=String(index);
 stopMotionPlayback();motion.source={...motion.bundle,clip:motion.bundle.clips[index]};motion.preview=null;
 const source=motion.source,mapping=suggestBoneMappings(source.skeleton,state.root),path=motion.pack[Number($('anim-source-file').value)]?.path||'Motion',fileName=path.replace(/^.*\//,'').replace(/\.[^.]+$/,'');
 const base=source.kind==='bvh'?source.clip.name:source.clips.length>1?fileName+'_'+source.clip.name:fileName;
 const safeBase=base.replace(/[^\p{L}\p{N}_ -]/gu,'_').slice(0,54)||'Motion',used=new Set([...state.clips,...motion.extras].map(c=>c.name));let title=safeBase,suffix=2;while(used.has(title))title=safeBase+'_'+suffix++;
 $('anim-clip-name').value=title;$('anim-trim-calibration').checked=source.kind==='bvh'&&detectCmuCalibration(source.skeleton,source.clip);
 try{const entryIndex=Number($('anim-source-file').value),data=index===0?motionCatalog?.cached(entryIndex)?.data:null,visual=data||createMotionVisual(source);sourceVisual.set(visual);if(index===0)motionCatalog?.remember(entryIndex,visual);$('anim-source-visual').hidden=false;$('anim-source-visual-caption').textContent='Схема источника: '+visual.name+' · '+visual.fullDuration.toFixed(2)+' с'+(visual.fullDuration>visual.duration+.01?' · первые '+visual.duration.toFixed(0)+' с':'');$('anim-source-visual-toggle').textContent='Ⅱ Пауза схемы';$('anim-source-visual-toggle').setAttribute('aria-pressed','true')}catch(error){sourceVisual.clear();$('anim-source-visual').hidden=false;$('anim-source-visual-caption').textContent='Миниатюра недоступна: '+error.message}
 renderMotionMapping(mapping);const sizing=estimateRigScale(source.skeleton,state.root);
 motionStatus(source.kind.toUpperCase()+': «'+source.clip.name+'», '+source.clip.duration.toFixed(2)+' сек. Найдено '+mapping.matched+' из '+mapping.total+' соответствий. '+(source.kind==='bvh'&&sizing.measured?'Масштаб перемещения ≈ '+sizing.ratio.toFixed(4)+'×. ':'')+($('anim-trim-calibration').checked?'CMU T-поза распознана; первый кадр будет исключён. ':'')+(source.warnings||[]).join(' '));buttons();
}
async function chooseMotionFile(index){
 if(state.busy||!motion.pack[index])return;stopMotionPlayback();state.busy=true;sourceVisual.clear();$('anim-source-visual').hidden=true;motion.source=null;motion.bundle=null;motion.preview=null;motion.rows=[];$('anim-map').textContent='Читаем выбранный источник…';$('anim-source-clip').replaceChildren();buttons();
 try{motionStatus('Открываем '+motion.pack[index].label+'…');const memoryBudgetMiB=await resolveBakeMemoryBudget({android:Capacitor.getPlatform()==='android',deviceMemory:navigator.deviceMemory,readNative:()=>deviceMemory.getInfo()});motion.bundle=await loadMotionSource(motion.pack[index],{memoryBudgetMiB});
  motion.bundle.clips.forEach((clip,i)=>{const option=document.createElement('option');option.value=i;option.textContent=clip.name+' · '+clip.duration.toFixed(2)+' сек';$('anim-source-clip').append(option)});chooseMotionClip(0);
 }catch(error){motionStatus('Ошибка источника: '+error.message);$('anim-map').textContent='Выбери другой файл в пакете.'}
 finally{state.busy=false;buttons()}
}
$('anim-source-file').addEventListener('change',()=>{const index=Number($('anim-source-file').value);renderMotionFiles(index);chooseMotionFile(index)});
$('anim-source-clip').addEventListener('change',()=>{if(!state.busy)chooseMotionClip(Number($('anim-source-clip').value))});
$('anim-bvh-file').addEventListener('change',async e=>{
 const files=Array.from(e.target.files||[]);e.target.value='';
 if(!files.length||state.busy)return;
 if(!state.root||!isRiggedCharacter(state.root)){
   motionStatus('Для переноса сначала загрузи GLB/FBX/VRM со скелетом.');return;
 }
 state.busy=true;buttons();
 try{
   importedMotions=await openMotionPack(files);selectedMotionFamily=motionFamily(importedMotions[0]);$('anim-library-source').querySelector('[value="imported"]').disabled=false;$('anim-library-source').value='imported';setMotionPack(importedMotions);renderMotionFiles(0);
   state.busy=false;await chooseMotionFile(0);
 }catch(err){motionStatus('Ошибка пакета анимаций: '+(err.message||err))}
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
     trimCalibration:$('anim-trim-calibration').checked,
     referencePose:motion.source.kind==='bvh'?'first-frame':'rest'
   });
   const mapped=mapping.filter(row=>row.target).length;
   if(mapped<Math.min(5,mapping.length)&&
     !window.confirm('Сопоставлено только '+mapped+' костей. Предпросмотр может быть неполным. Продолжить?'))return;
   motion.pose=new Map(characterBones(state.root).map(b=>[b,{
     position:b.position.clone(),quaternion:b.quaternion.clone(),scale:b.scale.clone()
   }]));
   state.mixer=new THREE.AnimationMixer(state.root);
   state.mixer.clipAction(withJointFormTracks(state.root,newClip,state.jointConfig)).play();
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
 motionStatus('Добавлено в набор: '+motion.preview.name+'. Выбери следующее движение или файл.');
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
   let content;
   if(state.type==='glb'&&state.sourceBuffer){
     const nodeIndices=new Map();state.root.traverse(node=>{const index=state.rigLookup?.get(node)?.nodes;if(node.isBone&&index!==undefined)nodeIndices.set(node.name,index)});
     const memoryBudgetMiB=await resolveBakeMemoryBudget({android:Capacitor.getPlatform()==='android',deviceMemory:navigator.deviceMemory,readNative:()=>deviceMemory.getInfo()});
     content=appendGlbAnimations(state.sourceBuffer,motion.extras,{nodeIndices,memoryBudgetMiB});
   }else content=await createModelExporter().parseAsync(state.root,{
     binary:true,trs:true,onlyVisible:false,animations:clips,
     maxTextureSize:4096,includeCustomExtensions:false
   });
   const checked=inspectGlb(content);
   assertGlbPreserved({...modelStats(state.root,state.clips),animations:clips.length},checked,clips);
   if(checked.animations!==clips.length)
     throw Error('Часть анимаций не была сохранена');
   progress(70);
   await save(content,state.name+'_with_animations.glb','model/gltf-binary');
   motionStatus('✓ GLB сохранён: '+clips.length+' анимаций, '+checked.skins+' скелетов. '+
     'Проверь движения и A/T-позы в Godot.');
 }catch(e){motionStatus('Ошибка экспорта анимаций: '+(e.message||e))}
 finally{state.busy=false;buttons();setTimeout(()=>progress(0),1000)}
});
function changeQuality(id){
 if(state.busy)return;
 const preset=MOBILE_PRESETS[id]||MOBILE_PRESETS.balanced;
 $('preset').value=id;
 $('texture').value=String(preset.texture);
 document.querySelectorAll('[data-quality]').forEach(b=>{
   const active=b.dataset.quality===id;
   b.classList.toggle('active',active);
   b.setAttribute('aria-pressed',String(active));
 });
 discardPreview();
 status('Размер текстур выбран. Цель сетки настраивается отдельно.');
}
function updateGeometryControls(){
 const enabled=$('opt-geometry').checked&&!$('opt-geometry').disabled;
 const target=$('geometry-mode').value==='target';
 $('geometry-ratio-field').hidden=target;
 $('geometry-target-field').hidden=!target;
 for(const id of ['geometry-mode','geometry-target','geometry-error','geometry'])$(id).disabled=!enabled;
 const bakeAllowed=enabled&&$('opt-textures').checked&&state.type==='glb';
 $('bake-details').disabled=!bakeAllowed||state.busy;
 if(!bakeAllowed)$('bake-details').checked=false;
}
document.querySelectorAll('[data-quality]').forEach(b=>
 b.addEventListener('click',()=>changeQuality(b.dataset.quality)));
$('opt-textures').addEventListener('change',()=>{
  $('texture-codec').disabled=!$('opt-textures').checked;
  if(!$('opt-textures').checked)$('texture-codec').value='keep';
});
for(const id of ['texture','geometry','opt-geometry','opt-textures','opt-animation','geometry-codec','texture-codec','geometry-mode','geometry-target','geometry-error','bake-details'])
 $(id).addEventListener('change',()=>{
 if(state.busy)return;
 updateGeometryControls();
 discardPreview();status('Настройки изменены. Создай предпросмотр заново.');
});
$('morph-select').addEventListener('change',updateMorphValue);
$('morph-weight').addEventListener('input',()=>{
 if(state.busy)return;const value=Number($('morph-weight').value);
 try{modelPlayback.stop();if(state.mixer||motion.pose)stopMotionPlayback();const [mesh,index]=$('morph-select').value.split(':').map(Number);morphPreview.setWeight(mesh,index,value);updateMorphValue();buttons()}catch(e){status('Ошибка проверки мимики: '+e.message)}
});
$('morph-reset').addEventListener('click',()=>{stopMotionPlayback();updateMorphValue();buttons()});
$('model-play').addEventListener('click',()=>{
 jointUi?.stopPose();
 skinEditorUi?.setMode('view');
 if(state.busy||!state.root)return;
 try{
  if(modelPlayback.playing)modelPlayback.pause();
  else {if(state.mixer||motion.pose)stopMotionPlayback();if(!modelPlayback.active){morphPreview.reset();updateMorphValue()}modelPlayback.play(Number($('model-clip').value));}
 }catch(e){status('Ошибка воспроизведения: '+e.message)}
 buttons();
});
$('model-stop').addEventListener('click',()=>{modelPlayback.stop();buttons()});
$('model-clip').addEventListener('change',()=>{modelPlayback.stop();buttons()});
$('view-original').addEventListener('click',()=>showComparison(false));
$('view-optimized').addEventListener('click',()=>showComparison(true));
$('preview-opt').addEventListener('click',preparePreview);
$('cancel-bake').addEventListener('click',()=>activeBake?.abort());
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
 guidedRigUi?.setTab(button.dataset.tab==='rig');
 skinEditorUi?.setTab(button.dataset.tab==='skin');
});
new ResizeObserver(()=>{
 const area=$('viewport');if(area.clientWidth<5||area.clientHeight<5)return;
 renderer.setSize(area.clientWidth,area.clientHeight,false);
 camera.aspect=area.clientWidth/area.clientHeight;camera.updateProjectionMatrix();
}).observe($('viewport'));
const playbackClock=new THREE.Clock();
sourceVisual=new MotionCanvas($('anim-source-visual-canvas'));
$('anim-source-visual-toggle').addEventListener('click',()=>{const playing=sourceVisual.toggle();$('anim-source-visual-toggle').textContent=playing?'Ⅱ Пауза схемы':'▶ Играть схему';$('anim-source-visual-toggle').setAttribute('aria-pressed',String(playing))});
motionCatalog=new MotionCatalog({
 busy:()=>state.busy,filter:()=>$('anim-source-filter').value,category:()=>$('anim-category').value,family:()=>selectedMotionFamily,canSelect:()=>!!state.root&&!state.bvhOnly&&isRiggedCharacter(state.root),stop:stopMotionPlayback,setBusy:value=>{state.busy=value;buttons()},
 current:index=>Number($('anim-source-file').value)===index?motion.bundle:null,
 load:async(entry,signal)=>{const memoryBudgetMiB=await resolveBakeMemoryBudget({android:Capacitor.getPlatform()==='android',deviceMemory:navigator.deviceMemory,readNative:()=>deviceMemory.getInfo()});return loadMotionSource(entry,{memoryBudgetMiB,signal})},
 select:async(index,query,category,family)=>{const previous=Number($('anim-source-file').value),reuse=previous===index&&motion.bundle;selectedMotionFamily=family;fillMotionFamilies($('anim-family'),motion.pack,family);fillMotionCategories($('anim-category'),motion.pack.filter(e=>motionFamily(e)===family),category);$('anim-source-filter').value=query;renderMotionFiles(index);if(reuse)chooseMotionClip(0);else await chooseMotionFile(index);if(!motion.source)return;const mapping=readMotionMapping(),matched=mapping.filter(r=>r.target).length;if(matched>=Math.min(5,mapping.length)&&matched>0)previewMotion();else motionStatus('Движение выбрано. Для просмотра на персонаже уточни соответствия костей и нажми «Адаптировать и посмотреть».');document.querySelector('.view').scrollIntoView({behavior:'smooth',block:'start'})},
 error:message=>motionStatus('Ошибка визуального выбора: '+message)
});
initializeEmbeddedMotions();
guidedRigUi=new GuidedRigUI({
 scene,camera,orbit,canvas:renderer.domElement,model:()=>state,busy:()=>state.busy,
 setBusy:value=>{state.busy=value;buttons()},progress,stopPlayback:stopMotionPlayback,
 memoryBudget:()=>resolveBakeMemoryBudget({android:Capacitor.getPlatform()==='android',deviceMemory:navigator.deviceMemory,readNative:()=>deviceMemory.getInfo()}),
 save:(bytes,name)=>save(bytes,name,'model/gltf-binary'),resultRoot:()=>state.previewRoot,
 invalidate:()=>{if(state.preview?.kind==='rig')discardPreview()},showResult:()=>showComparison(true),
 result:result=>{
  const previewRoot=makeRigPreview(state.root,state.rigLookup,result.preview);
  discardPreview();state.preview=result;state.previewRoot=previewRoot;state.previewClips=[];state.previewMetrics=modelStats(previewRoot,[]);scene.add(previewRoot);
  refreshModelPlayback();displayComparison(result);$('preview-switch').hidden=false;$('view-label').hidden=false;showComparison(true);
 },
 use:result=>{
  const root=state.previewRoot;if(!root||state.preview!==result)throw Error('Скелет больше не относится к текущей модели');
  stopMotionPlayback();modelPlayback.dispose();morphPreview.dispose();scene.remove(state.root);release(state.root,{keepTextures:true});delete root.userData.phoenixSharedTextures;
  state.root=root;state.previewRoot=null;state.preview=null;state.previewClips=[];state.previewMetrics=null;state.clips=[];state.name=(state.name+'_rig').slice(0,60);state.bytes=result.bytes.length;state.type='glb';state.sourceBuffer=asArrayBuffer(result.bytes);state.sourceFile=null;state.rigLookup=null;state.hasMorphs=false;state.bvhOnly=false;state.info='GLB 2.0. Создан скелет тела: '+result.bones+' костей. Перед игрой проверь деформации.';
  resetMotionStudio();refreshModelPlayback();display();$('filename').textContent=state.name+'.glb';$('preview-switch').hidden=true;$('view-label').hidden=true;showComparison(false);renderer.renderLists.dispose();
  document.querySelector('[data-tab="anim"]').click();motionStatus('Скелет готов. Выбери ZIP, BVH, FBX или GLB/glTF с движениями.');status('Скелет применён к рабочей копии. Исходный файл не изменялся.');buttons();
 }
});
armWeightsUi=new ArmWeightsUI({
 model:()=>state,preview:()=>state.preview,busy:()=>state.busy,setBusy:value=>{state.busy=value;buttons()},progress,
 stop:()=>{stopMotionPlayback();modelPlayback.stop();guidedRigUi.stop()},
 memoryBudget:()=>resolveBakeMemoryBudget({android:Capacitor.getPlatform()==='android',deviceMemory:navigator.deviceMemory,readNative:()=>deviceMemory.getInfo()}),
 save:(bytes,name)=>save(bytes,name,'model/gltf-binary'),
 result:result=>{const root=makeArmWeightsPreview(state.root,state.rigLookup,result.preview);discardPreview();state.preview=result;state.previewRoot=root;state.previewClips=state.clips;state.previewMetrics=modelStats(root,state.clips);scene.add(root);refreshModelPlayback();displayComparison(result);$('preview-switch').hidden=false;$('view-label').hidden=false;showComparison(true)},
 use:result=>{const root=state.previewRoot;if(!root||state.preview!==result)throw Error('Результат больше не относится к текущей модели');modelPlayback.dispose();morphPreview.dispose();scene.remove(state.root);release(state.root,{keepTextures:true});delete root.userData.phoenixSharedTextures;state.root=root;state.previewRoot=null;state.preview=null;state.previewClips=[];state.previewMetrics=null;state.name=(state.name+'_arms_fixed').slice(0,60);state.bytes=result.bytes.length;state.sourceBuffer=asArrayBuffer(result.bytes);state.sourceFile=null;state.rigLookup=null;motion.preview=null;refreshModelPlayback();display();$('filename').textContent=state.name+'.glb';$('preview-switch').hidden=true;$('view-label').hidden=true;showComparison(false);renderer.renderLists.dispose();status('Веса рук применены. Анимации сохранены.');buttons()}
});
skinEditorUi=new SkinEditorUI({
 scene,camera,orbit,canvas:renderer.domElement,model:()=>state,busy:()=>state.busy,setBusy:value=>{state.busy=value;buttons()},
 stop:()=>{stopMotionPlayback();modelPlayback.stop();morphPreview.reset();guidedRigUi.stop();updatePlaybackButtons()},showResult:()=>showComparison(true),discard:discardPreview,release,
 memoryBudget:()=>resolveBakeMemoryBudget({android:Capacitor.getPlatform()==='android',deviceMemory:navigator.deviceMemory,readNative:()=>deviceMemory.getInfo()}),save:(bytes,name)=>save(bytes,name,'model/gltf-binary'),
 result:(result,root)=>{discardPreview();state.preview=result;state.previewRoot=root;state.previewClips=state.clips;state.previewMetrics=modelStats(root,state.clips);scene.add(root);refreshModelPlayback();displayComparison(result);$('preview-switch').hidden=false;$('view-label').hidden=false;showComparison(true)},
 use:result=>{const root=state.previewRoot;if(!root||state.preview!==result)throw Error('Копия редактора больше не активна');modelPlayback.dispose();morphPreview.dispose();scene.remove(state.root);release(state.root,{keepTextures:true});delete root.userData.phoenixSharedTextures;state.root=root;state.previewRoot=null;state.preview=null;state.previewClips=[];state.previewMetrics=null;state.name=(state.name+'_weights').slice(0,60);state.bytes=result.bytes.length;state.sourceBuffer=asArrayBuffer(result.bytes);state.sourceFile=null;state.rigLookup=result.associations;motion.preview=null;refreshModelPlayback();display();$('filename').textContent=state.name+'.glb';$('preview-switch').hidden=true;$('view-label').hidden=true;showComparison(false);renderer.renderLists.dispose();status('Ручные веса применены. Анимации сохранены.');buttons()}
});
jointUi=new JointCorrectionUI({
 model:()=>state,busy:()=>state.busy,setBusy:value=>{state.busy=value;buttons()},progress,stop:stopMotionPlayback,discard:discardPreview,previewRoot:()=>state.previewRoot,showResult:()=>showComparison(true),
 memoryBudget:()=>resolveBakeMemoryBudget({android:Capacitor.getPlatform()==='android',deviceMemory:navigator.deviceMemory,readNative:()=>deviceMemory.getInfo()}),save:(bytes,name)=>save(bytes,name,'model/gltf-binary'),
 result:result=>{const preview=makeJointPreview(state.root,state.rigLookup,result.preview),clips=state.clips.map(c=>withJointFormTracks(preview.root,c,result.config));discardPreview();result.associations=preview.associations;state.preview=result;state.previewRoot=preview.root;state.previewClips=clips;state.previewMetrics=modelStats(preview.root,clips);scene.add(preview.root);refreshModelPlayback();displayComparison(result);$('preview-switch').hidden=false;$('view-label').hidden=false;showComparison(true)},
 use:result=>{const root=state.previewRoot;if(!root||state.preview!==result)throw Error('Копия суставов больше не активна');modelPlayback.dispose();morphPreview.dispose();scene.remove(state.root);release(state.root,{keepTextures:true});delete root.userData.phoenixSharedTextures;state.root=root;state.clips=state.previewClips;state.previewRoot=null;state.preview=null;state.previewClips=[];state.previewMetrics=null;state.name=(state.name+'_joints').slice(0,60);state.bytes=result.bytes.length;state.sourceBuffer=asArrayBuffer(result.bytes);state.sourceFile=null;state.rigLookup=result.associations;state.jointConfig=result.config;state.hasMorphs=true;motion.preview=null;refreshModelPlayback();display();$('filename').textContent=state.name+'.glb';$('preview-switch').hidden=true;$('view-label').hidden=true;showComparison(false);renderer.renderLists.dispose();status('Коррекции применены. Новые анимации будут экспортированы вместе с формами сгиба.');buttons()}
});
function tick(now=performance.now()){requestAnimationFrame(tick);const delta=Math.min(playbackClock.getDelta(),.1);if(state.mixer)state.mixer.update(delta);if(!state.busy)modelPlayback.update(delta);guidedRigUi.update(delta);sourceVisual.update(now/1000,!state.busy&&!$('tab-anim').classList.contains('hidden')&&document.visibilityState!=='hidden');motionCatalog.update(now/1000);orbit.update();if(!motionCatalog.isOpen)renderer.render(scene,camera)}tick();buttons();

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



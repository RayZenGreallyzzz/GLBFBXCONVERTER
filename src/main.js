import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {Capacitor,registerPlugin} from '@capacitor/core';
import {inspectGlb,inspectFbx,modelStats,assertGlbPreserved} from './format.js';
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
const state={root:null,clips:[],name:'model',bytes:0,type:'',busy:false,info:''};
function status(t){$('status').textContent=t}
function progress(n){$('progress').style.width=n+'%'}
function buttons(){const active=!!state.root&&!state.busy;$('opt-export').disabled=!active;$('convert-export').disabled=!active}
function fit(){
  const bounds=new THREE.Box3().setFromObject(state.root);if(bounds.isEmpty())return;
  const center=bounds.getCenter(new THREE.Vector3()),dist=Math.max(.5,bounds.getSize(new THREE.Vector3()).length());
  orbit.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(.7*dist,.4*dist,1.5*dist));
  camera.near=Math.max(.0001,dist/50000);camera.far=Math.max(200,dist*300);
  camera.updateProjectionMatrix();orbit.update();
}
function release(root){root?.traverse(obj=>{if(!obj.isMesh)return;obj.geometry?.dispose();for(const m of Array.isArray(obj.material)?obj.material:[obj.material])if(m){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose()}})}
function display(){
 const m=modelStats(state.root,state.clips),metrics=[['Размер',(state.bytes/1048576).toFixed(1)+' МБ'],['Меши',m.meshes],['Полигоны',m.triangles],['Вершины',m.vertices],['Материалы',m.materials],['Текстуры',m.textures],['Кости',m.bones],['Анимации',m.animations]];
 $('metrics').replaceChildren();
 for(const [label,value] of metrics){const row=document.createElement('div');row.className='metric';const l=document.createElement('span');l.textContent=label;const n=document.createElement('strong');n.textContent=value;row.append(l,n);$('metrics').append(row)}
 $('compat').textContent=state.info+'\n'+(m.skinned?'Найдены меши со скелетом. Проверяй движения в Godot.':'Модель без привязанного скелета. Для Mixamo может потребоваться авториггинг.');
}
async function load(file){
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
   }else throw Error('Нужен файл GLB или FBX');
   if(!root)throw Error('Модель не найдена');
   if(state.root){scene.remove(state.root);release(state.root)}
   scene.add(root);state.root=root;state.clips=clips;state.name=file.name.replace(/\.[^.]+$/,'').replace(/[^\p{L}\p{N}_ -]/gu,'_').slice(0,55);state.bytes=file.size;state.type=ext;state.info=info;
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
 const b=value instanceof Uint8Array?value:new Uint8Array(value);
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
async function exportAs(target,optimized){
 if(!state.root||state.busy)return;
 state.busy=true;buttons();progress(3);
 try{
   const current=modelStats(state.root,state.clips);
   if(target==='glb'){
     const maxTextureSize=optimized?Number($('texture').value):4096;
     status('Создаём GLB, обрабатываем текстуры…');
     const file=await new GLTFExporter().parseAsync(state.root,{binary:true,trs:true,onlyVisible:false,animations:state.clips,maxTextureSize,includeCustomExtensions:false});
     const result=inspectGlb(file);assertGlbPreserved(current,result,state.clips);
     const forbidden=['KHR_draco_mesh_compression','EXT_meshopt_compression','KHR_texture_basisu','EXT_texture_webp'];
     if(result.required.some(x=>forbidden.includes(x)))throw Error('Файл требует нестандартное расширение сжатия');
     const name=state.name+(optimized?'_android_'+maxTextureSize:'_converted')+'.glb';
     progress(70);status('GLB проверен: '+result.meshes+' мешей, '+result.skins+' скелетов, '+result.animations+' анимаций. Выбери файл…');
     await save(file,name,'model/gltf-binary');
   }else{
     const version=Number(target);
     if(![7400,7500].includes(version))throw Error('Этот FBX нельзя достоверно экспортировать в текущем движке');
     status('Создаём FBX '+version+'…');
     const {FBXExporter}=await import('@comfyorg/fbx-exporter-three');
     const file=await new FBXExporter().parseAsync(state.root,{version,preset:'blender',fps:30,animations:state.clips,embedTextures:true,onlyVisible:false});
     const checked=inspectFbx(file);
     if(checked.version!==version)throw Error('Экспортёр выдал другую версию FBX: '+checked.version);
     progress(70);
     await save(file,state.name+'_fbx'+version+'.fbx','application/octet-stream');
   }
 }catch(error){console.error(error);status('Ошибка экспорта: '+(error.message||String(error)))}
 finally{state.busy=false;buttons();setTimeout(()=>progress(0),1000)}
}
$('model-file').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';load(file)});
$('preset').addEventListener('change',e=>{$('texture').value={mobile:'512',balanced:'1024',high:'2048',original:'4096'}[e.target.value]});
$('opt-export').addEventListener('click',()=>exportAs('glb',true));
$('convert-export').addEventListener('click',()=>exportAs($('target').value,false));
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

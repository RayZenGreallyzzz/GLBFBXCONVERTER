// Exercise the production bundle, including its real module workers and WASM.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import * as THREE from 'three';
import {unzipSync,zipSync} from 'fflate';
import {compressionFixture} from '../tests/helpers/compression-fixtures.mjs';
import {inspectGlb} from '../src/format.js';
import {createCodecIO} from '../src/codec-io.js';
import {Document,WebIO,Accessor} from '@gltf-transform/core';
import {EXTTextureWebP} from '@gltf-transform/extensions';
import {geometryHistory} from '../src/geometry-policy.js';
import {exportTextured3mf} from '../src/three-mf.js';
import {formatSize} from '../src/glb-optimize.js';
import {assertBakeRigPreserved} from '../src/bake-common.js';
import {morphFixture} from '../tests/helpers/morph-fixture.mjs';
import {captureMorphs,assertMorphMetadata} from '../src/morph-policy.js';
import {rigFixture} from '../tests/helpers/rig-fixture.mjs';
import {FBXExporter} from '@comfyorg/fbx-exporter-three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {appendGlbAnimations} from '../src/glb-add-animations.js';
import {motionFixture} from '../tests/helpers/motion-fixture.mjs';

const origin='http://127.0.0.1:4178';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview',
 '--host','127.0.0.1','--port','4178','--strictPort'],{stdio:'ignore'});
const temp=await mkdtemp(join(tmpdir(),'forge-codecs-'));
let browser;
try{
 for(let i=0;i<100;i++){
  try{if((await fetch(origin)).ok)break}catch{}
  if(i===99)throw Error('Preview server did not start');
  await new Promise(r=>setTimeout(r,100));
 }
 browser=await chromium.launch({headless:true,
  channel:process.env.CODEC_TEST_CHANNEL||undefined,
  executablePath:process.env.CODEC_TEST_BROWSER||undefined,
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
   ...(process.env.CODEC_TEST_BROWSER?['--single-process','--no-zygote','--in-process-gpu']:[])]});
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:900}});
 const external=[],errors=[];
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();
  external.push(url.href);return route.abort();
 });
 const page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);
 await page.locator('#brand-splash').waitFor({state:'detached',timeout:15000});
 const png=await page.evaluate(()=>{
  const c=document.createElement('canvas');c.width=c.height=16;
  const ctx=c.getContext('2d');ctx.fillStyle='#ee1122';ctx.fillRect(0,0,8,16);
  ctx.fillStyle='rgba(0,255,0,.3)';ctx.fillRect(8,0,8,16);
  return c.toDataURL().split(',')[1];
 });
 const source=await compressionFixture({texture:new Uint8Array(Buffer.from(png,'base64')),textureMime:'image/png'});
 async function load(bytes,name){
  await page.locator('#model-file').setInputFiles({name,mimeType:'application/octet-stream',buffer:Buffer.from(bytes)});
  await page.waitForFunction(()=>/Загружено|загружен|Ошибка загрузки/.test(document.getElementById('status').textContent),{},{timeout:60000});
  const status=await page.locator('#status').innerText();
  assert.ok(!status.includes('Ошибка'),status);
 }
 async function preview(){
  await page.locator('#preview-opt').click();
  await page.waitForFunction(()=>!document.getElementById('opt-export').disabled||
   /Ошибка предпросмотра/.test(document.getElementById('status').textContent),{},{timeout:180000});
  const status=await page.locator('#status').innerText();
  assert.ok(!status.includes('Ошибка'),status);
 }
 async function download(){
  const waiting=page.waitForEvent('download');await page.locator('#opt-export').click();
  const download=await waiting,path=join(temp,download.suggestedFilename());
  await download.saveAs(path);return new Uint8Array(await readFile(path));
 }
 async function metrics(bytes,variant){
  const {json}=inspectGlb(bytes);let triangles=0,vertices=0;
  for(const mesh of json.meshes||[])for(const p of mesh.primitives){vertices+=json.accessors[p.attributes.POSITION].count;triangles+=(p.indices!==undefined?json.accessors[p.indices].count:json.accessors[p.attributes.POSITION].count)/3}
  assert.equal(await page.locator('#metrics').getAttribute('data-variant'),variant);
  assert.equal(await page.locator('[data-metric="triangles"] strong').innerText(),String(triangles));
  assert.equal(await page.locator('[data-metric="vertices"] strong').innerText(),String(vertices));
  assert.equal(await page.locator('[data-metric="size"] strong').innerText(),formatSize(bytes.byteLength));
  assert.equal(await page.locator('[data-metric="animations"] strong').innerText(),String(json.animations?.length||0));
 }
 await load(source,'fixture.glb');
 await page.getByText('Точные настройки (необязательно)',{exact:true}).click();
 assert.equal(await page.locator('#geometry-ratio-field').isVisible(),false);
 assert.equal(await page.locator('#geometry-target-field').isVisible(),true);
 await page.locator('#geometry-mode').selectOption('ratio');
 assert.equal(await page.locator('#geometry-ratio-field').isVisible(),true);
 assert.equal(await page.locator('#geometry-target-field').isVisible(),false);
 await page.locator('#geometry-mode').selectOption('target');
 await page.getByText('Точные настройки (необязательно)',{exact:true}).click();
 await page.locator('#opt-geometry').uncheck();
 await preview();
 assert.deepEqual(await download(),source,'default unchanged GLB must stay byte-identical');
 await page.getByText('Сжатие GLB — Meshopt / Draco / KTX2',{exact:true}).click();
 for(const codec of ['meshopt','draco']){
  await load(source,'fixture.glb');
  await page.locator('#opt-geometry').uncheck();
  await page.locator('#opt-textures').uncheck();
  await page.locator('#geometry-codec').selectOption(codec);
  await preview();
  const output=await download();
  assert.ok(inspectGlb(output).required.includes(codec==='draco'?'KHR_draco_mesh_compression':'EXT_meshopt_compression'));
  await load(output,codec+'.glb');
  console.log('Browser: '+codec+' export/download/reimport OK (external requests blocked)');
 }
 for(const mode of ['etc1s','uastc']){
  await load(source,'fixture.glb');
  await page.locator('#opt-geometry').uncheck();
  await page.locator('#opt-textures').check();
  await page.locator('#geometry-codec').selectOption('meshopt');
  await page.locator('#texture-codec').selectOption(mode);
  await preview();
  const output=await download();
  assert.ok(inspectGlb(output).required.includes('KHR_texture_basisu'));
  await load(output,'ktx2-'+mode+'.glb');
  console.log('Browser: PNG → KTX2 '+mode+' + Meshopt → export/reimport OK');
  if(mode==='uastc'){
   const io=await createCodecIO(output),doc=await io.readBinary(output);
   const unpacked=await io.writeJSON(doc);
   const archive=zipSync({'scene.gltf':new TextEncoder().encode(JSON.stringify(unpacked.json)),...unpacked.resources});
   await load(archive,'gltf-with-external-ktx2.zip');
   console.log('Browser: ZIP glTF + external KTX2/BIN import OK');
  }
 }
 // Inspect the real skinned baking result in motion. Playback is view-only;
 // saving an active frame must retain the exact prepared GLB and original file.
 const riggedSource=await compressionFixture({texture:new Uint8Array(Buffer.from(png,'base64')),textureMime:'image/png',segments:50});
 await load(riggedSource,'rigged-bake-original.glb');
 await page.locator('#geometry-codec').selectOption('keep');await page.locator('#texture-codec').selectOption('keep');
 await page.locator('#opt-geometry').check();await page.locator('#opt-textures').check();await page.locator('#opt-animation').uncheck();
 await page.locator('[data-quality="mobile"]').click();await page.locator('#geometry-target').fill('1000');await page.locator('#geometry-error').selectOption('0.02');
 await page.locator('#bake-details').check();await preview();const riggedBaked=await download();
 assert.equal(inspectGlb(riggedBaked).animations,1);assert.equal(inspectGlb(riggedBaked).skins,1);
 const rigIO=new WebIO();assertBakeRigPreserved(await rigIO.readBinary(riggedSource),await rigIO.readBinary(riggedBaked));
 await metrics(riggedBaked,'optimized');assert.equal(await page.locator('#model-playback').isVisible(),true);
 assert.deepEqual(await page.locator('#model-clip option').allTextContents(),['Wave']);
 await page.locator('#model-play').click();await page.waitForTimeout(250);assert.equal(await page.locator('#model-playback').getAttribute('data-state'),'playing');
 await page.locator('#view-original').click();await metrics(riggedSource,'original');assert.equal(await page.locator('#model-playback').getAttribute('data-state'),'playing');
 await page.locator('#view-optimized').click();await metrics(riggedBaked,'optimized');
 assert.deepEqual(await download(),riggedBaked,'playing a clip must not bake its current frame into saved bytes');
 await page.locator('#model-play').click();assert.equal(await page.locator('#model-playback').getAttribute('data-state'),'paused');
 await page.locator('#model-stop').click();assert.equal(await page.locator('#model-playback').getAttribute('data-state'),'stopped');
 await page.locator('#model-play').click();await page.locator('[data-tab="convert"]').click();await page.locator('#target').selectOption('glb');
 const rigDownload=page.waitForEvent('download');await page.locator('#convert-export').click();const rigCopy=await rigDownload,rigPath=join(temp,'rig-source-copy.glb');await rigCopy.saveAs(rigPath);
 assert.deepEqual(new Uint8Array(await readFile(rigPath)),riggedSource);assert.equal(await page.locator('#model-playback').getAttribute('data-state'),'stopped');
 await page.locator('[data-tab="opt"]').click();
 console.log('Browser: skinned surface bake → synchronized clip preview → active metrics → immutable save and original copy');
 const npcSource=await morphFixture({texture:new Uint8Array(Buffer.from(png,'base64')),tangents:true,sparse:true});
 await load(npcSource,'npc-morphs.glb');assert.equal(await page.locator('#morph-preview').isVisible(),true);assert.deepEqual(await page.locator('#morph-select option').allTextContents(),['Smile','Blink']);
 async function morphWeight(value){await page.locator('#morph-weight').evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}))},value)}
 await page.locator('#morph-select').selectOption('0:0');await morphWeight(.8);assert.equal(await page.locator('#morph-value').innerText(),'80%');
 await page.locator('#morph-select').selectOption('0:1');await morphWeight(.6);await page.locator('#morph-select').selectOption('0:0');assert.equal(await page.locator('#morph-value').innerText(),'80%');
 await page.locator('#opt-geometry').check();await page.locator('#opt-textures').check();await page.locator('#opt-animation').check();await page.locator('#geometry-target').fill('1000');await page.locator('#bake-details').check();
 await preview();const npcBaked=await download(),npcDoc=await new WebIO().readBinary(npcSource),npcOut=await new WebIO().readBinary(npcBaked);assertMorphMetadata(captureMorphs(npcDoc),npcOut);assert.equal(geometryHistory(inspectGlb(npcBaked).json.extras).surfaceBake.projectionMisses,0);
 assert.equal(await page.locator('[data-metric="morphs"] strong').innerText(),'2');
 await page.locator('#morph-select').selectOption('0:0');assert.equal(await page.locator('#morph-value').innerText(),'20%');await morphWeight(.9);
 await page.locator('#view-original').click();assert.equal(await page.locator('#morph-value').innerText(),'90%');await page.locator('#view-optimized').click();assert.deepEqual(await download(),npcBaked,'manual expressions must not rewrite prepared GLB');
 await page.locator('#model-clip').selectOption({label:'Face_CUBICSPLINE'});await page.locator('#model-play').click();await page.waitForTimeout(200);await morphWeight(.4);assert.equal(await page.locator('#model-playback').getAttribute('data-state'),'stopped');
 await page.locator('#morph-reset').click();assert.equal(await page.locator('#morph-value').innerText(),'20%');
 await page.locator('[data-tab="convert"]').click();const npcDownload=page.waitForEvent('download');await page.locator('#convert-export').click();const npcCopy=await npcDownload,npcPath=join(temp,'npc-original.glb');await npcCopy.saveAs(npcPath);assert.deepEqual(new Uint8Array(await readFile(npcPath)),npcSource);await page.locator('[data-tab="opt"]').click();
 console.log('Browser: NPC morph bake → combined manual expressions → cubic face clip → reset → immutable saves');
 // Guided body rig uses the real worker and production GLTFLoader associations.
 const body=await rigFixture({texture:new Uint8Array(Buffer.from(png,'base64'))});
 const webp=await page.evaluate(base64=>new Promise(resolve=>{const im=new Image();im.onload=()=>{const c=document.createElement('canvas');c.width=im.width;c.height=im.height;c.getContext('2d').drawImage(im,0,0);resolve(c.toDataURL('image/webp').split(',')[1])};im.src='data:image/png;base64,'+base64}),png);
 const bodyIO=new WebIO().registerExtensions([EXTTextureWebP]),bodyDoc=await bodyIO.readBinary(body.bytes);bodyDoc.getRoot().listTextures()[0].setImage(new Uint8Array(Buffer.from(webp,'base64'))).setMimeType('image/webp');bodyDoc.createExtension(EXTTextureWebP).setRequired(true);body.bytes=await bodyIO.writeBinary(bodyDoc);
 await load(body.bytes,'body-original.glb');await page.locator('[data-tab="rig"]').click();
 assert.equal(await page.locator('#rig-build').isDisabled(),true);await page.locator('#rig-draft').click();
 assert.equal(await page.locator('#rig-joint option').count(),18);await page.locator('#rig-side').click();assert.equal(await page.locator('#rig-side').getAttribute('aria-pressed'),'true');await page.locator('#rig-front').click();
 await page.locator('#rig-resolution').selectOption('32');await page.locator('#rig-confirm').check();await page.locator('#rig-build').click();
 await page.locator('#rig-cancel').waitFor({state:'visible'});await page.locator('#rig-cancel').click();
 await page.waitForFunction(()=>/отменено/.test(document.getElementById('rig-status').textContent)&&!document.getElementById('rig-build').disabled);
 assert.equal(await page.locator('#rig-export').isDisabled(),true);
 async function createBodyRig(){await page.locator('#rig-build').click();await page.waitForFunction(()=>!document.getElementById('rig-export').disabled||/Ошибка скелета/.test(document.getElementById('rig-status').textContent),{},{timeout:180000});assert.ok(!(await page.locator('#rig-status').innerText()).includes('Ошибка'))}
 await createBodyRig();assert.equal(await page.locator('[data-metric="bones"] strong').innerText(),'27');
 async function downloadRig(){const waiting=page.waitForEvent('download');await page.locator('#rig-export').click();const file=await waiting,path=join(temp,file.suggestedFilename());await file.saveAs(path);return new Uint8Array(await readFile(path))}
 const bodyRig=await downloadRig();assert.equal(inspectGlb(bodyRig).skins,1);await metrics(bodyRig,'optimized');
 await page.locator('#rig-test-play').click();await page.waitForTimeout(250);assert.equal(await page.locator('#rig-test-stop').isDisabled(),false);
 assert.deepEqual(await downloadRig(),bodyRig,'bend review must not serialize a transient pose');
 await page.locator('#rig-test-play').click();await page.locator('#rig-test-stop').click();assert.equal(await page.locator('#rig-test-stop').isDisabled(),true);
 await page.locator('[data-tab="convert"]').click();await page.locator('#target').selectOption('glb');
 const bodyCopyWaiting=page.waitForEvent('download');await page.locator('#convert-export').click();const bodyCopy=await bodyCopyWaiting,bodyPath=join(temp,'body-original-copy.glb');await bodyCopy.saveAs(bodyPath);assert.deepEqual(new Uint8Array(await readFile(bodyPath)),body.bytes);
 await page.locator('[data-tab="rig"]').click();await page.locator('#tab-rig summary').click();
 const oldX=await page.locator('#rig-x').inputValue();await page.locator('#rig-x').fill(String(Number(oldX)+.0001));await page.locator('#rig-x').press('Tab');
 assert.equal(await page.locator('#rig-confirm').isChecked(),false);assert.equal(await page.locator('#rig-export').isDisabled(),true);assert.equal(await page.locator('#opt-export').isDisabled(),true);
 await page.locator('#rig-x').fill(oldX);await page.locator('#rig-x').press('Tab');await page.locator('#rig-confirm').check();await createBodyRig();
 await page.locator('#rig-resolution').selectOption('48');assert.equal(await page.locator('#rig-export').isDisabled(),true);assert.equal(await page.locator('#rig-confirm').isChecked(),false);await page.locator('#rig-resolution').selectOption('32');await page.locator('#rig-confirm').check();await createBodyRig();
 const adopted=await downloadRig();await page.locator('#rig-use').click();assert.equal(await page.locator('#tab-anim').isVisible(),true);assert.equal(await page.locator('#anim-bvh-file').isDisabled(),false);assert.equal(await page.locator('[data-metric="bones"] strong').innerText(),'27');
 await page.locator('[data-tab="convert"]').click();const adoptedWaiting=page.waitForEvent('download');await page.locator('#convert-export').click();const adoptedFile=await adoptedWaiting,adoptedPath=join(temp,'body-adopted.glb');await adoptedFile.saveAs(adoptedPath);assert.deepEqual(new Uint8Array(await readFile(adoptedPath)),adopted);
 await page.locator('[data-tab="anim"]').click();
 const bodyMotion=['HIERARCHY','ROOT Hips','{','OFFSET 0 0 0','CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation','JOINT Chest','{','OFFSET 0 1 0','CHANNELS 3 Zrotation Xrotation Yrotation','End Site','{','OFFSET 0 1 0','}','}','}','MOTION','Frames: 3','Frame Time: .0333333','0 0 0 0 0 0 0 0 0','0 0 0 0 0 0 15 0 0','0 0 0 0 0 0 30 0 0'].join('\n')+'\n';
 await page.locator('#anim-bvh-file').setInputFiles({name:'body-motion.bvh',mimeType:'text/plain',buffer:Buffer.from(bodyMotion)});await page.waitForFunction(()=>!document.getElementById('anim-preview').disabled||/Ошибка BVH/.test(document.getElementById('anim-status').textContent));
 await page.locator('#anim-preview').click();assert.ok(!(await page.locator('#anim-status').innerText()).includes('Ошибка'));assert.equal(await page.locator('#anim-add').isDisabled(),false);await page.locator('#anim-add').click();
 async function downloadBodyAnimation(){const waiting=page.waitForEvent('download');await page.locator('#anim-export').click();const file=await waiting,path=join(temp,file.suggestedFilename());await file.saveAs(path);return new Uint8Array(await readFile(path))}
 function assertOriginalContainer(original,output){const a=inspectGlb(original).json,b=inspectGlb(output).json;for(const key of ['meshes','nodes','skins','images','textures','materials','extensionsUsed','extensionsRequired'])assert.deepEqual(b[key],a[key],key+' changed during BVH export');const prefix=bytes=>{const jLength=new DataView(bytes.buffer,bytes.byteOffset).getUint32(12,true),bin=20+jLength;return bytes.subarray(bin+8,bin+8+new DataView(bytes.buffer,bytes.byteOffset).getUint32(bin,true))};assert.deepEqual(prefix(output).subarray(0,prefix(original).length),prefix(original),'original BIN must stay exact')}
 const animatedBytes=await downloadBodyAnimation(),animatedBody=inspectGlb(animatedBytes);assert.equal(animatedBody.skins,1);assert.equal(animatedBody.animations,1);assertOriginalContainer(adopted,animatedBytes);assert.ok(animatedBody.required.includes('EXT_texture_webp'));
 await load(animatedBytes,'body-with-bvh.glb');assert.equal(await page.locator('[data-metric="bones"] strong').innerText(),'27');
 await page.locator('#anim-bvh-file').setInputFiles({name:'body-motion-second.bvh',mimeType:'text/plain',buffer:Buffer.from(bodyMotion)});await page.waitForFunction(()=>!document.getElementById('anim-preview').disabled);await page.locator('#anim-preview').click();await page.locator('#anim-add').click();const secondAnimation=await downloadBodyAnimation();assert.equal(inspectGlb(secondAnimation).animations,2);assertOriginalContainer(animatedBytes,secondAnimation);
 await page.locator('[data-tab="opt"]').click();
 console.log('Browser: guided body points → cancel/retry → real worker → bend review → immutable export → edit invalidation → adoption → BVH retarget/export');
 console.log('Browser: WebP GLB → BVH append → exact original image/geometry bytes → reimport → second BVH preserves first clip');
 // A mixed ZIP opens one source at a time, exposes takes, and retains the target.
 const sourceIO=new WebIO().registerExtensions([EXTTextureWebP]),sourceDoc=await sourceIO.readBinary(animatedBytes);for(const m of sourceDoc.getRoot().listMaterials())m.dispose();for(const t of sourceDoc.getRoot().listTextures())t.dispose();const bare=await sourceIO.writeBinary(sourceDoc),sourceRuntime=await new GLTFLoader().parseAsync(bare.buffer.slice(bare.byteOffset,bare.byteOffset+bare.byteLength),'');
 const extraTake=sourceRuntime.animations[0].clone();extraTake.name='Take 2';const twoTakes=appendGlbAnimations(animatedBytes,[extraTake]);
 const fbxClips=sourceRuntime.animations.map(c=>{const copy=c.clone();for(const track of copy.tracks){const p=THREE.PropertyBinding.parseTrackName(track.name);track.name=sourceRuntime.scene.getObjectByName(p.nodeName).uuid+'.'+p.propertyName}return copy});
 const fbx=await new FBXExporter().parseAsync(sourceRuntime.scene,{version:7400,preset:'threejs',fps:30,animations:fbxClips,embedTextures:false});
 const looseDoc=await sourceIO.readBinary(animatedBytes),looseJSON=await sourceIO.writeJSON(looseDoc);for(const image of looseJSON.json.images||[])image.uri='https://example.invalid/never-load.webp';
 const mixed=zipSync({'a/Idle.bvh':new TextEncoder().encode(bodyMotion),'b/Body.glb':twoTakes,'c/Sprint.fbx':new Uint8Array(fbx),'d/Move.gltf':new TextEncoder().encode(JSON.stringify(looseJSON.json)),...Object.fromEntries(Object.entries(looseJSON.resources).filter(([name])=>name.endsWith('.bin')).map(([name,data])=>['d/'+name,data])),'z/Static.glb':adopted});
 await load(adopted,'pack-target.glb');await page.locator('[data-tab="anim"]').click();
 await page.locator('#anim-bvh-file').setInputFiles({name:'motion-library.zip',mimeType:'application/zip',buffer:Buffer.from(mixed)});
 async function sourceReady(){await page.waitForFunction(()=>!document.getElementById('anim-preview').disabled||/Ошибка источника/.test(document.getElementById('anim-status').textContent),{},{timeout:60000});assert.ok(!(await page.locator('#anim-status').innerText()).includes('Ошибка'),await page.locator('#anim-status').innerText())}
 await sourceReady();assert.equal(await page.locator('#anim-source-file option').count(),5);
 async function acceptMotion(){await page.locator('#anim-preview').click();assert.ok(!(await page.locator('#anim-status').innerText()).includes('Ошибка'),await page.locator('#anim-status').innerText());assert.equal(await page.locator('#anim-add').isDisabled(),false);await page.locator('#anim-add').click()}
 await acceptMotion();
 async function selectSource(path){const options=await page.locator('#anim-source-file option').evaluateAll(items=>items.map(o=>({value:o.value,text:o.textContent})));const item=options.find(o=>o.text.endsWith(path));assert.ok(item,path);await page.locator('#anim-source-file').selectOption(item.value)}
 await selectSource('b/Body.glb');await sourceReady();assert.equal(await page.locator('#anim-source-clip option').count(),2);assert.equal(await page.locator('#anim-trim-calibration').isDisabled(),true);await page.locator('#anim-source-clip').selectOption('1');await acceptMotion();
 await selectSource('c/Sprint.fbx');await sourceReady();await acceptMotion();
 await selectSource('d/Move.gltf');await sourceReady();await acceptMotion();
 await selectSource('z/Static.glb');await page.waitForFunction(()=>document.getElementById('anim-status').textContent.includes('Ошибка источника'));assert.equal(await page.locator('#anim-preview').isDisabled(),true);assert.equal(await page.locator('#anim-export').isDisabled(),false);assert.equal(await page.locator('[data-metric="bones"] strong').innerText(),'27');
 const mixedOutput=await downloadBodyAnimation();assertOriginalContainer(adopted,mixedOutput);assert.equal(inspectGlb(mixedOutput).animations,4);await load(mixedOutput,'pack-result.glb');assert.equal(await page.locator('#model-clip option').count(),4);
 await page.locator('[data-tab="opt"]').click();
 console.log('Browser: lazy ZIP → BVH + multi-take GLB + FBX + external-BIN glTF → preview/add four clips → static-file error recovery → exact target export/reimport (no source texture requests)');
 // Match a real library's directory/source counts without committing its assets.
 const catalogFixture=await motionFixture(),catalogFiles={};for(let i=0;i<510;i++)catalogFiles['assets/library/clips/idle_'+String(i).padStart(4,'0')+'.glb']=catalogFixture.bytes;for(let i=0;i<4;i++)catalogFiles['assets/capture/static_'+i+'.glb']=adopted;for(let i=0;i<27;i++)catalogFiles['metadata/'+i+'.json']=new TextEncoder().encode('{}');
 await page.locator('[data-tab="anim"]').click();await page.locator('#anim-bvh-file').setInputFiles({name:'large-library.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(catalogFiles))});await sourceReady();
 assert.equal(await page.locator('#anim-source-file option').count(),514);const currentFile=await page.locator('#anim-source-file').inputValue();
 await page.locator('#anim-source-filter').fill('idle_0509');assert.equal(await page.locator('#anim-source-file option').count(),2);assert.equal(await page.locator('#anim-source-file').inputValue(),currentFile);assert.ok((await page.locator('#anim-source-count').innerText()).includes('1 из 514'));
 await selectSource('clips/idle_0509.glb');await sourceReady();assert.equal(await page.locator('#anim-source-file option').count(),1);const selectedFile=await page.locator('#anim-source-file').inputValue();
 await page.locator('#anim-source-filter').fill('no-such-motion');assert.equal(await page.locator('#anim-source-file option').count(),1);assert.equal(await page.locator('#anim-source-file').inputValue(),selectedFile);assert.ok((await page.locator('#anim-source-count').innerText()).includes('0 из 514'));
 await page.locator('#anim-source-filter').fill('');assert.equal(await page.locator('#anim-source-file option').count(),514);assert.equal(await page.locator('#anim-source-file').inputValue(),selectedFile);await page.locator('[data-tab="opt"]').click();
 console.log('Browser: 541 ZIP entries → 514 lazy source options → clips-folder default → search without changing current source → select last clip → no-match search → restore full catalog');
 // Hit the distinct ArrayBuffer-producing low-memory 3MF path, not just codec helpers.
 const root=new THREE.Group();root.add(new THREE.Mesh(new THREE.PlaneGeometry(1,1,100,100),new THREE.MeshStandardMaterial()));
 const print=await exportTextured3mf(root,{unitScale:1});
 const files=unzipSync(new Uint8Array(print.content));files['padding.bin']=new Uint8Array(11*1024*1024);
 const large=zipSync(files,{level:0});
 await load(large,'preview-regression.3mf');
 await page.locator('#opt-geometry').check();
 await page.locator('#geometry-target').fill('5000');
 await page.locator('#geometry-error').selectOption('0.008');
 await page.locator('#geometry-codec').selectOption('keep');
 await page.locator('#texture-codec').selectOption('keep');
 await preview();const simplified=await download();
 assert.ok(inspectGlb(simplified).meshes>0);
 assert.ok(geometryHistory(inspectGlb(simplified).json.extras));
 console.log('Browser: streamed 3MF → simplified preview → saved GLB OK');
 await load(simplified,'optimized-result.glb');
 assert.equal(await page.locator('#opt-geometry').isDisabled(),true);
 assert.equal(await page.locator('#opt-geometry').isChecked(),false);
 assert.equal(await page.locator('#opt-textures').isDisabled(),false);
 console.log('Browser: reimported simplified mesh is protected against another destructive pass');
 // A new original can still generate independent geometry previews.
 const doc=new Document(),buf=doc.createBuffer();
 const geo=new THREE.PlaneGeometry(1,1,100,100);
 const accessor=(array,type)=>doc.createAccessor().setBuffer(buf).setType(type).setArray(array);
 const primitive=doc.createPrimitive().setAttribute('POSITION',accessor(geo.attributes.position.array,Accessor.Type.VEC3))
  .setAttribute('NORMAL',accessor(geo.attributes.normal.array,Accessor.Type.VEC3))
  .setAttribute('TEXCOORD_0',accessor(geo.attributes.uv.array,Accessor.Type.VEC2))
  .setIndices(accessor(new Uint32Array(geo.index.array),Accessor.Type.SCALAR));
 doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
 const independent=await new WebIO().writeBinary(doc);
 await load(independent,'new-original.glb');
 await page.locator('#opt-geometry').check();await page.locator('#opt-textures').uncheck();
 await page.locator('#geometry-error').selectOption('0.003');
 await page.locator('#geometry-target').fill('5000');
 await page.locator('[data-quality="high"]').click();
 assert.equal(await page.locator('#geometry-target').inputValue(),'5000');
 assert.equal(await page.locator('#geometry-error').inputValue(),'0.003');
 await preview();
 const firstBytes=await download(),first=inspectGlb(firstBytes);assert.ok(geometryHistory(first.json.extras));
 await metrics(firstBytes,'optimized');await page.locator('#view-original').click();await metrics(independent,'original');await page.locator('#view-optimized').click();await metrics(firstBytes,'optimized');
 assert.equal(await page.locator('#model-playback').isVisible(),false);
 await page.locator('#geometry-target').fill('3000');await preview();
 const next=geometryHistory(inspectGlb(await download()).json.extras);
 assert.equal(next.sourceTriangles,20000);
 assert.equal(next.targetTriangles,3000);
 console.log('Browser: custom triangle goals use the original; texture presets stay independent');
 // Real production workers, embedded WASM, cancel/retry, and source integrity.
 primitive.setMaterial(doc.createMaterial('Baking source').setAlphaMode('BLEND')
  .setBaseColorTexture(doc.createTexture('Color').setMimeType('image/png')
   .setImage(new Uint8Array(Buffer.from(png,'base64')))));
 const bakeSource=await new WebIO().writeBinary(doc);
 await load(bakeSource,'surface-original.glb');
 await page.locator('#opt-geometry').check();await page.locator('#opt-textures').check();
 await page.locator('[data-quality="mobile"]').click();await page.locator('#geometry-target').fill('1000');
 await page.locator('#bake-details').check();await page.locator('#preview-opt').click();
 await page.locator('#cancel-bake').waitFor({state:'visible'});await page.locator('#cancel-bake').click();
 await page.waitForFunction(()=>document.getElementById('status').textContent.includes('отменён'));
 assert.equal(await page.locator('#opt-export').isDisabled(),true);
 await preview();const baked=await download(),bakedJson=inspectGlb(baked);
 assert.equal(geometryHistory(bakedJson.json.extras).surfaceBake.projectionMisses,0);
 assert.equal(geometryHistory(bakedJson.json.extras).surfaceBake.resolution,512);
 assert.ok(bakedJson.json.materials[0].normalTexture);
 assert.ok(bakedJson.json.meshes[0].primitives[0].attributes.TANGENT!==undefined);
 await page.locator('#view-original').click();await page.locator('#view-optimized').click();
 await page.locator('[data-tab="convert"]').click();await page.locator('#target').selectOption('glb');
 const originalDownload=page.waitForEvent('download');await page.locator('#convert-export').click();
 const originalFile=await originalDownload,originalPath=join(temp,'original-copy.glb');await originalFile.saveAs(originalPath);
 assert.deepEqual(new Uint8Array(await readFile(originalPath)),bakeSource);
 await page.locator('[data-tab="opt"]').click();await load(baked,'baked-reimport.glb');
 assert.equal(await page.locator('#bake-details').isDisabled(),true);
 console.log('Browser: offline surface workers → cancel/retry → save/reimport; original byte-identical');
 // The large static path drops the source viewport/bytes and reads the File in
 // each worker. Verify restoration after cancellation and all three phases.
 const dense=new THREE.PlaneGeometry(1,1,400,400);
 primitive.setAttribute('POSITION',accessor(dense.attributes.position.array,Accessor.Type.VEC3))
  .setAttribute('NORMAL',accessor(dense.attributes.normal.array,Accessor.Type.VEC3))
  .setAttribute('TEXCOORD_0',accessor(dense.attributes.uv.array,Accessor.Type.VEC2))
  .setIndices(accessor(new Uint32Array(dense.index.array),Accessor.Type.SCALAR));
 const denseSource=await new WebIO().writeBinary(doc);await load(denseSource,'large-static-original.glb');
 await page.locator('#opt-geometry').check();await page.locator('#opt-textures').check();await page.locator('#bake-details').check();
 await page.locator('#geometry-target').fill('30000');await page.locator('#geometry-error').selectOption('0.008');
 await page.locator('#preview-opt').click();await page.locator('#cancel-bake').waitFor({state:'visible'});await page.locator('#cancel-bake').click();
 await page.waitForFunction(()=>document.getElementById('status').textContent.includes('отменён')&&!document.getElementById('preview-opt').disabled,{},{timeout:60000});
 await preview();const denseBaked=inspectGlb(await download());assert.equal(geometryHistory(denseBaked.json.extras).sourceTriangles,320000);
 assert.ok(geometryHistory(denseBaked.json.extras).triangles>16384,'production worker must exercise bounded UV charts');
 assert.equal(geometryHistory(denseBaked.json.extras).surfaceBake.projectionMisses,0);
 await page.locator('#view-original').click();await page.locator('#view-optimized').click();
 await page.locator('[data-tab="convert"]').click();await page.locator('#target').selectOption('glb');
 const denseDownload=page.waitForEvent('download');await page.locator('#convert-export').click();const denseCopy=await denseDownload,densePath=join(temp,'dense-copy.glb');await denseCopy.saveAs(densePath);
 assert.deepEqual(new Uint8Array(await readFile(densePath)),denseSource);
 console.log('Browser: file-backed bounded bake → cancel/restore → three workers → exact original copy');
 // High-DPI canvas backing pixels must not cover or push away file selection
 // when a tablet rotates. Check actual hit testing, then open the file picker.
 const tablet=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:2,isMobile:true,hasTouch:true});
 await tablet.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();
 });
 const tabletPage=await tablet.newPage();tabletPage.on('pageerror',e=>errors.push(e.message));await tabletPage.goto(origin);
 await tabletPage.locator('#brand-splash').waitFor({state:'detached',timeout:15000});
 async function checkTabletUpload(){
  await tabletPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=await tabletPage.evaluate(()=>{
   const label=document.querySelector('.viewbar .load'),bar=label.getBoundingClientRect(),v=document.getElementById('viewport').getBoundingClientRect(),c=document.querySelector('#viewport>canvas').getBoundingClientRect();
   const hit=document.elementFromPoint(bar.x+bar.width/2,bar.y+bar.height/2);
   return {buttonVisible:bar.width>0&&bar.height>0&&bar.top>=0&&bar.bottom<=innerHeight,buttonAboveViewer:bar.bottom<=v.top+1,buttonClickable:hit?.closest('.load')===label,canvasWidth:c.width,canvasHeight:c.height,viewerWidth:v.width,viewerHeight:v.height};
  });
  assert.equal(geometry.buttonVisible,true,JSON.stringify(geometry));assert.equal(geometry.buttonAboveViewer,true,JSON.stringify(geometry));assert.equal(geometry.buttonClickable,true,JSON.stringify(geometry));
  assert.ok(Math.abs(geometry.canvasWidth-geometry.viewerWidth)<1,JSON.stringify(geometry));assert.ok(Math.abs(geometry.canvasHeight-geometry.viewerHeight)<1,JSON.stringify(geometry));assert.ok(geometry.viewerHeight<=651,JSON.stringify(geometry));
  const chooser=tabletPage.waitForEvent('filechooser');await tabletPage.locator('.viewbar .load').tap();
  await (await chooser).setFiles({name:'tablet-upload.glb',mimeType:'application/octet-stream',buffer:Buffer.from(source)});
  await tabletPage.waitForFunction(()=>/Загружено|Ошибка загрузки/.test(document.getElementById('status').textContent),{},{timeout:60000});
  assert.ok(!(await tabletPage.locator('#status').innerText()).includes('Ошибка'));
 }
 for(const [width,height]of [[1280,800],[800,1280],[720,1080],[1280,800]]){
  await tabletPage.setViewportSize({width,height});await tabletPage.evaluate(()=>scrollTo(0,0));await checkTabletUpload();
 }
 // Emulate a WebView dropping the CSS min() height declaration. The canvas
 // must still stay bounded instead of feeding its intrinsic pixels into layout.
 await tabletPage.addStyleTag({content:'#viewport{height:auto!important}'});await checkTabletUpload();
 await tablet.close();
 console.log('Browser: high-DPI tablet rotation → upload stays visible/clickable → picker works; auto-height stays bounded');
 assert.deepEqual(external,[],'all codecs must be loaded from the local app');
 assert.deepEqual(errors,[],'browser must not raise uncaught exceptions');
 console.log('Production browser codec checks passed.');
}finally{
 await browser?.close();server.kill();await rm(temp,{recursive:true,force:true});
}



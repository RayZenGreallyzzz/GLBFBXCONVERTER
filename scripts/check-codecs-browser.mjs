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
import {geometryHistory} from '../src/geometry-policy.js';
import {exportTextured3mf} from '../src/three-mf.js';

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
 const first=inspectGlb(await download());assert.ok(geometryHistory(first.json.extras));
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

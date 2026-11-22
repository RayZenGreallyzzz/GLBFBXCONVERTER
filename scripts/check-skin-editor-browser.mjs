import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {chromium} from 'playwright';import * as THREE from 'three';import {armRepairFixture} from '../tests/helpers/arm-repair-fixture.mjs';import {rigFixture} from '../tests/helpers/rig-fixture.mjs';import {openSkinDocument} from '../src/skin-document.js';import {inspectGlb} from '../src/format.js';
const origin='http://127.0.0.1:4183',temp=await mkdtemp(join(tmpdir(),'forge-skin-ui-')),server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4183','--strictPort'],{stdio:'ignore'});let browser,page;
try{
 const {bytes}=await armRepairFixture(),doc=openSkinDocument(bytes),bone=doc.bones.find(b=>b.name==='mixamorigLeftForeArm'),hand=doc.bones.find(b=>b.name==='mixamorigLeftHand'),target=new THREE.Vector3(...bone.position).lerp(new THREE.Vector3(...hand.position),.55),p=doc.parts[0];let aim=null,best=Infinity;
 for(let n=0;n<p.triangles.length;n+=3){const v=[0,1,2].map(k=>new THREE.Vector3().fromArray(p.positions,p.triangles[n+k]*3)),center=v[0].clone().add(v[1]).add(v[2]).divideScalar(3),normal=v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize(),distance=Math.hypot(center.x-target.x,center.y-target.y);if(normal.z>.5&&distance<best){best=distance;aim=center}}
 assert.ok(aim);for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break}catch{}if(i===99)throw Error('Preview did not start');await new Promise(r=>setTimeout(r,100))}
 browser=await chromium.launch({headless:true,channel:process.env.CODEC_TEST_CHANNEL||undefined,executablePath:process.env.CODEC_TEST_BROWSER||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:1000},hasTouch:true});page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',r=>{const u=new URL(r.request().url());return u.origin===origin||['blob:','data:'].includes(u.protocol)?r.continue():r.abort()});
 await page.goto(origin);await page.locator('#brand-splash').waitFor({state:'detached'});await page.locator('#model-file').setInputFiles({name:'paint.glb',mimeType:'model/gltf-binary',buffer:Buffer.from(bytes)});await page.waitForFunction(()=>!document.getElementById('skin-open').disabled);await page.locator('[data-tab="skin"]').click();await page.locator('#skin-open').click();await page.waitForFunction(()=>!document.getElementById('skin-save').disabled||document.getElementById('skin-status').textContent.startsWith('Ошибка'),{},{timeout:60000});assert.ok(!(await page.locator('#skin-status').innerText()).includes('Ошибка'),await page.locator('#skin-status').innerText());
 assert.equal(await page.locator('#skin-canvas-brush').getAttribute('aria-pressed'),'true');
 await page.locator('#skin-canvas-rotate').click();
 assert.equal(await page.locator('#skin-mode').inputValue(),'view');
 await page.locator('#skin-canvas-brush').click();
 assert.equal(await page.locator('#skin-mode').inputValue(),'brush');
 await page.locator('#skin-bone').selectOption(String(hand.id));for(const [id,value]of [['skin-radius','8'],['skin-strength','70']])await page.locator('#'+id).evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))},value);await page.locator('#skin-heat').check();await page.locator('#skin-mode').selectOption('brush');await page.locator('#skin-front').click();await page.waitForTimeout(200);
 const box=await page.locator('#viewport canvas').boundingBox(),bounds=new THREE.Box3(new THREE.Vector3(...doc.bounds.min),new THREE.Vector3(...doc.bounds.max)),center=bounds.getCenter(new THREE.Vector3()),camera=new THREE.PerspectiveCamera(45,box.width/box.height,.001,2000);camera.position.copy(center).add(new THREE.Vector3(0,0,bounds.getSize(new THREE.Vector3()).length()*1.3));camera.lookAt(center);camera.updateMatrixWorld(true);const projected=aim.clone().project(camera),x=box.x+(projected.x+1)*box.width/2,y=box.y+(1-projected.y)*box.height/2;await page.touchscreen.tap(x,y);assert.match(await page.locator('#skin-status').innerText(),/Мазок завершён: [1-9]/);
 async function download(click){const event=page.waitForEvent('download');await click();const d=await event,path=join(temp,d.suggestedFilename());await d.saveAs(path);return new Uint8Array(await readFile(path))}
 const painted=await download(()=>page.locator('#skin-save').click()),fixed=openSkinDocument(painted);let changed=0;for(let n=0;n<p.weights.length/4;n++)if([0,1,2,3].some(k=>fixed.parts[0].weights[n*4+k]!==p.weights[n*4+k]||fixed.parts[0].indices[n*4+k]!==p.indices[n*4+k])){changed++;assert.ok(p.positions[n*3+2]>target.z-.01,'the brush must leave the back surface unchanged')}assert.ok(changed>0);await page.locator('#skin-undo').click();assert.deepEqual(await download(()=>page.locator('#skin-save').click()),bytes);await page.locator('#skin-redo').click();assert.deepEqual(await download(()=>page.locator('#skin-save').click()),painted);
 await page.locator('#skin-mode').selectOption('brush');await page.locator('#viewport canvas').scrollIntoViewIfNeeded();const dragBox=await page.locator('#viewport canvas').boundingBox(),dx=dragBox.x+(projected.x+1)*dragBox.width/2,dy=dragBox.y+(1-projected.y)*dragBox.height/2;await page.mouse.move(dx,dy);await page.mouse.down();await page.mouse.move(dx+12,dy,{steps:3});await page.mouse.up();assert.match(await page.locator('#skin-status').innerText(),/Мазок завершён: [1-9]/);await page.locator('#skin-undo').click();assert.deepEqual(await download(()=>page.locator('#skin-save').click()),painted,'one drag must be exactly one undo command');

 await page.locator('#skin-operation').selectOption('rigid');
 assert.equal(await page.locator('#skin-strength').isDisabled(),true);
 async function tapSurface(){
  await page.locator('#viewport canvas').scrollIntoViewIfNeeded();
  const b=await page.locator('#viewport canvas').boundingBox();
  await page.touchscreen.tap(b.x+(projected.x+1)*b.width/2,b.y+(1-projected.y)*b.height/2);
 }
 await tapSurface();
 const rigid=await download(()=>page.locator('#skin-save').click()),rigidPart=openSkinDocument(rigid).parts[0];
 assert.equal(await page.locator('#skin-canvas-brush').getAttribute('aria-pressed'),'true');
 assert.ok(rigidPart.weights.some((w,i)=>w===1&&rigidPart.indices[i]===hand.id&&fixed.parts[0].weights[i]!==1));
 await page.locator('#skin-undo').click();assert.deepEqual(await download(()=>page.locator('#skin-save').click()),painted);
 await page.locator('#skin-mode').selectOption('detail');await tapSurface();
 assert.match(await page.locator('#skin-piece-status').innerText(),/Выделено вершин: [1-9]/);
 assert.equal(await page.locator('#skin-piece-apply').isEnabled(),true);
 assert.deepEqual(await download(()=>page.locator('#skin-save').click()),painted,'selection alone must not edit weights');
 await page.locator('#skin-piece-apply').click();
 assert.match(await page.locator('#skin-piece-status').innerText(),/Деталь закреплена/);
 const filled=openSkinDocument(await download(()=>page.locator('#skin-save').click())).parts[0];
 const affected=filled.weights.filter((w,i)=>w===1&&filled.indices[i]===hand.id&&fixed.parts[0].weights[i]!==1);
 assert.ok(affected.length>10&&affected.length<filled.weights.length/4);
 await page.locator('#skin-undo').click();assert.deepEqual(await download(()=>page.locator('#skin-save').click()),painted);
 await page.locator('#skin-canvas-brush').click();
 await page.locator('#skin-operation').selectOption('add');

 const chest=new THREE.Vector3(...doc.bones.find(b=>b.name==='mixamorigSpine2').position);
 const views={front:[0,0,1],back:[0,0,-1],left:[1,0,0],right:[-1,0,0]};
 for(const [view,coordinates] of Object.entries(views)){
  await page.locator('#skin-'+view).click();
  assert.equal(await page.locator('#skin-views [aria-pressed="true"]').getAttribute('data-skin-view'),view);
  assert.equal(await page.locator('#skin-mode').inputValue(),'brush');
  await page.locator('#viewport canvas').scrollIntoViewIfNeeded();
  const rect=await page.locator('#viewport canvas').boundingBox();
  const direction=new THREE.Vector3(...coordinates);
  camera.aspect=rect.width/rect.height;camera.updateProjectionMatrix();
  camera.position.copy(center).addScaledVector(direction,bounds.getSize(new THREE.Vector3()).length()*1.3);
  camera.lookAt(center);camera.updateMatrixWorld(true);
  const hit=chest.clone().project(camera);
  await page.touchscreen.tap(rect.x+(hit.x+1)*rect.width/2,rect.y+(1-hit.y)*rect.height/2);
  assert.match(await page.locator('#skin-status').innerText(),/Мазок завершён: [1-9]/,view);
  const changed=openSkinDocument(await download(()=>page.locator('#skin-save').click())).parts[0];
  const edited=[];
  for(let n=0;n<changed.weights.length/4;n++){
   if([0,1,2,3].some(k=>changed.weights[n*4+k]!==fixed.parts[0].weights[n*4+k]))
    edited.push(new THREE.Vector3().fromArray(p.positions,n*3).sub(chest).dot(direction));
  }
  assert.ok(edited.length>0&&edited.every(distance=>distance>0),view+' must address its visible side');
  await page.locator('#skin-undo').click();
  assert.deepEqual(await download(()=>page.locator('#skin-save').click()),painted);
 }
 await page.locator('#skin-front').click();

 await page.locator('#skin-shoulder-tools').evaluate(el=>el.open=true);const oldX=Number(await page.locator('#skin-shoulder-x').inputValue());await page.locator('#skin-shoulder-x').fill(String(oldX-.03));await page.locator('#skin-shoulder-x').dispatchEvent('change');await page.locator('#skin-shoulder-apply').click();assert.ok(!(await page.locator('#skin-status').innerText()).includes('Ошибка'),await page.locator('#skin-status').innerText());const shoulders=await download(()=>page.locator('#skin-save').click());assert.deepEqual(inspectGlb(shoulders).json.animations,inspectGlb(bytes).json.animations);openSkinDocument(shoulders);
 await page.locator('#model-play').click();assert.equal(await page.locator('#model-playback').getAttribute('data-state'),'playing');await page.waitForTimeout(500);await page.locator('#model-play').click();await page.locator('#view-original').click();await page.waitForTimeout(50);const screenshot=await page.locator('#viewport canvas').screenshot();await page.locator('#view-optimized').click();await page.waitForTimeout(50);assert.notDeepEqual(await page.locator('#viewport canvas').screenshot(),screenshot);await page.locator('#model-stop').click();
 await page.locator('[data-tab="convert"]').click();await page.locator('#target').selectOption('glb');assert.deepEqual(await download(()=>page.locator('#convert-export').click()),bytes,'original export is immutable');await page.locator('[data-tab="skin"]').click();await page.locator('#skin-use').click();assert.equal(await page.locator('#model-clip option').count(),1);await page.locator('[data-tab="convert"]').click();assert.deepEqual(await download(()=>page.locator('#convert-export').click()),shoulders);
 await page.locator('[data-tab="skin"]').click();await page.locator('#skin-open').click();await page.waitForFunction(()=>!document.getElementById('skin-save').disabled);await page.setViewportSize({width:412,height:915});assert.equal(await page.locator('#tab-skin').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);await page.locator('#skin-close').click();await page.locator('[data-tab="convert"]').click();assert.deepEqual(await download(()=>page.locator('#convert-export').click()),shoulders);
 await page.locator('[data-tab="skin"]').click();await page.locator('#skin-open').click();
 await page.waitForFunction(()=>!document.getElementById('skin-save').disabled);
 await page.locator('#skin-head-tools').evaluate(el=>el.open=true);
 const beforeY=Number(await page.locator('#skin-head-y').inputValue());
 await page.locator('#skin-head-y').fill(String(beforeY-.015));await page.locator('#skin-head-y').dispatchEvent('change');
 await page.locator('#skin-head-pivot').click();assert.match(await page.locator('#skin-status').innerText(),/Точка Head применена/);
 await page.locator('#skin-head-strength').evaluate(el=>{el.value='80';el.dispatchEvent(new Event('input',{bubbles:true}))});
 assert.equal(await page.locator('#skin-head-strength-value').innerText(),'80%');
 await page.locator('#skin-head-adjust').click();await page.waitForFunction(()=>/Коррекция головы: [1-9]/.test(document.getElementById('skin-status').textContent));
 await page.locator('#skin-head-play').click();assert.equal(await page.locator('#skin-head-stop').isEnabled(),true);
 await page.locator('#view-original').click();assert.equal(await page.locator('#skin-head-stop').isEnabled(),true);
 await page.locator('#skin-head-stop').click();assert.equal(await page.locator('#skin-head-stop').isDisabled(),true);
 const headFixed=await download(()=>page.locator('#skin-save').click());
 assert.equal(inspectGlb(headFixed).json.extras.phoenixSkinEdit.headMoved,true);
 await page.locator('#skin-undo').click();await page.locator('#skin-undo').click();
 assert.deepEqual(await download(()=>page.locator('#skin-save').click()),shoulders);
 await page.locator('#skin-close').click();

 const unrigged=await rigFixture();
 await page.locator('#model-file').setInputFiles({name:'body.glb',mimeType:'model/gltf-binary',buffer:Buffer.from(unrigged.bytes)});
 await page.locator('[data-tab="rig"]').click();await page.locator('#rig-draft').click();
 await page.locator('#rig-resolution').selectOption('32');
 await page.locator('#rig-head-strength').evaluate(el=>{el.value='70';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))});
 await page.locator('#rig-confirm').check();await page.locator('#rig-build').click();
 await page.locator('#rig-edit-weights').click({timeout:60000});
 await page.waitForFunction(()=>!document.getElementById('skin-save').disabled);
 assert.equal(await page.locator('#tab-skin').isVisible(),true);
 const guided=await download(()=>page.locator('#skin-save').click());
 assert.equal(inspectGlb(guided).json.extras.phoenixRig.headWeightStrength,.7);
 assert.deepEqual(errors,[]);
 console.log('Skin editor: actual visible-surface brush → save → exact undo/redo → shoulder rebind → animated comparison → immutable original → adoption → mobile layout → head pivot and weights → new rig opens directly in the editor. Passed.');
}catch(e){if(page)console.error('Skin UI status:',await page.locator('#skin-status').innerText().catch(()=>''));throw e}finally{await browser?.close();server.kill('SIGTERM');await rm(temp,{recursive:true,force:true})}

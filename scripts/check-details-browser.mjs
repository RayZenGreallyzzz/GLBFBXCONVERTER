import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {fingerFixture} from '../tests/helpers/finger-fixture.mjs';
import {boxGlb} from '../tests/helpers/details-fixture.mjs';
import {inspectGlb} from '../src/format.js';

const origin='http://127.0.0.1:4185';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4185','--strictPort'],{stdio:'ignore'});
const temp=await mkdtemp(join(tmpdir(),'forge-details-'));
let browser;
try{
  for(let i=0;i<100;i++){
    try{if((await fetch(origin)).ok)break}catch{}
    if(i===99)throw Error('Preview server did not start');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  browser=await chromium.launch({headless:true,channel:process.env.CODEC_TEST_CHANNEL||undefined,
    executablePath:process.env.CODEC_TEST_BROWSER||undefined,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({acceptDownloads:true,viewport:{width:440,height:900},hasTouch:true});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const $=id=>page.locator('#detail-'+id);
  const payload=(name,bytes)=>({name,mimeType:'model/gltf-binary',buffer:Buffer.from(bytes)});
  const {bytes:body}=await fingerFixture({tail:true});
  const model=await boxGlb('Крыло',.4), horn=await boxGlb('Рог',.3);
  await page.goto(origin);
  await page.locator('#brand-splash').waitFor({state:'hidden'});
  await page.locator('#model-file').setInputFiles(payload('Персонаж.glb',body));
  await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('✓ Загружено'));
  await page.locator('[data-tab="rig"]').click();
  await page.locator('#rig-detail-entry').click();
  await $('file').setInputFiles([payload('Крыло.glb',model),payload('Рог.glb',horn)]);
  await page.waitForFunction(()=>document.querySelectorAll('#detail-selected option').length===3);
  await $('selected').selectOption({label:'Крыло'});
  await $('position').click();
  await $('scale').click();
  assert.equal(await $('scale').getAttribute('aria-pressed'),'true');
  await $('front').click();

  async function touchAt(x,y){
    const canvas=page.locator('#viewport canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box=await canvas.boundingBox();
    await page.touchscreen.tap(box.x+box.width*x,box.y+box.height*y);
  }
  async function number(id,value){
    await $(id).evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))},value);
  }
  await $('knife').click();
  await touchAt(.5,.5);
  await $('knife-controls').waitFor({state:'visible'});
  await $('turn').click();
  assert.equal(await $('turn').getAttribute('aria-pressed'),'true');
  await $('camera').click();
  await $('move').click();
  assert.equal(await $('move').getAttribute('aria-pressed'),'true','camera movement must keep the placed knife');
  await number('size-x',10);await number('size-y',180);await number('size-z',180);
  await $('cut').click();
  await page.waitForFunction(()=>document.getElementById('detail-status').textContent.includes('Срез сделан'),{},{timeout:30000});
  await $('undo').click();
  await page.waitForFunction(()=>document.getElementById('detail-status').textContent.includes('отменена'));
  await $('knife').click();
  await touchAt(.5,.5);
  await $('knife-controls').waitFor({state:'visible'});
  await number('size-x',10);await number('size-y',180);await number('size-z',180);
  await $('cut').click();
  await page.waitForFunction(()=>document.getElementById('detail-status').textContent.includes('Срез сделан'),{},{timeout:30000});
  await $('piece').click();
  await touchAt(.42,.5);
  await $('keep').click();
  await page.waitForFunction(()=>document.getElementById('detail-status').textContent.includes('кусок оставлен'),{},{timeout:30000});
  await $('paint').click();
  await page.waitForFunction(()=>document.getElementById('detail-status').textContent.includes('среза обновлён'),{},{timeout:30000});

  await $('parent').selectOption({label:'Голова'});
  await $('bind').click();
  await $('chain').selectOption('1');
  await $('add-bones').click();
  await touchAt(.43,.5);
  await touchAt(.35,.5);
  await page.waitForFunction(()=>document.getElementById('detail-points-count').textContent==='2 из 2');
  assert.equal(await $('point-y').getAttribute('type'),'range');
  const originalY=Number(await $('point-y').inputValue());
  await number('point-y',originalY+.02);
  assert.equal(await $('point-value-y').innerText(),(originalY+.02).toFixed(3));
  await number('point-y',originalY);
  await $('open-motion').click();
  await page.waitForFunction(()=>document.getElementById('detail-pose-status').textContent.startsWith('Поворачивай'));
  await $('motion-body').selectOption({label:'Wrist test'});
  await number('time',.5);
  const canvas=page.locator('#viewport canvas');
  await canvas.scrollIntoViewIfNeeded();
  const rest=await canvas.screenshot();
  assert.equal(await $('angle-x').getAttribute('type'),'range');
  await number('angle-x',40);
  assert.equal(await $('angle-value-x').innerText(),'40°');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.notDeepEqual(await canvas.screenshot(),rest,'slider changes the rendered pose before the key is saved');
  await $('key').click();
  await $('exit-pose').click();
  await $('selected').selectOption({label:'Рог'});
  await $('parent').selectOption({label:'Голова'});
  await $('bind').click();
  await $('review').click();
  await $('player').waitFor({state:'visible',timeout:30000});
  assert.equal(await $('clip').locator('option').count(),2);
  const done=page.waitForEvent('download');
  await $('save').click();
  const download=await done,path=join(temp,download.suggestedFilename());
  await download.saveAs(path);
  const json=inspectGlb(await readFile(path)).json;
  assert.equal(json.animations.length,2);
  assert.equal(json.animations[0].name,'Wrist test');
  assert.equal(json.animations[1].channels.length,json.animations[0].channels.length+1);
  assert.ok(json.nodes.some(n=>n.name==='Рог'&&n.skin!==undefined));
  assert.ok(json.nodes.some(n=>n.name==='Крыло'&&n.skin!==undefined));
  assert.equal(json.skins[0].joints.length,28);
  await $('return').click();
  await $('tail').click();
  await $('chain').selectOption('2');
  await touchAt(.46,.475);
  await touchAt(.49,.499);
  await touchAt(.57,.535);
  await page.waitForFunction(()=>document.getElementById('detail-points-count').textContent==='3 из 3');
  await number('radius',8);
  await $('open-motion').click();
  await page.waitForFunction(()=>document.getElementById('detail-pose-status').textContent.startsWith('Поворачивай'));
  await number('time',.5);await number('angle-y',24);
  await $('key').click();
  await $('review').click();
  await page.waitForFunction(()=>document.getElementById('detail-status').textContent.includes('Веса хвоста'),{},{timeout:30000});
  assert.equal(await $('clip').locator('option').count(),3);
  assert.deepEqual(errors,[]);
  console.log('Details UI: multi-file import, transform modes, finite knife, undo, piece selection, seam paint, mounted parts, animation preview and GLB export.');
}finally{
  await browser?.close();
  server.kill();
  await rm(temp,{recursive:true,force:true});
}

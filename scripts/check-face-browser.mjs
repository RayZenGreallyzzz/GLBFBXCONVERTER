import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {jointGlb} from '../src/joint-glb.js';
import {morphFixture} from '../tests/helpers/morph-fixture.mjs';
import {mouthFixture} from '../tests/helpers/mouth-fixture.mjs';

const origin='http://127.0.0.1:4183';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4183','--strictPort'],{stdio:'ignore'});
const temp=await mkdtemp(join(tmpdir(),'forge-face-'));
let browser;
try {
  for (let i=0;i<100;i++) {
    try {if ((await fetch(origin)).ok) break} catch {}
    if (i===99) throw Error('Preview server did not start');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  browser=await chromium.launch({headless:true,channel:process.env.CODEC_TEST_CHANNEL||undefined,
    executablePath:process.env.CODEC_TEST_BROWSER||undefined,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({acceptDownloads:true,viewport:{width:360,height:800}});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);
  await page.locator('#brand-splash').waitFor({state:'hidden'});
  await page.locator('#face-entry').click();
  assert.equal(await page.locator('#face-title').isVisible(),true);
  assert.equal(await page.locator('#face-templates').isVisible(),true);
  assert.equal(await page.locator('#face-template-open').isDisabled(),true);
  assert.equal(await page.locator('#face-roar').isDisabled(),true);
  assert.match(await page.locator('#face-guide').innerText(),/Загрузи модель GLB/);
  async function load(bytes,name) {
    await page.locator('#model-file').setInputFiles({name,mimeType:'model/gltf-binary',buffer:Buffer.from(bytes)});
    await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('✓ Загружено'));
  }
  async function setRange(id,value) {
    await page.locator('#face-'+id).evaluate((input,value)=>{
      input.value=String(value);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    },value);
  }
  async function exportGlb() {
    const done=page.waitForEvent('download');
    await page.locator('#face-save').click();
    const file=await done, path=join(temp,file.suggestedFilename());
    await file.saveAs(path);
    return jointGlb(await readFile(path));
  }
  function track(glb,name) {
    const clip=glb.json.animations.find(c=>c.name===name);
    assert.ok(clip,name);
    const channel=clip.channels.find(c=>c.target.path==='weights');
    const sampler=clip.samplers[channel.sampler];
    return [glb.read(sampler.input),glb.read(sampler.output)];
  }

  const existing=await morphFixture({segments:8,sparse:true});
  await load(existing,'existing-forms.glb');
  await page.locator('#face-body').selectOption({label:'Face_CUBICSPLINE'});
  await page.locator('#face-shape').selectOption({label:'Smile'});
  await setRange('time',.4);
  await setRange('weight',.9);
  assert.equal(await page.locator('#face-weight-value').innerText(),'90%');
  await page.locator('#face-key').click();
  assert.match(await page.locator('#face-status').innerText(),/Ключ мимики записан/);
  await page.locator('#face-name').fill('Smile edit');
  const edited=await exportGlb(), baseline=jointGlb(existing);
  assert.deepEqual(edited.json.animations.slice(0,-1),baseline.json.animations);
  assert.deepEqual(edited.bin.subarray(0,baseline.bin.length),baseline.bin);
  const [times,weights]=track(edited,'Smile edit'), key=times.indexOf(Math.fround(.4));
  assert.ok(key>=0&&Math.abs(weights[key*2]-.9)<.001&&Math.abs(weights[key*2+1]-.8)<.001);

  await load(await mouthFixture(),'new-mouth.glb');
  assert.equal(await page.locator('#face-template-open').isEnabled(),true);
  assert.equal(await page.locator('#face-roar').isDisabled(),true);
  await page.locator('#face-template-open').click();
  assert.ok(await page.locator('#face-setup').evaluate(el=>el.open));
  await page.locator('#face-view-side').click();
  assert.equal(await page.locator('#face-mode').inputValue(),'side');
  const before=await page.locator('#face-z').inputValue(), canvas=page.locator('#viewport canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box=await canvas.boundingBox();
  await page.mouse.move(box.x+box.width*.51,box.y+box.height*.49);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*.58,box.y+box.height*.55,{steps:4});
  await page.mouse.up();
  assert.notEqual(await page.locator('#face-z').inputValue(),before);
  await page.locator('#face-reset').click();
  await page.locator('#face-x').fill('0.01');
  await page.locator('#face-x').press('Tab');
  await page.locator('#face-generate').click();
  await page.waitForFunction(()=>document.getElementById('face-status').textContent.includes('Формы готовы')||
    document.getElementById('face-status').textContent.startsWith('Ошибка'));
  assert.match(await page.locator('#face-status').innerText(),/Формы готовы/);
  assert.deepEqual(await page.locator('#face-shape option').allTextContents(),['MouthClose','MouthOpen']);
  assert.equal(await page.locator('#face-template-open').isDisabled(),true);
  assert.equal(await page.locator('#face-roar').isEnabled(),true);
  await page.locator('#face-roar').click();
  assert.equal(await page.locator('#face-shape option:checked').innerText(),'MouthOpen');
  await page.locator('#face-play').click();
  await page.waitForFunction(()=>Number(document.getElementById('face-time').value)>.15);
  await page.locator('#face-play').click();
  const generated=await exportGlb();
  const [, roar]=track(generated,'Мимика');
  assert.ok(roar.some((v,i)=>i%2===1&&v>.99));
  await load(generated.bytes,'mouth-round-trip.glb');
  assert.deepEqual(await page.locator('#face-shape option').allTextContents(),['MouthClose','MouthOpen']);
  assert.equal(await page.locator('#face-roar').isEnabled(),true,'reopened mouth forms must expose the roar template');
  assert.deepEqual(errors,[]);
  console.log('Face UI: edit cubic source form, retain related channels, fit jaw on mobile, play roar and reopen exported shapes.');
} finally {
  await browser?.close();
  server.kill();
  await rm(temp,{recursive:true,force:true});
}

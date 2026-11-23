import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {fingerFixture} from '../tests/helpers/finger-fixture.mjs';
import {jointGlb} from '../src/joint-glb.js';
const origin='http://127.0.0.1:4184';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4184','--strictPort'],{stdio:'ignore'});
const temp=await mkdtemp(join(tmpdir(),'forge-fingers-'));
let browser;
try {
  for (let i=0;i<100;i++){
    try {if ((await fetch(origin)).ok) break} catch {}
    if (i===99) throw Error('Preview server did not start');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  browser=await chromium.launch({headless:true,channel:process.env.CODEC_TEST_CHANNEL||undefined,
    executablePath:process.env.CODEC_TEST_BROWSER||undefined,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({acceptDownloads:true,viewport:{width:420,height:920}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  await page.locator('#brand-splash').waitFor({state:'hidden'});
  await page.locator('[data-tab="rig"]').click();
  assert.equal(await page.locator('#finger-open').isDisabled(),true);
  const {bytes}=await fingerFixture(), original=jointGlb(bytes);
  await page.locator('#model-file').setInputFiles({name:'rig-without-fingers.glb',mimeType:'model/gltf-binary',buffer:Buffer.from(bytes)});
  await page.locator('#finger-open').click();
  await page.locator('#finger-tools').waitFor({state:'visible'});
  assert.equal(await page.locator('#finger-digit option').count(),5);
  await page.locator('#finger-hand').selectOption('right');
  await page.locator('#finger-edge').click();
  assert.equal(await page.locator('#finger-edge').getAttribute('aria-pressed'),'true');
  await page.locator('#finger-digit').selectOption('Pinky');
  await page.locator('#finger-enabled').uncheck();
  await page.locator('#finger-confirm').check();
  assert.equal(await page.locator('#finger-build').isEnabled(),true);
  await page.locator('#finger-build').click();
  await page.locator('#finger-save').waitFor({state:'visible',timeout:30000});
  assert.match(await page.locator('#finger-status').textContent(),/Добавлено 27 костей/);
  await page.locator('#finger-test').evaluate(input=>{
    input.value='55';input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  assert.equal(await page.locator('#finger-test-value').innerText(),'55°');
  const pending=page.waitForEvent('download');
  await page.locator('#finger-save').click();
  const download=await pending, path=join(temp,download.suggestedFilename());
  await download.saveAs(path);
  const saved=jointGlb(await readFile(path));
  assert.equal(saved.json.skins[0].joints.length,54);
  assert.deepEqual(saved.json.animations,original.json.animations);
  assert.deepEqual(saved.bin.subarray(0,original.bin.length),original.bin);
  assert.ok(saved.json.nodes.some(n=>n.name==='mixamorigLeftHandIndex3'));
  assert.ok(saved.json.nodes.every(n=>n.name!=='mixamorigRightHandPinky1'));
  await page.locator('#finger-weights').click();
  await page.locator('#skin-tools').waitFor({state:'visible',timeout:30000});
  assert.ok((await page.locator('#skin-bone option').allTextContents()).some(name=>name==='LeftHandIndex3'));
  assert.deepEqual(errors,[]);
  console.log('Browser finger rig: mobile draft, individual finger selection, bend preview, immutable old clips, export and weight editor.');
}finally {
  await browser?.close();
  server.kill();
  await rm(temp,{recursive:true,force:true});
}

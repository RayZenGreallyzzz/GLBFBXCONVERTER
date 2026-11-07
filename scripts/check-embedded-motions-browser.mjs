// Production UI checks with generated test fixtures. These ten clips are
// served only by Playwright routing and never written to public/motions.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {zipSync} from 'fflate';
import {WebIO} from '@gltf-transform/core';
import {motionFixture} from '../tests/helpers/motion-fixture.mjs';
import {buildMotionLibrary} from './build-motion-library.mjs';

const origin='http://127.0.0.1:4180',temp=await mkdtemp(join(tmpdir(),'forge-embedded-ui-'));
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4180','--strictPort'],{stdio:'ignore'});
let browser;
try{
 const files={},names=['Idle One','Idle Two','Walk Forward','Walk Backward','Run Forward','Run Fast','Attack Punch','Jump','monster_Dragon','monster_Orc'];
 for(let i=0;i<names.length;i++){
  const {doc}=await motionFixture();doc.getRoot().listAnimations()[1].dispose();const animation=doc.getRoot().listAnimations()[0];animation.setName(i===8?'Run':i===9?'Idle':names[i]);animation.listSamplers()[0].getOutput().getArray()[0]+=(i+1)*.002;
  files[names[i]+'.glb']=await new WebIO().writeBinary(doc);
 }
 const input=join(temp,'fixtures.zip'),output=join(temp,'motions');await writeFile(input,zipSync(files));await buildMotionLibrary([input],output);
 for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break}catch{}if(i===99)throw Error('Preview server did not start');await new Promise(r=>setTimeout(r,100))}
 browser=await chromium.launch({headless:true,channel:process.env.CODEC_TEST_CHANNEL||undefined,executablePath:process.env.CODEC_TEST_BROWSER||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',...(process.env.CODEC_TEST_BROWSER?['--single-process','--no-zygote','--in-process-gpu']:[])]});
 const context=await browser.newContext({viewport:{width:412,height:915}}),requests=[],errors=[];
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin===origin&&url.pathname.startsWith('/motions/')){requests.push(url.pathname);try{return await route.fulfill({status:200,body:await readFile(join(output,url.pathname.slice('/motions/'.length))),contentType:url.pathname.endsWith('.json')?'application/json':'model/gltf-binary'})}catch{return route.fulfill({status:404,body:'missing'})}}
  if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();return route.abort();
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await page.locator('#brand-splash').waitFor({state:'detached'});
 await page.waitForFunction(()=>document.getElementById('anim-embedded-status').textContent.includes('Встроено движений: 10'));
 assert.deepEqual(requests,['/motions/index.json'],'startup must fetch no animation data');
 await page.locator('[data-tab="anim"]').click();await page.locator('#anim-browse').click();
 const ready=async count=>{await page.waitForFunction(count=>document.querySelectorAll('.motion-card[data-ready="true"]').length===count,count);assert.equal(await page.locator('.motion-card-error').count(),0)};
 await ready(6);assert.equal(await page.locator('.motion-card button:enabled').count(),0,'browsing without a target must work without allowing transfer');
 await page.locator('#motion-catalog-category').selectOption('run');await ready(2);
 await page.locator('#motion-catalog-search').fill('fast');await ready(1);assert.equal(await page.locator('.motion-card strong').innerText(),'Run Fast');
 await page.locator('#motion-catalog-search').fill('');await page.locator('#motion-catalog-category').selectOption('all');await ready(6);await page.locator('#motion-catalog-next').click();await ready(2);
 assert.ok(new Set(requests.filter(r=>r.endsWith('.glb'))).size<=8);
 await page.locator('#motion-catalog-family [data-family="monster"]').click();await ready(2);assert.ok((await page.locator('.motion-card strong').allInnerTexts()).every(name=>/Dragon|Orc/.test(name)));
 await page.locator('#motion-catalog-category').selectOption('run');await ready(1);assert.ok((await page.locator('.motion-card strong').innerText()).includes('Dragon'));
 assert.equal(await page.locator('#motion-catalog').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'mobile dialog must fit the viewport');
 if(process.env.MOTION_TEST_SCREENSHOT)await page.screenshot({path:process.env.MOTION_TEST_SCREENSHOT});
 await page.locator('#motion-catalog-close').click();assert.equal(await page.locator('#anim-browse').isEnabled(),true,'closing must release the busy state');
 const target=(await motionFixture()).bytes;await page.locator('#model-file').setInputFiles({name:'target.glb',mimeType:'model/gltf-binary',buffer:Buffer.from(target)});
 await page.waitForFunction(()=>/Загружено|загружен|Ошибка загрузки/.test(document.getElementById('status').textContent));assert.ok(!(await page.locator('#status').innerText()).includes('Ошибка'));
 await page.locator('#anim-family [data-family="monster"]').click();await page.locator('#anim-category').selectOption('run');await page.locator('#anim-browse').click();await ready(1);await page.locator('.motion-card button').first().click();
 await page.waitForFunction(()=>!document.getElementById('anim-add').disabled);assert.equal(await page.locator('#anim-category').inputValue(),'run');await page.locator('#anim-add').click();assert.equal(await page.locator('#anim-export').isEnabled(),true);
 await page.locator('#anim-bvh-file').setInputFiles({name:'my.glb',mimeType:'model/gltf-binary',buffer:Buffer.from(target)});await page.waitForFunction(()=>document.getElementById('anim-library-source').value==='imported'&&!document.getElementById('anim-source-clip').disabled);
 await page.locator('#anim-library-source').selectOption('embedded');assert.equal(await page.locator('#anim-export').isEnabled(),true,'switching libraries must preserve accepted motions');
 assert.ok((await page.locator('#anim-source-count').innerText()).includes('из 8'));assert.deepEqual(errors,[]);
 console.log('Passed: metadata-only startup; offline embedded thumbnails; categories/search; six-card pages; mobile layout; retarget/add; imported/built-in switching. Fixtures only.');
}finally{await browser?.close();server.kill('SIGTERM');await rm(temp,{recursive:true,force:true})}

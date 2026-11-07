import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zipSync} from 'fflate';
import {WebIO} from '@gltf-transform/core';
import * as THREE from 'three';
import {motionFixture} from './helpers/motion-fixture.mjs';
import {buildMotionLibrary,encodeMotionGlb} from '../scripts/build-motion-library.mjs';
import {verifyMotionLibrary} from '../scripts/verify-motion-library.mjs';
import {packMotionBundle,unpackMotionBundle} from '../scripts/motion-bundle.mjs';
import {openEmbeddedMotions} from '../src/embedded-motions.js';
import {loadMotionSource} from '../src/motion-import.js';
import {classifyMotion,matchesMotion,categoryCounts,motionFamily} from '../src/motion-categories.js';
import {inspectGlb} from '../src/format.js';
import {validateBytes} from 'gltf-validator';

test('movement categories distinguish idle, walk, run, attacks and reactions in English and Russian',()=>{
 for(const [name,path,expected]of [
  ['Sword_Idle','Sword/Attack.glb','idle'],['Walking_Backwards','','walk'],
  ['RunFast','','run'],['Jogging','','run'],['Run_Attack','','attack'],
  ['Melee_Hook_Rec','','attack'],['Get_Hit','Melee/Attack.glb','other'],
  ['001_Стойка','','idle'],['Ходьба назад','','walk'],['Бег с мечом','','run'],
  ['Удар двумя кинжалами','','attack'],['Смерть','','other'],['Jump','','other']
 ])assert.equal(classifyMotion(name,path),expected,name);
 const entries=[{label:'Backwards',title:'Ходьба назад',category:'walk',path:'Walk/Backwards.glb',aliases:['Mixamo / ходьба']},{label:'Sprint',category:'run',path:'Run/Sprint.glb'}];
 assert.equal(matchesMotion(entries[0],'ходьба mixamo','walk'),true);assert.equal(matchesMotion(entries[0],'','run'),false);assert.equal(matchesMotion(entries[0],'nothing'),false);
 assert.deepEqual(categoryCounts(entries),{all:2,idle:0,walk:1,run:1,attack:0,other:0});
 assert.equal(matchesMotion({...entries[0],family:'monster'},'','walk','humanoid'),false);assert.equal(matchesMotion({...entries[0],family:'monster'},'','walk','monster'),true);assert.equal(motionFamily({path:'monster_Dragon.glb'}),'monster');
});

test('building strips all meshes and images, deduplicates copies and retains different keys',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'forge-library-'));
 try{
  const {doc,bytes}=await motionFixture(),variant=doc.getRoot().listAnimations()[1].listSamplers()[0].getOutput().getArray();variant[0]+=.01;
  const altered=await new WebIO().writeBinary(doc),input=join(temp,'packs.zip'),out=join(temp,'library');
  await writeFile(input,zipSync({'first/character.glb':bytes,'copies/character.glb':bytes,'variant/character.glb':altered}));
  const report=await buildMotionLibrary([input],out);
  assert.equal(report.sourceClips,6);assert.equal(report.uniqueClips,3);assert.equal(report.duplicates,3);assert.equal(report.warnings.length,0);
  const manifest=JSON.parse(await readFile(join(out,'index.json'),'utf8'));assert.equal(manifest.clips.length,3);assert.equal((await readdir(join(out,'clips'))).length,3);
  assert.equal(await verifyMotionLibrary(out),3);
  const bundleDir=join(temp,'bundle'),restored=join(temp,'restored'),bundle=await packMotionBundle(out,bundleDir,{partBytes:2048});assert.ok(bundle.parts.length>1);assert.equal(await unpackMotionBundle(bundleDir,restored),3);assert.equal(await verifyMotionLibrary(restored),3);
  const part=join(bundleDir,bundle.parts[0].file),bad=await readFile(part);bad[0]^=1;await writeFile(part,bad);await assert.rejects(unpackMotionBundle(bundleDir,restored),/Corrupted/);assert.equal(await verifyMotionLibrary(restored),3);
  for(const entry of manifest.clips){
   const packed=new Uint8Array(await readFile(join(out,'clips',entry.id+'.glb'))),json=inspectGlb(packed).json;
   for(const key of ['meshes','materials','images','textures'])assert.equal(json[key],undefined);
   assert.equal(json.animations.length,1);assert.equal(packed.length,entry.bytes);
   const validation=await validateBytes(packed,{maxIssues:20});assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues.messages));
   const source=await loadMotionSource({path:'motion.glb',format:'glb',size:packed.length,read:async()=>packed});assert.equal(source.clips.length,1);source.root.traverse(n=>assert.ok(!n.isMesh));
  }
  const original=await readFile(join(out,'index.json'));await buildMotionLibrary([input],out);assert.deepEqual(await readFile(join(out,'index.json')),original,'repeat builds must be deterministic');
  await assert.rejects(buildMotionLibrary([join(temp,'missing.zip')],out));assert.deepEqual(await readFile(join(out,'index.json')),original,'failed builds preserve the previous library');
  await writeFile(join(out,'clips',manifest.clips[0].id+'.glb'),new Uint8Array(manifest.clips[0].bytes));await assert.rejects(verifyMotionLibrary(out),/хеш/);
 }finally{await rm(temp,{recursive:true,force:true})}
});

test('packaged clips preserve rest transforms, stepped and cubic-spline samples',async()=>{
 for(const mode of ['STEP','CUBICSPLINE']){
  const {doc}=await motionFixture(),sampler=doc.getRoot().listAnimations()[0].listSamplers()[0];sampler.setInterpolation(mode);
  if(mode==='CUBICSPLINE'){const values=sampler.getOutput().getArray(),out=[];for(let i=0;i<values.length;i+=4)out.push(0,0,0,0,...values.slice(i,i+4),0,0,0,0);sampler.getOutput().setArray(new Float32Array(out))}
  const bytes=await new WebIO().writeBinary(doc),source=await loadMotionSource({format:'glb',path:'test.glb',size:bytes.length,read:async()=>bytes}),packed=encodeMotionGlb(source,source.clip),result=await loadMotionSource({format:'glb',path:'packed.glb',size:packed.length,read:async()=>packed});
  const arm=source.skeleton.bones.find(b=>b.name==='Arm'),copy=result.skeleton.bones.find(b=>b.name==='Arm');assert.ok(arm.quaternion.angleTo(copy.quaternion)<1e-6);assert.deepEqual(arm.position.toArray(),copy.position.toArray());
  const a=source.clip.tracks[0].createInterpolant(),b=result.clip.tracks[0].createInterpolant();for(const time of [0,.185,.36,.37,.8,1])assert.ok(new THREE.Quaternion().fromArray(a.evaluate(time)).angleTo(new THREE.Quaternion().fromArray(b.evaluate(time)))<.001,mode+' at '+time);
 }
});

test('identical key data in different character groups remains available in both libraries',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'forge-families-'));try{
  const {bytes}=await motionFixture(),input=join(temp,'both.zip'),out=join(temp,'library');await writeFile(input,zipSync({'human.glb':bytes,'monster_Dragon.glb':bytes}));
  const report=await buildMotionLibrary([input],out);assert.deepEqual(report.families,{humanoid:2,monster:2});assert.equal(report.uniqueClips,4);
  const manifest=JSON.parse(await readFile(join(out,'index.json'),'utf8'));for(const family of ['humanoid','monster'])assert.equal(manifest.clips.filter(c=>c.family===family).length,2);
 }finally{await rm(temp,{recursive:true,force:true})}
});

test('opening the embedded catalog fetches only metadata; reading one clip supports cancellation',async()=>{
 const id='a'.repeat(64),body=new Uint8Array(32),manifest={version:1,clips:[{id,title:'Walk',category:'walk',duration:1,bytes:body.length}]},calls=[];
 const entries=await openEmbeddedMotions({fetcher:async(url,options)=>{calls.push({url,options});return new Response(url.endsWith('.json')?JSON.stringify(manifest):body)}});
 assert.deepEqual(calls.map(c=>c.url),['/motions/index.json']);assert.equal(entries.length,1);
 const controller=new AbortController();assert.deepEqual(await entries[0].read({signal:controller.signal}),body);assert.equal(calls.length,2);assert.equal(calls[1].url,'/motions/clips/'+id+'.glb');assert.equal(calls[1].options.signal,controller.signal);
 await assert.rejects(entries[0].resource('https://example.invalid/data.bin'),/не нужны/);
 let signal;await assert.rejects(loadMotionSource({...entries[0],read:async options=>{signal=options.signal;controller.abort();return body}},{signal:controller.signal}),e=>e.name==='AbortError');assert.equal(signal,controller.signal);
});

test('invalid manifests, remote paths, duplicate IDs and truncated assets fail explicitly',async()=>{
 const valid={id:'a'.repeat(64),title:'Idle',category:'idle',duration:1,bytes:32};
 for(const clips of [[{...valid,id:'https://example.invalid/x'}],[{...valid,category:'nonsense'}],[valid,valid],[{...valid,bytes:999999999}],[]])await assert.rejects(openEmbeddedMotions({fetcher:async()=>new Response(JSON.stringify({version:1,clips}))}));
 await assert.rejects(openEmbeddedMotions({fetcher:async()=>new Response('',{status:404})}),/404/);
 const [entry]=await openEmbeddedMotions({fetcher:async url=>new Response(url.endsWith('.json')?JSON.stringify({version:1,clips:[valid]}):new Uint8Array(8))});await assert.rejects(entry.read(),/размер/);
});

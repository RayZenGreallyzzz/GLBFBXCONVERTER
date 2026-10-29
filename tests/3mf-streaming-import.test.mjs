import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {exportTextured3mf} from '../src/three-mf.js';
import {importStreaming3mf} from '../src/three-mf-import.js';
import {modelStats} from '../src/format.js';

test('3MF import/export opens a textured model, restores UV, triangles and dimensions',async()=>{
 const png=new THREE.DataTexture(new Uint8Array([
  255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255
 ]),2,2,THREE.RGBAFormat);
 png.flipY=false;png.needsUpdate=true;
 const original=new THREE.Group();
 const cube=new THREE.Mesh(new THREE.BoxGeometry(1,2,3),
  new THREE.MeshStandardMaterial({map:png}));
 original.add(cube);
 const encoded=await exportTextured3mf(original,{unitScale:1000});
 const progress=[];
 const decoded=await importStreaming3mf(encoded.content,{
  loadTextures:false,onProgress:x=>progress.push(x)});
 assert.equal(decoded.triangles,12);
 assert.equal(decoded.textures,1);
 const box=new THREE.Box3().setFromObject(decoded.root);
 const dims=box.getSize(new THREE.Vector3());
 assert.ok(Math.abs(dims.x-1)<1e-5);
 assert.ok(Math.abs(dims.y-2)<1e-5);
 assert.ok(Math.abs(dims.z-3)<1e-5);
 assert.equal(decoded.root.children[0].geometry.getAttribute('uv').count,24);
 assert.ok(progress.includes(100));
});

test('huge textured 3MF parses geometry without allocating full XML DOM (121,000 faces)',async()=>{
 const faceCount=121000,geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.Float32BufferAttribute([
  0,0,0,1,0,0,0,1,0,1,1,0
 ],3));
 const idx=new Uint32Array(faceCount*3);
 for(let i=0;i<faceCount;i++){idx[3*i]=0;idx[3*i+1]=1;idx[3*i+2]=(i&1)?2:3}
 geometry.setIndex(new THREE.BufferAttribute(idx,1));
 const src=new THREE.Group();src.add(new THREE.Mesh(geometry,
  new THREE.MeshStandardMaterial()));
 const encoded=await exportTextured3mf(src);
 const decoded=await importStreaming3mf(encoded.content,{loadTextures:false});
 assert.equal(decoded.triangles,faceCount);
 const stats=modelStats(decoded.root,[]);
 assert.equal(stats.triangles,faceCount);
 assert.equal(stats.vertices,4);
 assert.equal(decoded.root.children[0].geometry.index.array.length,faceCount*3);
});
test('3MF corrupt ZIP does not silently produce an empty scene',async()=>{
 await assert.rejects(importStreaming3mf(new Uint8Array([1,2,3,4])),/ZIP-заголовок/);
});
test('Android UI uses streaming 3MF importer and does not call ThreeMFLoader',async()=>{
 const {readFileSync}=await import('node:fs');
 const main=readFileSync('src/main.js','utf8');
 const formats=readFileSync('src/model-formats.js','utf8');
 assert.match(main,/await importStreaming3mf\(data,\{onProgress:/);
 assert.match(main,/state\.sourceBuffer=\['glb','vrm','3mf'\]/);
 assert.match(main,/target==='3mf'&&state\.type==='3mf'/);
 assert.ok(!formats.includes('new ThreeMFLoader().parse(data)'));
});

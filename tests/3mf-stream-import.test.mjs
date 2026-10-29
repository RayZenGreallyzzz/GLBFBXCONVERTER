import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {exportTextured3mf} from '../src/three-mf.js';
import {importLarge3mf} from '../src/3mf-stream-import.js';
import {importAdditional} from '../src/model-formats.js';

test('streamed 3MF re-opens its actual exported mesh with exact triangle count, no DOM',async()=>{
 const root=new THREE.Group();
 const geo=new THREE.BoxGeometry(1,2,3);
 const node=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:0xee77aa}));
 node.name='FoxGiMini';root.add(node);
 const saved=await exportTextured3mf(root,{name:'FoxGiMini',unitScale:1000});
 const seen=[];
 const opened=await importLarge3mf(saved.content,{onProgress:p=>seen.push(p)});
 const output=opened.root.children[0].geometry;
 assert.equal(opened.root.children.length,1);
 assert.equal(opened.root.children[0].name,'FoxGiMini');
 assert.equal(output.index.count/3,12);
 assert.equal(output.getAttribute('position').count,24);
 assert.equal(output.index.getX(0),geo.index.getX(0));
 assert.equal(seen.at(-1),100);
 assert.ok(Math.abs(output.getAttribute('position').getX(0)-geo.getAttribute('position').getX(0))<1e-6);
});
test('streamer supports multiple meshes and keeps names/face indices separated',async()=>{
 const root=new THREE.Group();
 for(const name of ['Tree','Fox']){
   const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial());
   mesh.name=name;mesh.position.set(name==='Tree'?4:0,0,0);root.add(mesh);
 }
 const saved=await exportTextured3mf(root,{name:'scene'});
 const out=await importLarge3mf(saved.content);
 assert.equal(out.root.children.length,2);
 assert.equal(out.root.children[0].name,'Tree');
 assert.equal(out.root.children[1].name,'Fox');
 assert.equal(out.root.children[1].geometry.index.count/3,12);
});
test('streamer reads heavy poly meshes without forcing 650k face limit or giant DOM',async()=>{
 const geo=new THREE.BufferGeometry();
 geo.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
 const count=80000,index=new Uint32Array(count*3);
 for(let i=0;i<count;i++){index[i*3]=0;index[i*3+1]=1;index[i*3+2]=2;}
 geo.setIndex(new THREE.BufferAttribute(index,1));
 const root=new THREE.Group();root.add(new THREE.Mesh(geo,new THREE.MeshBasicMaterial()));
 const packed=await exportTextured3mf(root);
 const opened=await importLarge3mf(packed.content);
 assert.equal(opened.root.children[0].geometry.index.count,count*3);
});
test('format loader routes 3MF to its importer and main UI surfaces progress',async()=>{
 const {readFileSync}=await import('node:fs');
 const formats=readFileSync('src/model-formats.js','utf8');
 const main=readFileSync('src/main.js','utf8');
 assert.match(formats,/bytes\.byteLength>=10\*1048576/);
 assert.match(formats,/importLarge3mf\(data,\{onProgress:options\.onProgress\}\)/);
 assert.match(main,/3MF: открываем геометрию и текстуры/);
});

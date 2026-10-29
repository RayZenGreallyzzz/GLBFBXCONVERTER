import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {exportTextured3mf} from '../src/three-mf.js';
import {importLarge3mf} from '../src/3mf-stream-import.js';
import {make3mfLightPreview,dispose3mfLightPreview} from '../src/3mf-preview.js';
import {simplify3mfScene,release3mfSimplifiedGeometry} from '../src/3mf-optimize.js';

function fixture(){
  const root=new THREE.Group();
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute([
    0,0,0, 1,0,0, 1,1,0, 0,1,0
  ],3));
  const indices=new Uint32Array(120000);
  for(let i=0;i<40000;i++){
    indices[i*3]=0;indices[i*3+1]=i%2?1:2;indices[i*3+2]=3;
  }
  g.setIndex(new THREE.BufferAttribute(indices,1));
  root.add(new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0x92caff})));
  return root;
}

test('3MF importer consumes File/Blob slices and never reads the entire compressed file',async()=>{
  const original=fixture();
  const packed=await exportTextured3mf(original,{name:'Memory Test'});
  const file=new Blob([packed.content],{type:'model/3mf'});
  // A whole-file read must fail. Slices remain legal and readable.
  Object.defineProperty(file,'arrayBuffer',{value:async()=>{
    throw Error('WHOLE FILE read is forbidden');
  }});
  const progress=[];
  const parsed=await importLarge3mf(file,{onProgress:p=>progress.push(p)});
  assert.equal(parsed.root.children.length,1);
  assert.equal(parsed.root.children[0].geometry.index.count,120000);
  assert.equal(parsed.root.children[0].geometry.getAttribute('position').count,4);
  assert.equal(progress.at(-1),100);
});

test('preview samples entire mesh and leaves export indices/vertices untouched',()=>{
  const original=fixture(),mesh=original.children[0],geo=mesh.geometry;
  const originalIndex=geo.getIndex(),position=geo.getAttribute('position');
  const preview=make3mfLightPreview(original,25);
  const sample=preview.children[0].geometry;
  assert.equal(preview.userData.sourceFaces,40000);
  assert.equal(preview.userData.displayFaces,10000);
  assert.equal(sample.getIndex().count,30000);
  assert.strictEqual(sample.getAttribute('position'),position);
  assert.strictEqual(geo.getIndex(),originalIndex);
  assert.equal(geo.index.count,120000,'export mesh must never be decimated');
  assert.ok(sample.index.getX(29997)>=0);
  dispose3mfLightPreview(preview);
  assert.equal(geo.index.count,120000);
});

test('3MF preview selector does not change existing GLB optimizer presets',()=>{
  const fs=requireFile();
  assert.match(fs.html,/id="view-quality"/);
  for(const n of ['10','25','50','100'])
    assert.match(fs.html,new RegExp('value="'+n+'"'));
  assert.match(fs.js,/set3mfViewQuality\(ext==='3mf'&&faces>350000\?25:100\)/);
  assert.match(fs.js,/viewProxyRoot/);
  assert.match(fs.js,/exportAdditional\(target,exportRoot,state.clips/);
});
function requireFile(){
  return {html:readFileSync('index.html','utf8'),js:readFileSync('src/main.js','utf8')};
}
import {readFileSync} from 'node:fs';

test('3MF optimization is real UV-preserving mesh simplification, not deleting faces',async()=>{
 const root=new THREE.Group();
 const original=new THREE.SphereGeometry(1,48,30);
 const faceCount=original.index.count/3,vertexCount=original.getAttribute('position').count;
 root.add(new THREE.Mesh(original,new THREE.MeshBasicMaterial({color:0xccbbee})));
 const out=await simplify3mfScene(root,{ratio:.5,error:.2});
 const geo=out.root.children[0].geometry;
 assert.equal(out.sourceTriangles,faceCount);
 assert.ok(out.optimizedTriangles>0);
 assert.ok(out.optimizedTriangles<faceCount,'meshoptimizer must reduce triangle count');
 assert.equal(geo.getAttribute('uv').count,geo.getAttribute('position').count);
 assert.ok(geo.getAttribute('position').count<=vertexCount);
 for(const i of geo.index.array)assert.ok(i<geo.getAttribute('position').count);
 assert.equal(original.index.count/3,faceCount,'source is not edited');
 release3mfSimplifiedGeometry(out.root);
});

test('main 3MF optimization avoids full-size GLB intermediate',()=>{
 const js=readFileSync('src/main.js','utf8');
 assert.match(js,/if\(state.type==='3mf'\)/);
 assert.match(js,/simplify3mfScene\(state.root/);
 assert.match(js,/release3mfSimplifiedGeometry\(prepared.root\)/);
});

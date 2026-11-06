import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {MorphPreview} from '../src/morph-preview.js';
function model(){const root=new THREE.Group();for(const weights of [[.2,.05],[0,.75]]){const m=new THREE.Mesh(new THREE.BufferGeometry());m.morphTargetInfluences=weights.slice();m.morphTargetDictionary={Smile:0,Blink:1};root.add(m)}return root}
test('manual expressions combine independently per instance and mirror the comparison graph',()=>{
 const a=model(),b=model(),p=new MorphPreview();p.setModels(a,b);p.setWeight(0,0,.7);p.setWeight(0,1,.9);
 assert.deepEqual(a.children[0].morphTargetInfluences,[.7,.9]);assert.deepEqual(b.children[0].morphTargetInfluences,[.7,.9]);assert.deepEqual(a.children[1].morphTargetInfluences,[0,.75]);
 p.setWeight(1,0,-.25);assert.deepEqual(b.children[1].morphTargetInfluences,[-.25,.75]);p.reset();assert.deepEqual(a.children[0].morphTargetInfluences,[.2,.05]);assert.deepEqual(b.children[1].morphTargetInfluences,[0,.75]);
 p.setWeight(0,0,1);p.setModels(null);assert.deepEqual(a.children[0].morphTargetInfluences,[.2,.05]);assert.equal(p.entries.length,0);
});
test('incompatible shape layouts are read-only and invalid weights never modify a model',()=>{
 const a=model(),b=model(),p=new MorphPreview();b.children[0].morphTargetDictionary={Other:0,Blink:1};p.setModels(a,b);assert.equal(p.compatible,false);assert.throws(()=>p.setWeight(0,0,1),/Неверная/);assert.deepEqual(a.children[0].morphTargetInfluences,[.2,.05]);
 p.setModels(a);for(const value of [NaN,Infinity])assert.throws(()=>p.setWeight(0,0,value),/Неверная/);p.dispose();assert.equal(p.entries.length,0);
});

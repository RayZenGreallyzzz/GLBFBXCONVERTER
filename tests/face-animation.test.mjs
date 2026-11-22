import assert from 'node:assert/strict';
import test from 'node:test';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Vector3} from 'three';
import validator from 'gltf-validator';
import {FaceTimeline,appendFaceClip,appendMouthShapes} from '../src/face-animation.js';
import {MouthShapeDraft} from '../src/mouth-shapes.js';
import {jointGlb} from '../src/joint-glb.js';
import {morphFixture} from './helpers/morph-fixture.mjs';
import {mouthFixture} from './helpers/mouth-fixture.mjs';

async function validate(bytes) {
  const result=await validator.validateBytes(bytes);
  assert.equal(result.issues.numErrors,0,JSON.stringify(result.issues.messages.filter(m=>m.severity===0)));
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6, a+' differs from '+b);

test('face keys blend with existing cubic channels and preserve original clips and BIN',async()=>{
  const original=await morphFixture({segments:6});
  const glb=jointGlb(original), {json}=glb;
  const body=json.animations.findIndex(a=>a.name==='Face_CUBICSPLINE');
  const edit=new FaceTimeline(glb,body,1), [node]=edit.shapes.keys();
  edit.set(node,0,0,.2);
  edit.set(node,0,.4,.9);
  edit.set(node,0,1,0);
  near(edit.sample(node,.2)[0],.55);
  near(edit.sample(node,.4)[1],.8);
  const result=appendFaceClip(original,edit,'Face updated');
  const saved=jointGlb(result);
  assert.deepEqual(saved.json.animations.slice(0,-1),json.animations);
  assert.deepEqual(saved.bin.subarray(0,glb.bin.length),glb.bin);
  const {samplers,channels}=saved.json.animations.at(-1);
  const track=samplers[channels.find(c=>c.target.node===node&&c.target.path==='weights').sampler];
  const times=saved.read(track.input), values=saved.read(track.output), at=times.indexOf(Math.fround(.4));
  near(values[at*2],.9);
  near(values[at*2+1],.8);
  edit.remove(node,0,.4);
  near(edit.sample(node,.2)[0],.16);
  await validate(result);
});

test('mouth template moves the jaw only and a brush can remove influence',async()=>{
  const bytes=await mouthFixture(), glb=jointGlb(bytes);
  const {scene}=await new GLTFLoader().parseAsync(bytes.buffer,'');
  const mesh=scene.getObjectByName('DemonFixture');
  const draft=new MouthShapeDraft(scene,mesh,'+Z'), forms=draft.forms(20,13);
  assert.ok(forms[0].position[1]>.01&&forms[1].position[1]<-.006);
  assert.ok(forms.every(f=>f.position.subarray(9).every(x=>x===0)));
  const at=new Vector3().fromArray(draft.points);
  assert.equal(draft.paint(at,.016,1,false),1);
  assert.ok(draft.forms(20,13)[0].position.subarray(0,3).every(x=>x===0));
  const updated=appendMouthShapes(bytes,0,forms), saved=jointGlb(updated);
  assert.deepEqual(saved.json.meshes[0].extras.targetNames,['MouthClose','MouthOpen']);
  assert.deepEqual(saved.json.nodes,glb.json.nodes);
  assert.deepEqual(saved.bin.subarray(0,glb.bin.length),glb.bin);
  await validate(updated);
});

test('adding mouth shapes to an existing expression mesh extends existing keys',async()=>{
  const original=await morphFixture({rigged:false,segments:5}), source=jointGlb(original);
  const node=source.json.nodes.findIndex(n=>n.mesh!==undefined);
  const primitive=source.json.meshes[source.json.nodes[node].mesh].primitives[0];
  const position=new Float32Array(source.json.accessors[primitive.attributes.POSITION].count*3);
  position[1]=.01;
  const next=appendMouthShapes(original,node,[{position},{position}]), output=jointGlb(next);
  const before=new FaceTimeline(source,3,1), after=new FaceTimeline(output,3,1);
  for(const t of [0,.15,.4,1]){
    const weights=after.sample(node,t);
    assert.deepEqual(weights,[...before.sample(node,t),0,0]);
  }
  await validate(next);
});

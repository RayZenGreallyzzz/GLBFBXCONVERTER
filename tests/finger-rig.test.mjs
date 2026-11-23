import assert from 'node:assert/strict';
import test from 'node:test';
import {AnimationMixer, Bone, Quaternion, QuaternionKeyframeTrack, AnimationClip, Vector3} from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import validator from 'gltf-validator';
import {buildFingerRig,draftFingerRig,fingerRigEligibility} from '../src/finger-rig.js';
import {jointGlb} from '../src/joint-glb.js';
import {openSkinDocument} from '../src/skin-document.js';
import {jointCorrectionEligibility} from '../src/joint-policy.js';
import {suggestBoneMappings} from '../src/animation-retarget.js';
import {autoAdaptBvhClip} from '../src/bvh-auto-adapt.js';
import {fingerFixture} from './helpers/finger-fixture.mjs';

async function read(bytes) {
  const model=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length),'');
  model.scene.updateMatrixWorld(true);
  return model;
}
const meshOf=({scene})=>scene.getObjectByProperty('isSkinnedMesh',true);

test('adds 30 independent phalanges and preserves the original clip and skin motion',async()=>{
  const {bytes,draft}=await fingerFixture(), source=jointGlb(bytes);
  const proposed=draftFingerRig(bytes);
  assert.equal(Object.keys(proposed.hands).length,2);
  assert.ok(proposed.hands.left.fingers.Thumb.points.every(p=>p.every(Number.isFinite)));
  const result=buildFingerRig(bytes,{draft});
  assert.equal(result.added,30);
  const saved=jointGlb(result.bytes);
  assert.deepEqual(saved.json.animations,source.json.animations);
  assert.deepEqual(saved.bin.subarray(0,source.bin.length),source.bin);
  assert.equal(saved.json.skins[0].joints.length,57);
  assert.equal(fingerRigEligibility(result.bytes).eligible,false);
  assert.ok(jointCorrectionEligibility(result.bytes).eligible);
  const report=await validator.validateBytes(result.bytes);
  assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues.messages.filter(m=>m.severity===0)));
  const [old,model]=await Promise.all([read(bytes),read(result.bytes)]), m=meshOf(model), original=meshOf(old);
  assert.ok(openSkinDocument(result.bytes).bones.some(b=>b.name==='mixamorigLeftHandIndex2'));
  const movers=new Set(['mixamorigLeftHandIndex1','mixamorigLeftHandIndex2','mixamorigLeftHandIndex3']);
  const index=m.geometry.getAttribute('skinIndex'), weight=m.geometry.getAttribute('skinWeight');
  const tagged=(i)=>[0,1,2,3].some(k=>weight.getComponent(i,k)>.1&&movers.has(m.skeleton.bones[index.getComponent(i,k)].name));
  const take=(mesh,i)=>mesh.getVertexPosition(i,new Vector3());
  for (const obj of [old,model]) {
    const mixer=new AnimationMixer(obj.scene);mixer.clipAction(obj.animations[0]).play();mixer.setTime(.6);obj.scene.updateMatrixWorld(true);
  }
  const positions=Array.from({length:index.count},(_,i)=>take(m,i));
  for (const [i,p] of positions.entries()) assert.ok(p.distanceTo(take(original,i))<1e-5,'existing animation changed');
  const finger=model.scene.getObjectByName('mixamorigLeftHandIndex1');
  finger.rotateX(.8);model.scene.updateMatrixWorld(true);
  let moved=0;
  for (const [i,p] of positions.entries()) {
    const d=p.distanceTo(take(m,i));
    if (tagged(i)&&d>.01) moved++;
    if ([0,1,2,3].every(k=>!movers.has(m.skeleton.bones[index.getComponent(i,k)].name)))
      assert.ok(d<1e-7,'a neighboring finger moved');
  }
  assert.ok(moved>20);
});

test('supports a single selected digit and retargets its curve from a different naming style',async()=>{
  const {bytes,draft}=await fingerFixture();
  for (const [side,hand] of Object.entries(draft.hands)) for (const [name,f] of Object.entries(hand.fingers))
    f.enabled=side==='left'&&name==='Index';
  const result=buildFingerRig(bytes,{draft}), target=await read(result.bytes);
  assert.equal(result.added,3);
  assert.equal(target.scene.getObjectByName('mixamorigLeftHandIndex1').parent.name,'mixamorigLeftHand');
  const sourceHand=new Bone(), sourceFinger=new Bone();
  sourceHand.name='hand_l';sourceFinger.name='index_01_l';sourceHand.add(sourceFinger);
  sourceFinger.position.set(.1,0,.03);
  const skeleton={bones:[sourceHand,sourceFinger]};
  const mappings=suggestBoneMappings(skeleton,target.scene).mappings;
  assert.equal(mappings[1].target,'mixamorigLeftHandIndex1');
  const q=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.8);
  const source=new AnimationClip('Pinch',1,[new QuaternionKeyframeTrack('index_01_l.quaternion',[0,1],[0,0,0,1,...q.toArray()])]);
  const retarget=autoAdaptBvhClip({targetRoot:target.scene,sourceSkeleton:skeleton,sourceClip:source,mappings,referencePose:'rest',trimCalibration:false});
  const track=retarget.tracks.find(t=>t.name==='mixamorigLeftHandIndex1.quaternion');
  assert.ok(track);
  assert.ok(new Quaternion().fromArray(track.values).angleTo(new Quaternion().fromArray(track.values,track.values.length-4))>.7);
});

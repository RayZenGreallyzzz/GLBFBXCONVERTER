import assert from 'node:assert/strict';
import test from 'node:test';
import {AnimationClip, Bone, Group, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3, VectorKeyframeTrack} from 'three';
import {MotionPoseEditor} from '../src/motion-pose-editor.js';

function rig() {
  const root = new Group(), mesh = new SkinnedMesh(), bones = {};
  const joint = (name, parent, x, y, z = 0) => {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    parent.add(bone);
    bones[name] = bone;
    return bone;
  };
  const hips = joint('Hips', root, 0, 1);
  const chest = joint('Chest', hips, 0, 1);
  const head = joint('Head', chest, 0, .25);
  joint('Jaw', head, 0, 0, .1);
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    const shoulder = joint(side+'Shoulder', chest, sign*.3, 0);
    shoulder.rotation.y = sign*.4;
    const arm = joint(side+'Arm', shoulder, sign*.1, 0);
    joint(side+'ForeArm', arm, 0, -.4);
    const hip = joint(side+'UpLeg', hips, sign*.15, 0);
    joint(side+'Leg', hip, 0, -.5);
  }
  const arm = bones.LeftArm;
  joint('rig_volume_upperarm_l', arm.parent, ...arm.position.toArray());
  root.add(mesh);
  root.rotation.y = .67;
  root.updateMatrixWorld(true);
  mesh.bind(new Skeleton(Object.values(bones)));
  return {root, bones};
}

function rotationAt(clip, name, time) {
  const track = clip.tracks.find(track => track.name === name+'.quaternion');
  return new Quaternion().fromArray(track.createInterpolant().evaluate(time));
}

test('outward pose rotates both arms and both thighs away from the body on a rotated rig', () => {
  const {root, bones} = rig();
  const editor = new MotionPoseEditor(root,new AnimationClip('Idle',1,[]));
  const sideAxis = new Vector3(1,0,0).applyQuaternion(root.quaternion);
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    for (const [upper, lower] of [['Arm','ForeArm'],['UpLeg','Leg']]) {
      const name = side+upper, bone = bones[name], end = bones[side+lower];
      const before = end.getWorldPosition(new Vector3()).sub(bone.getWorldPosition(new Vector3()));
      editor.setWholeClip(name,[30,0,0,0]);
      const posed = rotationAt(editor.build(),name,.5);
      assert.ok(bone.quaternion.equals(new Quaternion()),'building a clip must not modify the model');
      bone.quaternion.copy(posed);
      const after = end.getWorldPosition(new Vector3()).sub(bone.getWorldPosition(new Vector3()));
      assert.ok(after.dot(sideAxis)*sign > before.dot(sideAxis)*sign + .15);
      assert.ok(Math.abs(before.length()-after.length()) < 1e-6);
      bone.quaternion.identity();
    }
  }
});

test('pose keys retain original tracks, interpolate and can be removed', () => {
  const {root} = rig();
  const positions = new VectorKeyframeTrack('Hips.position',[0,1],[0,1,0,0,1,.5]);
  const arm = new QuaternionKeyframeTrack('LeftArm.quaternion',[0,1],[0,0,0,1,0,0,0,1]);
  const clip = new AnimationClip('Walk',1,[positions,arm]);
  const editor = new MotionPoseEditor(root,clip);
  editor.setKey('LeftArm',.45,[60,0,0,0]);
  const edited = editor.build(), rest = new Quaternion();
  assert.equal(edited.name,clip.name);
  assert.equal(edited.duration,1);
  assert.equal(edited.tracks[0],positions);
  assert.ok(Math.abs(rest.angleTo(rotationAt(edited,'LeftArm',.45))-Math.PI/3)<1e-6);
  assert.ok(rotationAt(edited,'LeftArm',0).equals(rest));
  assert.ok(rotationAt(edited,'LeftArm',1).equals(rest));
  assert.ok(Math.abs(rest.angleTo(rotationAt(edited,'LeftArm',.225))-Math.PI/6)<1e-5);
  assert.ok(Math.abs(rest.angleTo(rotationAt(edited,'rig_volume_upperarm_l',.45))-Math.PI/6)<1e-6);
  editor.removeKey('LeftArm',.45);
  assert.equal(editor.build(),clip);
  editor.setWholeClip('Jaw',[0,20,0,0]);
  assert.ok(Math.abs(rest.angleTo(rotationAt(editor.build(),'Jaw',.5))-Math.PI/9)<1e-6);
});

test('a key next to an original frame produces distinct export times', () => {
  const {root} = rig();
  const arm = new QuaternionKeyframeTrack('LeftArm.quaternion',[0,.0333333,.0666666],[0,0,0,1,0,0,0,1,0,0,0,1]);
  const editor = new MotionPoseEditor(root,new AnimationClip('Turn',-1,[arm]));
  editor.setKey('LeftArm',.033333,[30,0,0,0]);
  const pose = editor.build();
  const times = pose.tracks.find(track => track.name === arm.name).times;
  assert.deepEqual([...times],[0,Math.fround(.033333),Math.fround(.0666666)]);
  assert.ok(Math.abs(new Quaternion().angleTo(rotationAt(pose,'LeftArm',.033333))-Math.PI/6)<1e-6);
});

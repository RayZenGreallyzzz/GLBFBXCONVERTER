import {AnimationClip, Euler, MathUtils, PropertyBinding, Quaternion, QuaternionKeyframeTrack, Vector3} from 'three';
import {canonicalBone, characterBones, findCanonicalBone} from './animation-retarget.js';
import {volumeBonePairs} from './motion-volume-bones.js';

export const limbLabels = {
  leftarm:'Левое плечо', rightarm:'Правое плечо',
  leftupleg:'Левое бедро', rightupleg:'Правое бедро',
  leftforearm:'Левый локоть', rightforearm:'Правый локоть',
  leftleg:'Левое колено', rightleg:'Правое колено',
  lefthand:'Левая кисть', righthand:'Правая кисть',
  leftfoot:'Левая стопа', rightfoot:'Правая стопа'
};

function restOutwardAxes(bones) {
  const find = role => findCanonicalBone(bones, role);
  const hips = find('hips'), chest = find('spine2') || find('spine1') || find('spine') || find('head');
  const world = bone => bone.getWorldPosition(new Vector3());
  const up = hips && chest ? world(chest).sub(world(hips)).normalize() : new Vector3();
  const axes = new Map();
  for (const part of ['arm', 'upleg']) {
    const left = find('left' + part), right = find('right' + part);
    if (!left || !right) continue;
    const forward = world(left).sub(world(right)).normalize().cross(up).normalize();
    if (forward.lengthSq() < .5) continue;
    for (const [bone, sign] of [[left, 1], [right, -1]]) {
      if (!bone.parent) continue;
      const inverseParent = bone.parent.getWorldQuaternion(new Quaternion()).invert();
      axes.set(bone.name, forward.clone().multiplyScalar(sign).applyQuaternion(inverseParent));
    }
  }
  return axes;
}

const neutral = Object.freeze([0, 0, 0, 0]);
const minimumSampleGap = 1e-5;

function orderedKeys(keys, duration) {
  return [...new Map([[0, neutral], [duration, neutral], ...(keys || [])])].sort(([a], [b]) => a - b);
}

function offsetsAt(keys, time) {
  const right = keys.findIndex(([t]) => t >= time);
  if (right <= 0) return keys[right === 0 ? 0 : keys.length - 1][1];
  const [a, start] = keys[right - 1], [b, end] = keys[right];
  return start.map((value, i) => MathUtils.lerp(value, end[i], (time - a) / (b - a)));
}

function poseTimes(tracks, keys, recorded) {
  const times = new Map();
  for (const track of tracks) for (const time of track?.times || []) times.set(time, 1);
  for (const [time] of keys) times.set(time, recorded.has(time) ? 3 : 2);
  const duration = keys.at(-1)[0];
  const rate = Math.min(30, 5400 / (duration || 1), Math.max(0, 18000 - times.size) / (duration || 1));
  for (let i = 0; i < keys.length; i++) {
    const [time, offsets] = keys[i];
    if (!i) continue;
    const [start, earlier] = keys[i - 1];
    if (offsets.every((value, axis) => value === earlier[axis])) continue;
    for (let j = Math.floor(start * rate) + 1; j < time * rate; j++) {
      const sample = Math.fround(j / rate);
      if (!times.has(sample)) times.set(sample, 0);
    }
  }
  const result = [];
  for (const time of [...times.keys()].sort((a, b) => a - b)) {
    const previous = result.at(-1);
    // Keep the user's key when it falls on a frame already present in the
    // source. Near-duplicate times can collapse when converted to FBX.
    if (previous === undefined || time - previous >= minimumSampleGap) result.push(time);
    else if (times.get(time) > times.get(previous)) result[result.length - 1] = time;
  }
  return result;
}

export class MotionPoseEditor {
  constructor(root, clip) {
    this.root = root;
    this.clip = clip;
    this.duration = Math.fround(clip.duration);
    const joints = new Set();
    root.traverse(node => { if (node.isSkinnedMesh) for (const bone of node.skeleton.bones) joints.add(bone); });
    const names = characterBones(root).filter(bone => bone.name);
    const counts = new Map();
    for (const {name} of names) counts.set(name, (counts.get(name) || 0) + 1);
    this.bones = new Map(names.filter(bone => joints.has(bone) && counts.get(bone.name) === 1).map(bone => [bone.name, bone]));
    this.rest = new Map([...this.bones].map(([name, bone]) => [name, bone.quaternion.clone().normalize()]));
    this.outward = restOutwardAxes([...this.bones.values()]);
    this.helpers = new Map();
    for (const {driver, helper} of volumeBonePairs(root)) {
      if (this.bones.get(driver.name) !== driver || this.bones.get(helper.name) !== helper) continue;
      const helpers = this.helpers.get(driver.name) || [];
      helpers.push(helper.name);
      this.helpers.set(driver.name, helpers);
    }
    this.tracks = new Map();
    for (const track of clip.tracks) {
      const binding = PropertyBinding.parseTrackName(track.name);
      if (binding.propertyName !== 'quaternion') continue;
      const name = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName;
      this.tracks.set(name, track);
    }
    this.samplers = new Map([...this.tracks].map(([name, track]) => [name, track.createInterpolant()]));
    this.keys = new Map();
  }

  time(value) {
    return Math.fround(MathUtils.clamp(value, 0, this.duration));
  }

  offsets(name, time) {
    return offsetsAt(orderedKeys(this.keys.get(name), this.duration), this.time(time));
  }

  setKey(name, time, offsets) {
    const keys = this.keys.get(name) || new Map();
    const sample = this.time(time);
    for (const earlier of keys.keys()) if (Math.abs(earlier - sample) < minimumSampleGap) keys.delete(earlier);
    keys.set(sample, offsets.slice());
    this.keys.set(name, keys);
  }

  setWholeClip(name, offsets) {
    this.keys.delete(name);
    this.setKey(name, 0, offsets);
    this.setKey(name, this.duration, offsets);
  }

  removeKey(name, time) {
    const keys = this.keys.get(name);
    if (keys?.delete(this.time(time)) && !keys.size) this.keys.delete(name);
  }

  baseRotation(name, time) {
    const sampler = this.samplers.get(name);
    return sampler ? new Quaternion().fromArray(sampler.evaluate(time)).normalize() : this.rest.get(name).clone();
  }

  rotations(name, time, offsets) {
    const [out, x, y, z] = offsets.map(MathUtils.degToRad);
    const base = this.baseRotation(name, time);
    const rotation = base.clone().multiply(new Quaternion().setFromEuler(new Euler(x, y, z)));
    const axis = this.outward.get(name);
    if (out && axis) rotation.premultiply(new Quaternion().setFromAxisAngle(axis, out));
    rotation.normalize();
    const rotations = new Map([[name, rotation]]);
    const delta = new Quaternion().slerp(base.invert().multiply(rotation), .5);
    for (const helper of this.helpers.get(name) || []) {
      if (!this.keys.has(helper)) rotations.set(helper, this.baseRotation(helper, time).multiply(delta).normalize());
    }
    return rotations;
  }

  build() {
    if (!this.keys.size) return this.clip;
    const replacements = new Map();
    for (const [name, keys] of this.keys) {
      const timeline = orderedKeys(keys, this.duration);
      if (timeline.every(([, offsets]) => offsets.every(value => !value))) continue;
      const linked = [name, ...(this.helpers.get(name) || []).filter(helper => !this.keys.has(helper))];
      const times = poseTimes(linked.map(bone => this.tracks.get(bone)), timeline, keys);
      const values = new Map(linked.map(bone => [bone, new Float32Array(times.length * 4)]));
      const previous = new Map();
      times.forEach((time, i) => {
        for (const [bone, rotation] of this.rotations(name, time, offsetsAt(timeline, time))) {
          if (previous.get(bone)?.dot(rotation) < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
          rotation.toArray(values.get(bone), i * 4);
          previous.set(bone, rotation);
        }
      });
      for (const [bone, data] of values) {
        const trackName = this.tracks.get(bone)?.name || bone + '.quaternion';
        replacements.set(trackName, new QuaternionKeyframeTrack(trackName, times, data));
      }
    }
    if (!replacements.size) return this.clip;
    const tracks = this.clip.tracks.filter(track => !replacements.has(track.name)).concat([...replacements.values()]);
    const clip = new AnimationClip(this.clip.name, this.clip.duration, tracks, this.clip.blendMode);
    clip.userData = {...this.clip.userData};
    return clip;
  }
}

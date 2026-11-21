import {Quaternion} from 'three';
import {canonicalBone} from './animation-retarget.js';

const chestRoles = new Set(['spine2', 'spine1', 'spine']);
const minimumRestDifference = Math.PI / 4;
const restDotTolerance = Math.cos(Math.PI / 360);

function descendsFrom(bone, ancestor) {
  for (let parent = bone.parent; parent; parent = parent.parent) {
    if (parent === ancestor) return true;
  }
  return false;
}

function segment(from, to, reference) {
  return reference.positions.get(to).clone().sub(reference.positions.get(from)).normalize();
}

function hasArmPose(track, bone) {
  if (!track) return false;
  const cubic = !!track.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline;
  const rest = bone.quaternion.clone().normalize();
  const sample = new Quaternion();
  for (let key = 0; key < track.times.length; key++) {
    const index = cubic ? key * 12 + 4 : key * 4;
    sample.fromArray(track.values, index).normalize();
    if (Math.abs(sample.dot(rest)) < restDotTolerance) return true;
  }
  return false;
}

export function buildArmPoseCorrections(pairs, sourceRef, targetRef, alignment, rotationTracks) {
  const mapped = new Map(pairs.map(pair => [pair.to, pair.from]));
  const sourceTracks = new Map(rotationTracks.map(track => [track.name, track]));
  const corrections = new Map();

  for (const side of ['left', 'right']) {
    const joints = ['arm', 'forearm', 'hand'].map(part => {
      const role = side + part;
      return pairs.find(({from, to}) => canonicalBone(from.name) === role && canonicalBone(to.name) === role);
    });
    const [upper, forearm, wrist] = joints;
    if (joints.some(joint => !joint)) continue;
    if (!['from', 'to'].every(key => descendsFrom(wrist[key], forearm[key]) && descendsFrom(forearm[key], upper[key]))) continue;
    if (![upper.from, forearm.from].some(bone => hasArmPose(sourceTracks.get(bone.name + '.quaternion'), bone))) continue;

    const segments = [[upper, forearm], [forearm, wrist]].map(([a, b]) => ({
      from: a.from,
      to: a.to,
      sourceDirection: segment(a.from, b.from, sourceRef).applyQuaternion(alignment),
      targetDirection: segment(a.to, b.to, targetRef)
    }));
    if (segments.some(({sourceDirection, targetDirection}) => sourceDirection.lengthSq() < .9 || targetDirection.lengthSq() < .9)) continue;
    if (segments[0].sourceDirection.angleTo(segments[0].targetDirection) < minimumRestDifference) continue;

    // Anchor the arm pose to the nearest corresponding chest joint. The
    // offset rotates the target bind direction to the source bind direction,
    // so a T-pose-to-arms-down difference cannot be applied twice.
    for (let targetChest = upper.to.parent; targetChest; targetChest = targetChest.parent) {
      const sourceChest = mapped.get(targetChest);
      if (!sourceChest || !chestRoles.has(canonicalBone(targetChest.name)) ||
          !chestRoles.has(canonicalBone(sourceChest.name)) || !descendsFrom(upper.from, sourceChest)) continue;

      const chestBridge = targetRef.get(targetChest).clone().invert().multiply(alignment).multiply(sourceRef.get(sourceChest));
      const inverseAlignment = alignment.clone().invert();
      for (const {from, to, sourceDirection, targetDirection} of segments) {
        const swing = new Quaternion().setFromUnitVectors(targetDirection, sourceDirection);
        const bindOffset = sourceRef.get(from).clone().invert().multiply(inverseAlignment).multiply(swing).multiply(targetRef.get(to));
        corrections.set(to, {targetChest, sourceChest, chestBridge, bindOffset});
      }
      break;
    }
  }
  return corrections;
}

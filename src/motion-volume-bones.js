import {Quaternion, QuaternionKeyframeTrack} from 'three';
import {canonicalBone} from './animation-retarget.js';

const driverRoles = {upperarm:'arm', lowerarm:'forearm', calf:'leg'};
const volumeBonePattern = /^rig_volume_(upperarm|lowerarm|calf)_([lr])$/i;

export function volumeBonePairs(targetRoot) {
  const skins = new Set();
  targetRoot.traverse(node => { if (node.isSkinnedMesh) skins.add(node.skeleton); });
  const pairs = new Map();
  for (const {bones} of skins) {
    for (const helper of bones) {
      const match = helper.name.match(volumeBonePattern);
      if (!match || pairs.has(helper)) continue;

      const side = match[2].toLowerCase()==='l'?'left':'right';
      const role = side+driverRoles[match[1].toLowerCase()];
      const candidates = bones.filter(bone => bone.parent===helper.parent && canonicalBone(bone.name)===role);
      if (candidates.length!==1) continue;
      const [driver] = candidates;
      const length = Math.max(driver.position.length(), helper.position.length(), 1e-6);
      const rest = helper.quaternion.clone().normalize();
      const driverRest = driver.quaternion.clone().normalize();
      if (helper.position.distanceTo(driver.position)>length*1e-4 || rest.angleTo(driverRest)>.02) continue;
      pairs.set(helper,{helper,driver,rest,driverRest});
    }
  }
  return [...pairs.values()];
}

// These auxiliary joints sit alongside the main joint and follow half its
// change from bind pose. Keep explicit source animation whenever it exists.
export function buildVolumeBoneTracks(targetRoot, sourceSkeleton, tracks) {
  const namesInSource = new Set(sourceSkeleton.bones.map(bone => canonicalBone(bone.name)));
  const input = new Map(tracks.map(track => [track.name, track]));
  const output = new Map();
  for (const {helper,driver,rest,driverRest} of volumeBonePairs(targetRoot)) {
    const key = helper.name+'.quaternion', track = input.get(driver.name+'.quaternion');
    if (!track || input.has(key) || output.has(key) || namesInSource.has(canonicalBone(helper.name))) continue;
    const values = new Float32Array(track.values.length);
    const inverse = driverRest.invert();
    const delta = new Quaternion(), blended = new Quaternion();
    for (let i=0; i<values.length; i+=4) {
      delta.fromArray(track.values,i).premultiply(inverse).normalize();
      blended.identity().slerp(delta,.5).premultiply(rest).normalize().toArray(values,i);
    }
    output.set(key,new QuaternionKeyframeTrack(key,track.times.slice(),values,track.getInterpolation()));
  }
  return [...output.values()];
}

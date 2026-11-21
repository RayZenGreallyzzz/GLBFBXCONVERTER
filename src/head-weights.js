import {boneWeight, smooth} from './skin-weights.js';

export function headWeightRegion(bones, height, pivot) {
  const head = bones.find(bone => bone.name === 'mixamorigHead');
  const neck = bones.find(bone => bone.name === 'mixamorigNeck');
  if (!head || !neck || !(height > 0)) return null;
  const center = pivot || head.position;
  const direction = center.map((value, axis) => value - neck.position[axis]);
  const length = Math.hypot(...direction);
  if (length < height * .004 || direction[1] < height * .004) return null;

  return {
    head: head.id,
    neck: neck.id,
    center,
    axis: direction.map(value => value / length),
    below: Math.max(height * .014, Math.min(height * .035, length * .45)),
    above: Math.max(height * .022, Math.min(height * .052, length * .65)),
    innerRadius: height * .10,
    outerRadius: height * .19
  };
}

// Refine the existing geodesic solution near the head. The neck blends
// through the joint; the skull can turn rigidly. Only boost vertices the
// existing solution already ties to the head/neck (e.g. leave raised hands).
export function headWeightTargets(part, region, strength) {
  const targets = new Float32Array(part.positions.length / 3).fill(NaN);
  if (!region || strength === 0) return targets;
  const {head, neck, center, axis, below, above, innerRadius, outerRadius} = region;
  for (let n = 0; n < targets.length; n++) {
    const old = boneWeight(part, n, head);
    const neckWeight = boneWeight(part, n, neck);
    if (old === 0 && neckWeight <= .35) continue;
    const x = part.positions[n * 3] - center[0];
    const y = part.positions[n * 3 + 1] - center[1];
    const z = part.positions[n * 3 + 2] - center[2];
    const axial = x * axis[0] + y * axis[1] + z * axis[2];
    const radial = Math.hypot(x - axial * axis[0], y - axial * axis[1], z - axial * axis[2]);
    const influence = strength * (1 - smooth((radial - innerRadius) / (outerRadius - innerRadius)));
    const goal = smooth((axial + below) / (below + above));
    const ownership = goal > old ? smooth((old + neckWeight - .35) / .45) : 1;
    const weight = old + (goal - old) * influence * ownership;
    if (Math.abs(weight - old) > 1e-6) targets[n] = weight;
  }
  return targets;
}

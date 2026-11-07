/**
 * WeightExtractor — Converts voxel geodesic distance fields into per-vertex skin weights.
 *
 * For each mesh vertex:
 *   1. Find neighboring voxel centers
 *   2. Interpolate geodesic distances through locally connected solid cells
 *   3. Refine near bones with exact segment distances
 *   4. Keep the N closest bones (default 4, standard for real-time rendering)
 *   5. Convert distances to weights using inverse-distance with smoothing
 *   6. Normalize weights to sum to 1.0
 *
 * Output format matches the glTF/Three.js/Babylon.js skinning convention:
 *   skinIndices: 4 bone indices per vertex (Uint16Array)
 *   skinWeights: 4 weight values per vertex (Float32Array)
 *
 * @module WeightExtractor
 */

/**
 * Extract skin weights from geodesic distance fields.
 *
 * @param {VoxelGrid} grid - The classified voxel grid
 * @param {Float64Array[]} distanceFields - Per-bone distance fields from GeodesicSolver
 * @param {Float32Array|number[]} positions - Flat vertex positions [x,y,z, ...]
 * @param {Object} [options]
 * @param {number} [options.maxInfluences=4] - Max bone influences per vertex
 * @param {number} [options.smoothing=0.1] - Smoothing factor for weight falloff.
 *   Higher = smoother transitions between bone regions.
 *   Formula: w = 1 / ((1-s)*d + s*d^2)^2  where s = smoothing, d = distance
 * @param {number} [options.threshold=0.01] - Minimum weight to keep (below = zero)
 * @param {boolean} [options.interpolate=true] - Continuous, cell-centered distance sampling.
 * @param {Array<{head: number[], tail: number[]}>} [options.bones] - Bone segments
 *   for sub-voxel distance refinement. If provided, adds exact vertex-to-bone
 *   distance for higher accuracy near bone endpoints.
 * @returns {{ skinIndices: Uint16Array, skinWeights: Float32Array }}
 */
export function extractWeights(grid, distanceFields, positions, options = {}) {
  const {
    maxInfluences = 4,
    smoothing = 0.1,
    threshold = 0.01,
    bones = null,
    interpolate = true,
  } = options;

  const vertexCount = Math.floor(positions.length / 3);
  const boneCount = distanceFields.length;

  const skinIndices = new Uint16Array(vertexCount * maxInfluences);
  const skinWeights = new Float32Array(vertexCount * maxInfluences);

  // Temporary arrays for per-vertex bone sorting
  const candidates = Array.from({ length: boneCount }, (_, bone) => ({ bone, dist: Infinity }));
  const sampleIndices = new Int32Array(8);
  const sampleWeights = new Float64Array(8);
  const rawWeight = d => {
    const distance = Math.max(d, 1e-6);
    const scaled = (1 - smoothing) * distance + smoothing * distance * distance;
    return 1 / (scaled * scaled);
  };

  for (let v = 0; v < vertexCount; v++) {
    const vx = positions[v * 3];
    const vy = positions[v * 3 + 1];
    const vz = positions[v * 3 + 2];

    // Find voxel for this vertex
    const [gx, gy, gz] = grid.voxelCoords(vx, vy, vz);
    const voxelIdx = grid.index(gx, gy, gz);

    // Sub-voxel offset: distance from vertex to voxel center
    let subVoxelDist = 0;
    if (!interpolate) {
      const vCenter = grid.worldPos(gx, gy, gz);
      subVoxelDist = Math.hypot(vx - vCenter[0], vy - vCenter[1], vz - vCenter[2]);
    }

    // Cell-centered trilinear sampling removes weight steps at voxel faces.
    // Restrict the stencil to cells connected to the containing cell through
    // solid face neighbors. Nearby disconnected surfaces must not share weights.
    if (interpolate) {
      const x = (vx - grid.originX) / grid.voxelSize - .5;
      const y = (vy - grid.originY) / grid.voxelSize - .5;
      const z = (vz - grid.originZ) / grid.voxelSize - .5;
      const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
      const tx = x - x0, ty = y - y0, tz = z - z0;
      let solid = 0;
      for (let k = 0; k < 8; k++) {
        const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
        const nx = x0 + dx, ny = y0 + dy, nz = z0 + dz;
        sampleIndices[k] = grid.inBounds(nx, ny, nz) ? grid.index(nx, ny, nz) : -1;
        sampleWeights[k] = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
        if (sampleIndices[k] >= 0 && grid.state[sampleIndices[k]] !== 0) solid |= 1 << k;
      }
      const seed = (gx - x0) | ((gy - y0) << 1) | ((gz - z0) << 2);
      let connected = seed >= 0 && seed < 8 ? (1 << seed) & solid : 0;
      for (let pass = 0; pass < 7; pass++) {
        let next = connected;
        for (let k = 0; k < 8; k++) if (connected & (1 << k)) {
          next |= ((1 << (k ^ 1)) | (1 << (k ^ 2)) | (1 << (k ^ 4))) & solid;
        }
        if (next === connected) break;
        connected = next;
      }
      for (let k = 0; k < 8; k++) if (!(connected & (1 << k))) sampleWeights[k] = 0;
    }

    // Collect distance to each bone
    for (let b = 0; b < boneCount; b++) {
      let dist = distanceFields[b][voxelIdx];

      if (dist === Infinity) {
        candidates[b].bone = b;
        candidates[b].dist = Infinity;
        continue;
      }

      if (interpolate) {
        let sum = 0, total = 0;
        for (let k = 0; k < 8; k++) {
          if (sampleWeights[k] <= 0) continue;
          const d = distanceFields[b][sampleIndices[k]];
          if (Number.isFinite(d)) { sum += sampleWeights[k] * d; total += sampleWeights[k]; }
        }
        if (total > 0) dist = sum / total;
      } else dist += subVoxelDist;

      // Optional: refine with exact vertex-to-bone-segment distance
      if (bones) {
        const boneDist = pointToSegmentDist(
          vx, vy, vz,
          bones[b].head, bones[b].tail
        );
        // Blend: geodesic for topology-awareness, Euclidean for precision near the bone
        // When vertex is very close to bone, trust Euclidean more
        const blendFactor = Math.min(1, dist / (grid.voxelSize * 2));
        dist = dist * blendFactor + boneDist * (1 - blendFactor);
      }

      candidates[b].bone = b;
      candidates[b].dist = dist;
    }

    // Sort by distance (ascending) and take top N
    candidates.sort((a, b) => a.dist - b.dist);

    // Convert distances to weights
    const baseIdx = v * maxInfluences;
    let weightSum = 0;
    // A hard top-four cut also jumps when the fourth and fifth bones swap.
    // Fade influences to zero at that cutoff so the chosen set can change
    // continuously. Completely tied candidates retain the normalized tie.
    const cutoff = interpolate && boneCount > maxInfluences && Number.isFinite(candidates[maxInfluences].dist)
      ? rawWeight(candidates[maxInfluences].dist) : 0;
    const tied = cutoff > 0 && rawWeight(candidates[0].dist) - cutoff <= cutoff * 1e-12;

    for (let i = 0; i < maxInfluences; i++) {
      if (i >= boneCount || candidates[i].dist === Infinity) {
        skinIndices[baseIdx + i] = 0;
        skinWeights[baseIdx + i] = 0;
        continue;
      }

      skinIndices[baseIdx + i] = candidates[i].bone;

      const d = Math.max(candidates[i].dist, 1e-6); // avoid division by zero
      const s = smoothing;
      // Weight formula from SketchPunk Labs research:
      // w = 1 / ((1-s)*d + s*d^2)^2
      // This gives inverse-square falloff with adjustable smoothing
      const dScaled = (1 - s) * d + s * d * d;
      const w = Math.max(0, 1.0 / (dScaled * dScaled) - (tied ? 0 : cutoff));

      skinWeights[baseIdx + i] = w;
      weightSum += w;
    }

    // Normalize weights to sum to 1.0
    if (weightSum > 0) {
      for (let i = 0; i < maxInfluences; i++) {
        skinWeights[baseIdx + i] /= weightSum;
      }
    }

    // Apply threshold: zero out tiny weights and renormalize
    weightSum = 0;
    for (let i = 0; i < maxInfluences; i++) {
      if (skinWeights[baseIdx + i] < threshold) {
        skinWeights[baseIdx + i] = 0;
        skinIndices[baseIdx + i] = 0;
      } else {
        weightSum += skinWeights[baseIdx + i];
      }
    }
    if (weightSum > 0 && Math.abs(weightSum - 1.0) > 1e-6) {
      for (let i = 0; i < maxInfluences; i++) {
        skinWeights[baseIdx + i] /= weightSum;
      }
    }
  }

  return { skinIndices, skinWeights };
}

/**
 * Compute the minimum distance from a point to a line segment.
 *
 * @param {number} px, py, pz - Point
 * @param {number[]} a - Segment start [x,y,z]
 * @param {number[]} b - Segment end [x,y,z]
 * @returns {number} Distance
 */
function pointToSegmentDist(px, py, pz, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];

  const apx = px - a[0];
  const apy = py - a[1];
  const apz = pz - a[2];

  const abLenSq = abx * abx + aby * aby + abz * abz;

  if (abLenSq < 1e-10) {
    // Degenerate segment (zero length) — distance to point a
    return Math.sqrt(apx * apx + apy * apy + apz * apz);
  }

  // Project point onto line, clamp to [0, 1]
  let t = (apx * abx + apy * aby + apz * abz) / abLenSq;
  t = Math.max(0, Math.min(1, t));

  // Closest point on segment
  const cx = a[0] + t * abx;
  const cy = a[1] + t * aby;
  const cz = a[2] + t * abz;

  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}


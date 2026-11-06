/**
 * @poqpoq/voxel-skinner
 *
 * Voxel geodesic skin weight computation for 3D character meshes.
 * The first standalone browser-native library for automatic skin weighting
 * using volumetric geodesic distance.
 *
 * Usage:
 *   import { computeSkinWeights } from '@poqpoq/voxel-skinner';
 *
 *   const result = computeSkinWeights(positions, indices, bones, { resolution: 64 });
 *   // result.skinIndices — Uint16Array, 4 bone indices per vertex
 *   // result.skinWeights — Float32Array, 4 weight values per vertex
 *
 * @module @poqpoq/voxel-skinner
 */

export { VoxelGrid, VoxelState } from './VoxelGrid.js';
export { voxelize } from './Voxelizer.js';
export { computeGeodesicDistances, computeSingleBoneDistance } from './GeodesicSolver.js';
export { extractWeights } from './WeightExtractor.js';

import { voxelize } from './Voxelizer.js';
import { computeGeodesicDistances } from './GeodesicSolver.js';
import { extractWeights } from './WeightExtractor.js';

/**
 * Compute skin weights for a mesh using voxel geodesic distance.
 * This is the main high-level API — one call does everything.
 *
 * @param {Float32Array|number[]} positions - Flat vertex positions [x,y,z, ...]
 * @param {Uint32Array|Uint16Array|number[]|null} indices - Triangle indices.
 *   If null, positions are treated as non-indexed (every 9 floats = 1 triangle).
 * @param {Array<{head: number[], tail: number[]}>} bones - Bone segments.
 *   Each bone has head [x,y,z] and tail [x,y,z] in world space.
 * @param {Object} [options]
 * @param {number} [options.resolution=64] - Voxel grid resolution along longest axis.
 *   32 = fast/coarse, 64 = good balance, 128 = high quality.
 * @param {number} [options.maxInfluences=4] - Max bone influences per vertex.
 * @param {number} [options.smoothing=0.1] - Weight smoothing (0 = sharp, 1 = very smooth).
 * @param {number} [options.threshold=0.01] - Minimum weight to keep.
 * @param {boolean} [options.use26Connected=false] - Use 26-connected neighbors
 *   (more accurate geodesic, ~4x slower).
 * @param {function} [options.onProgress] - Progress callback(stage, detail).
 *   stage: 'voxelize' | 'geodesic' | 'extract'
 *   detail: { boneIndex, totalBones } for 'geodesic' stage
 * @returns {{
 *   skinIndices: Uint16Array,
 *   skinWeights: Float32Array,
 *   grid: VoxelGrid,
 *   distanceFields: Float64Array[],
 *   stats: Object
 * }}
 */
export function computeSkinWeights(positions, indices, bones, options = {}) {
  const {
    resolution = 64,
    maxInfluences = 4,
    smoothing = 0.1,
    threshold = 0.01,
    use26Connected = false,
    onProgress,
  } = options;

  // ── Input validation — fail loud on malformed input rather than silently
  //    producing NaN weights or attempting a runaway allocation downstream. ──
  if (!positions || typeof positions.length !== 'number' || positions.length < 9) {
    throw new TypeError(
      'computeSkinWeights: positions must be a non-empty flat array [x,y,z, ...] with at least one triangle (9 floats).'
    );
  }
  if (positions.length % 3 !== 0) {
    throw new RangeError(
      `computeSkinWeights: positions.length (${positions.length}) must be a multiple of 3.`
    );
  }
  if (!bones || typeof bones.length !== 'number' || bones.length === 0) {
    throw new TypeError(
      'computeSkinWeights: bones must be a non-empty array of { head:[x,y,z], tail:[x,y,z] }.'
    );
  }
  if (!Number.isFinite(resolution) || resolution < 1) {
    throw new RangeError(
      `computeSkinWeights: resolution must be a finite number >= 1 (got ${resolution}).`
    );
  }

  const t0 = performance.now();

  // Step 1: Voxelize
  if (onProgress) onProgress('voxelize', {});
  const grid = voxelize(positions, indices, resolution);
  const t1 = performance.now();

  // Step 2: Compute geodesic distances
  const distanceFields = computeGeodesicDistances(grid, bones, {
    use26Connected,
    onProgress: onProgress
      ? (boneIdx, total) => onProgress('geodesic', { boneIndex: boneIdx, totalBones: total })
      : undefined,
  });
  const t2 = performance.now();

  // Step 3: Extract weights
  if (onProgress) onProgress('extract', {});
  const { skinIndices, skinWeights } = extractWeights(grid, distanceFields, positions, {
    maxInfluences,
    smoothing,
    threshold,
    bones,
  });
  const t3 = performance.now();

  const voxelCounts = grid.countByState();

  return {
    skinIndices,
    skinWeights,
    grid,
    distanceFields,
    stats: {
      vertexCount: Math.floor(positions.length / 3),
      boneCount: bones.length,
      resolution: `${grid.resX}x${grid.resY}x${grid.resZ}`,
      voxels: voxelCounts,
      timing: {
        voxelize: Math.round(t1 - t0),
        geodesic: Math.round(t2 - t1),
        extract: Math.round(t3 - t2),
        total: Math.round(t3 - t0),
      },
    },
  };
}


/**
 * GeodesicSolver — Computes geodesic distances from bones through a voxel grid.
 *
 * Uses Dijkstra's algorithm on the voxel grid to compute shortest-path distances
 * from each bone to every interior/boundary voxel. Distances travel THROUGH the
 * mesh volume, not through empty space — this is the key insight that solves
 * central bone starvation.
 *
 * Based on: Dionne & de Lasa, "Geodesic Voxel Binding for Production Character
 * Meshing", SCA 2013.
 *
 * @module GeodesicSolver
 */

import { VoxelState } from './VoxelGrid.js';

/**
 * Compute geodesic distances from all bones through the voxel grid.
 *
 * @param {VoxelGrid} grid - Classified voxel grid (from Voxelizer)
 * @param {Array<{head: number[], tail: number[]}>} bones - Bone segments.
 *   Each bone has a head [x,y,z] and tail [x,y,z] position in world space.
 * @param {Object} [options]
 * @param {boolean} [options.use26Connected=false] - Use 26-connected neighbors
 *   instead of 6-connected. More accurate but ~4x slower.
 * @param {function} [options.onProgress] - Callback(boneIndex, totalBones)
 * @returns {Float64Array[]} Array of distance fields, one per bone.
 *   Each is a flat Float32Array of grid.totalVoxels length.
 *   Infinity = unreachable, 0 = on the bone.
 */
export function computeGeodesicDistances(grid, bones, options = {}) {
  const { use26Connected = false, onProgress } = options;

  // Pre-compute bone voxels for each bone
  const boneVoxels = bones.map(bone => findBoneVoxels(grid, bone));

  // Compute distance field for each bone
  const distanceFields = [];

  for (let b = 0; b < bones.length; b++) {
    const dist = dijkstra(grid, boneVoxels[b], use26Connected);
    distanceFields.push(dist);
    if (onProgress) onProgress(b, bones.length);
  }

  return distanceFields;
}

/**
 * Compute geodesic distance for a single bone (useful for Web Worker parallelism).
 *
 * @param {VoxelGrid} grid
 * @param {{head: number[], tail: number[]}} bone
 * @param {Object} [options]
 * @returns {Float64Array}
 */
export function computeSingleBoneDistance(grid, bone, options = {}) {
  const { use26Connected = false } = options;
  const seeds = findBoneVoxels(grid, bone);
  return dijkstra(grid, seeds, use26Connected);
}

/**
 * Find all voxels that a bone segment passes through (3D line rasterization).
 * Uses a conservative approach: for each point along the bone, mark its voxel.
 *
 * @param {VoxelGrid} grid
 * @param {{head: number[], tail: number[]}} bone
 * @returns {number[]} Array of flat voxel indices that the bone intersects
 */
function findBoneVoxels(grid, bone) {
  const seeds = new Set();
  const h = bone.head;
  const t = bone.tail;

  // Step along bone segment in increments of half a voxel
  const dx = t[0] - h[0];
  const dy = t[1] - h[1];
  const dz = t[2] - h[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (len < 1e-10) {
    // Zero-length bone — just mark its position
    const [vx, vy, vz] = grid.voxelCoords(h[0], h[1], h[2]);
    const idx = grid.index(vx, vy, vz);
    if (grid.state[idx] !== VoxelState.EMPTY) {
      seeds.add(idx);
    }
    return [...seeds];
  }

  const steps = Math.max(4, Math.ceil(len / (grid.voxelSize * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const frac = s / steps;
    const px = h[0] + dx * frac;
    const py = h[1] + dy * frac;
    const pz = h[2] + dz * frac;

    const [vx, vy, vz] = grid.voxelCoords(px, py, pz);
    const idx = grid.index(vx, vy, vz);

    // Only seed if the voxel is inside the mesh (INTERIOR or BOUNDARY)
    if (grid.state[idx] !== VoxelState.EMPTY) {
      seeds.add(idx);
    }

    // Also mark immediate neighbors to ensure coverage for thin regions
    for (let dxi = -1; dxi <= 1; dxi++) {
      for (let dyi = -1; dyi <= 1; dyi++) {
        for (let dzi = -1; dzi <= 1; dzi++) {
          if (dxi === 0 && dyi === 0 && dzi === 0) continue;
          const nx = vx + dxi, ny = vy + dyi, nz = vz + dzi;
          if (!grid.inBounds(nx, ny, nz)) continue;
          const nIdx = grid.index(nx, ny, nz);
          if (grid.state[nIdx] !== VoxelState.EMPTY) {
            seeds.add(nIdx);
          }
        }
      }
    }
  }

  return [...seeds];
}

/**
 * Dijkstra's algorithm on the voxel grid.
 *
 * Uses a binary min-heap for the priority queue, giving O(N log N) performance
 * where N is the number of interior+boundary voxels.
 *
 * @param {VoxelGrid} grid
 * @param {number[]} seedIndices - Starting voxel indices (distance = 0)
 * @param {boolean} use26 - Use 26-connected vs 6-connected neighbors
 * @returns {Float64Array} Distance from bone to each voxel (Infinity if unreachable)
 */
function dijkstra(grid, seedIndices, use26) {
  const { resX, resY, resZ, totalVoxels, voxelSize, state } = grid;

  const dist = new Float64Array(totalVoxels);
  dist.fill(Infinity);

  if (seedIndices.length === 0) return dist;

  // Neighbor offsets: 6-connected (face neighbors) or 26-connected (+ edges + corners)
  const neighbors = use26
    ? buildNeighbors26(resX, resY, voxelSize)
    : buildNeighbors6(resX, resY, voxelSize);

  // Binary min-heap priority queue
  const heap = new MinHeap();

  // Seed all bone voxels at distance 0
  for (const idx of seedIndices) {
    dist[idx] = 0;
    heap.push(idx, 0);
  }

  // Dijkstra main loop
  while (heap.size > 0) {
    const { index: cur, priority: curDist } = heap.pop();

    // Skip if we already found a shorter path
    if (curDist > dist[cur]) continue;

    // Visit neighbors
    for (let n = 0; n < neighbors.length; n++) {
      const { offset, cost } = neighbors[n];
      const nIdx = cur + offset;

      // Bounds check via state array (EMPTY voxels block propagation)
      if (nIdx < 0 || nIdx >= totalVoxels) continue;
      if (state[nIdx] === VoxelState.EMPTY) continue;

      // Additional bounds check: prevent wrap-around at grid edges
      const [cx, cy, cz] = grid.coords(cur);
      const [nx, ny, nz] = grid.coords(nIdx);
      if (Math.abs(nx - cx) > 1 || Math.abs(ny - cy) > 1 || Math.abs(nz - cz) > 1) continue;

      const newDist = curDist + cost;
      if (newDist < dist[nIdx]) {
        dist[nIdx] = newDist;
        heap.push(nIdx, newDist);
      }
    }
  }

  return dist;
}

/** Build 6-connected neighbor offsets (face neighbors) */
function buildNeighbors6(resX, resY, voxelSize) {
  const strideY = resX;
  const strideZ = resX * resY;
  return [
    { offset: -1, cost: voxelSize },       // -X
    { offset: 1, cost: voxelSize },         // +X
    { offset: -strideY, cost: voxelSize },  // -Y
    { offset: strideY, cost: voxelSize },   // +Y
    { offset: -strideZ, cost: voxelSize },  // -Z
    { offset: strideZ, cost: voxelSize },   // +Z
  ];
}

/** Build 26-connected neighbor offsets (face + edge + corner neighbors) */
function buildNeighbors26(resX, resY, voxelSize) {
  const strideY = resX;
  const strideZ = resX * resY;
  const diag2 = voxelSize * Math.SQRT2;
  const diag3 = voxelSize * Math.sqrt(3);
  const neighbors = [];

  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const offset = dx + dy * strideY + dz * strideZ;
        const manhattan = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        const cost = manhattan === 1 ? voxelSize
                   : manhattan === 2 ? diag2
                   : diag3;
        neighbors.push({ offset, cost });
      }
    }
  }

  return neighbors;
}

// ──────────────────────────────────────────────────────────────
// Binary Min-Heap (priority queue)
// ──────────────────────────────────────────────────────────────

class MinHeap {
  constructor() {
    this._data = [];    // { index, priority }
    this.size = 0;
  }

  push(index, priority) {
    this._data[this.size] = { index, priority };
    this._bubbleUp(this.size);
    this.size++;
  }

  pop() {
    const top = this._data[0];
    this.size--;
    if (this.size > 0) {
      this._data[0] = this._data[this.size];
      this._sinkDown(0);
    }
    return top;
  }

  _bubbleUp(i) {
    const data = this._data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (data[i].priority >= data[parent].priority) break;
      [data[i], data[parent]] = [data[parent], data[i]];
      i = parent;
    }
  }

  _sinkDown(i) {
    const data = this._data;
    const n = this.size;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && data[left].priority < data[smallest].priority) smallest = left;
      if (right < n && data[right].priority < data[smallest].priority) smallest = right;
      if (smallest === i) break;
      [data[i], data[smallest]] = [data[smallest], data[i]];
      i = smallest;
    }
  }
}


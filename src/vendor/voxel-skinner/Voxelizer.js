/**
 * Voxelizer — Converts a triangle mesh into a classified voxel grid.
 *
 * Pipeline:
 *   1. Shell detection: mark voxels that intersect mesh triangles (BOUNDARY)
 *   2. Flood fill: propagate EMPTY from corners, leaving INTERIOR voxels
 *
 * Uses the Separating Axis Theorem (SAT) for triangle-AABB intersection,
 * which is the standard approach (Akenine-Möller 2001).
 *
 * @module Voxelizer
 */

import { VoxelGrid, VoxelState } from './VoxelGrid.js';

/**
 * Voxelize a triangle mesh.
 *
 * @param {Float32Array|number[]} positions - Flat vertex positions [x,y,z, x,y,z, ...]
 * @param {Uint32Array|Uint16Array|number[]} indices - Triangle indices (3 per face).
 *   If null/undefined, positions are treated as non-indexed (every 3 vertices = 1 triangle).
 * @param {number} resolution - Voxels along longest axis (default 64)
 * @returns {VoxelGrid} Classified voxel grid
 */
export function voxelize(positions, indices, resolution = 64) {
  const bounds = computeBounds(positions);

  // Expand bounds slightly to avoid edge cases
  const pad = 0.001;
  bounds.min[0] -= pad; bounds.min[1] -= pad; bounds.min[2] -= pad;
  bounds.max[0] += pad; bounds.max[1] += pad; bounds.max[2] += pad;

  const grid = new VoxelGrid(bounds, resolution);

  // Step 1: Mark boundary voxels (shell detection)
  markShell(grid, positions, indices);

  // Step 2: Flood fill from corners to classify interior
  floodFillExterior(grid);

  return grid;
}

/** Compute axis-aligned bounding box from flat position array */
function computeBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }

  return { min, max };
}

/** Mark all voxels that intersect mesh triangles as BOUNDARY */
function markShell(grid, positions, indices) {
  const triCount = indices
    ? Math.floor(indices.length / 3)
    : Math.floor(positions.length / 9);

  for (let t = 0; t < triCount; t++) {
    let i0, i1, i2;
    if (indices) {
      i0 = indices[t * 3] * 3;
      i1 = indices[t * 3 + 1] * 3;
      i2 = indices[t * 3 + 2] * 3;
    } else {
      i0 = t * 9;
      i1 = t * 9 + 3;
      i2 = t * 9 + 6;
    }

    const v0 = [positions[i0], positions[i0 + 1], positions[i0 + 2]];
    const v1 = [positions[i1], positions[i1 + 1], positions[i1 + 2]];
    const v2 = [positions[i2], positions[i2 + 1], positions[i2 + 2]];

    // Find bounding box of triangle in voxel space
    const tMin = [
      Math.min(v0[0], v1[0], v2[0]),
      Math.min(v0[1], v1[1], v2[1]),
      Math.min(v0[2], v1[2], v2[2]),
    ];
    const tMax = [
      Math.max(v0[0], v1[0], v2[0]),
      Math.max(v0[1], v1[1], v2[1]),
      Math.max(v0[2], v1[2], v2[2]),
    ];

    // Convert to voxel coords (conservative)
    const vMin = grid.voxelCoords(tMin[0], tMin[1], tMin[2]);
    const vMax = grid.voxelCoords(tMax[0], tMax[1], tMax[2]);

    // Test each candidate voxel
    for (let vz = vMin[2]; vz <= vMax[2]; vz++) {
      for (let vy = vMin[1]; vy <= vMax[1]; vy++) {
        for (let vx = vMin[0]; vx <= vMax[0]; vx++) {
          if (grid.getState(vx, vy, vz) === VoxelState.BOUNDARY) continue;

          const center = grid.worldPos(vx, vy, vz);
          const halfSize = grid.voxelSize * 0.5;

          if (triangleAABBIntersect(v0, v1, v2, center, halfSize)) {
            grid.setState(vx, vy, vz, VoxelState.BOUNDARY);
          }
        }
      }
    }
  }
}

/**
 * Flood fill from grid corners to mark EMPTY voxels.
 * Any unmarked voxel not reached is INTERIOR.
 */
function floodFillExterior(grid) {
  const { resX, resY, resZ } = grid;
  const VISITED = 255; // temporary marker

  // Use a queue-based flood fill starting from corner (0,0,0)
  // Corner voxels are guaranteed outside due to padding
  const queue = [];

  // Seed all face voxels of the grid (they're guaranteed exterior due to padding)
  for (let z = 0; z < resZ; z++) {
    for (let y = 0; y < resY; y++) {
      for (let x = 0; x < resX; x++) {
        if (x === 0 || x === resX - 1 ||
            y === 0 || y === resY - 1 ||
            z === 0 || z === resZ - 1) {
          const idx = grid.index(x, y, z);
          if (grid.state[idx] === VoxelState.EMPTY) {
            grid.state[idx] = VISITED;
            queue.push(idx);
          }
        }
      }
    }
  }

  // 6-connected flood fill
  const offsets = [
    -1, 0, 0,
    1, 0, 0,
    0, -1, 0,
    0, 1, 0,
    0, 0, -1,
    0, 0, 1,
  ];

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const [cx, cy, cz] = grid.coords(idx);

    for (let n = 0; n < 18; n += 3) {
      const nx = cx + offsets[n];
      const ny = cy + offsets[n + 1];
      const nz = cz + offsets[n + 2];

      if (!grid.inBounds(nx, ny, nz)) continue;

      const nIdx = grid.index(nx, ny, nz);
      if (grid.state[nIdx] === VoxelState.EMPTY) {
        grid.state[nIdx] = VISITED;
        queue.push(nIdx);
      }
    }
  }

  // Final classification: VISITED → EMPTY, remaining 0 → INTERIOR
  for (let i = 0; i < grid.totalVoxels; i++) {
    if (grid.state[i] === VISITED) {
      grid.state[i] = VoxelState.EMPTY;
    } else if (grid.state[i] === VoxelState.EMPTY) {
      // Unreached empty voxel = interior
      grid.state[i] = VoxelState.INTERIOR;
    }
    // BOUNDARY stays as-is
  }
}

// ──────────────────────────────────────────────────────────────
// Triangle-AABB intersection test (Akenine-Möller / SAT method)
// ──────────────────────────────────────────────────────────────

/**
 * Test if a triangle intersects an axis-aligned bounding box.
 * Based on the Separating Axis Theorem approach by Akenine-Möller (2001).
 *
 * @param {number[]} v0 - Triangle vertex 0 [x,y,z]
 * @param {number[]} v1 - Triangle vertex 1 [x,y,z]
 * @param {number[]} v2 - Triangle vertex 2 [x,y,z]
 * @param {number[]} center - AABB center [x,y,z]
 * @param {number} halfSize - Half-extent of the cube (all axes equal for cubic voxels)
 * @returns {boolean}
 */
function triangleAABBIntersect(v0, v1, v2, center, halfSize) {
  // Translate triangle so AABB is at origin
  const a0 = [v0[0] - center[0], v0[1] - center[1], v0[2] - center[2]];
  const a1 = [v1[0] - center[0], v1[1] - center[1], v1[2] - center[2]];
  const a2 = [v2[0] - center[0], v2[1] - center[1], v2[2] - center[2]];

  const h = halfSize;

  // Edge vectors
  const e0 = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]];
  const e1 = [a2[0] - a1[0], a2[1] - a1[1], a2[2] - a1[2]];
  const e2 = [a0[0] - a2[0], a0[1] - a2[1], a0[2] - a2[2]];

  // Test 9 cross-product axes (3 edges x 3 box axes)
  if (!testCrossAxes(a0, a1, a2, e0, e1, e2, h)) return false;

  // Test 3 box face normals (AABB axes)
  // X axis
  if (Math.min(a0[0], a1[0], a2[0]) > h || Math.max(a0[0], a1[0], a2[0]) < -h) return false;
  // Y axis
  if (Math.min(a0[1], a1[1], a2[1]) > h || Math.max(a0[1], a1[1], a2[1]) < -h) return false;
  // Z axis
  if (Math.min(a0[2], a1[2], a2[2]) > h || Math.max(a0[2], a1[2], a2[2]) < -h) return false;

  // Test triangle normal
  const normal = cross(e0, e1);
  const d = dot(normal, a0);
  const r = h * (Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]));
  if (d > r || d < -r) return false;

  return true;
}

function testCrossAxes(a0, a1, a2, e0, e1, e2, h) {
  const edges = [e0, e1, e2];
  const verts = [a0, a1, a2];

  for (let i = 0; i < 3; i++) {
    const e = edges[i];
    for (let axis = 0; axis < 3; axis++) {
      // Cross product of edge with box axis
      const ax1 = (axis + 1) % 3;
      const ax2 = (axis + 2) % 3;

      // Project vertices onto separating axis
      const p0 = -e[ax2] * verts[0][ax1] + e[ax1] * verts[0][ax2];
      const p1 = -e[ax2] * verts[1][ax1] + e[ax1] * verts[1][ax2];
      const p2 = -e[ax2] * verts[2][ax1] + e[ax1] * verts[2][ax2];

      const pMin = Math.min(p0, p1, p2);
      const pMax = Math.max(p0, p1, p2);

      // Project box onto same axis
      const r = h * (Math.abs(e[ax2]) + Math.abs(e[ax1]));

      if (pMin > r || pMax < -r) return false;
    }
  }
  return true;
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}


/**
 * VoxelGrid — 3D voxel grid data structure for volumetric computations.
 *
 * Converts a bounding box into a uniform 3D grid of cubic voxels.
 * Each voxel is classified as EMPTY, BOUNDARY (on mesh surface), or INTERIOR.
 *
 * Memory layout: flat typed arrays indexed as [z * resY * resX + y * resX + x].
 * This layout is cache-friendly for z-slice iteration and transferable to Web Workers.
 *
 * @module VoxelGrid
 */

export const VoxelState = {
  EMPTY: 0,
  BOUNDARY: 1,
  INTERIOR: 2,
};

export class VoxelGrid {
  /**
   * @param {Object} bounds - Axis-aligned bounding box { min: [x,y,z], max: [x,y,z] }
   * @param {number} resolution - Target voxels along the longest axis (e.g. 64)
   */
  constructor(bounds, resolution = 64) {
    const min = bounds.min;
    const max = bounds.max;

    // Compute extent per axis
    const extentX = max[0] - min[0];
    const extentY = max[1] - min[1];
    const extentZ = max[2] - min[2];
    const maxExtent = Math.max(extentX, extentY, extentZ);

    // Cubic voxel size based on longest axis
    this.voxelSize = maxExtent / resolution;

    // Resolution per axis (at least 1)
    this.resX = Math.max(1, Math.ceil(extentX / this.voxelSize));
    this.resY = Math.max(1, Math.ceil(extentY / this.voxelSize));
    this.resZ = Math.max(1, Math.ceil(extentZ / this.voxelSize));

    // Pad by 1 voxel on each side for flood-fill boundary
    this.resX += 2;
    this.resY += 2;
    this.resZ += 2;

    // Origin: min corner offset by 1 voxel of padding
    this.originX = min[0] - this.voxelSize;
    this.originY = min[1] - this.voxelSize;
    this.originZ = min[2] - this.voxelSize;

    this.totalVoxels = this.resX * this.resY * this.resZ;

    // Guard against degenerate or runaway grids before allocating. A non-finite
    // extent (empty / NaN positions) or an oversized `resolution` would otherwise
    // attempt a multi-gigabyte allocation and hard-crash the tab / process.
    if (!Number.isFinite(this.totalVoxels) || this.totalVoxels <= 0) {
      throw new RangeError(
        `VoxelGrid: degenerate grid (${this.resX}×${this.resY}×${this.resZ}). ` +
        `Check that mesh positions are finite and non-empty.`
      );
    }
    const MAX_VOXELS = 64_000_000; // ~400³ — far above any realistic resolution, blocks OOM
    if (this.totalVoxels > MAX_VOXELS) {
      throw new RangeError(
        `VoxelGrid: ${this.totalVoxels.toLocaleString()} voxels ` +
        `(${this.resX}×${this.resY}×${this.resZ}) exceeds the safety cap of ` +
        `${MAX_VOXELS.toLocaleString()}. Lower the 'resolution' option.`
      );
    }

    // State grid: EMPTY / BOUNDARY / INTERIOR
    this.state = new Uint8Array(this.totalVoxels);

    // Store bounds for reference
    this.bounds = { min: [...min], max: [...max] };
    this.resolution = resolution;
  }

  /** Flat index from 3D coordinates */
  index(x, y, z) {
    return z * this.resY * this.resX + y * this.resX + x;
  }

  /** 3D coordinates from flat index */
  coords(idx) {
    const x = idx % this.resX;
    const y = Math.floor(idx / this.resX) % this.resY;
    const z = Math.floor(idx / (this.resX * this.resY));
    return [x, y, z];
  }

  /** World position of voxel center */
  worldPos(x, y, z) {
    return [
      this.originX + (x + 0.5) * this.voxelSize,
      this.originY + (y + 0.5) * this.voxelSize,
      this.originZ + (z + 0.5) * this.voxelSize,
    ];
  }

  /** Voxel coordinates from world position (clamped to grid) */
  voxelCoords(wx, wy, wz) {
    const x = Math.floor((wx - this.originX) / this.voxelSize);
    const y = Math.floor((wy - this.originY) / this.voxelSize);
    const z = Math.floor((wz - this.originZ) / this.voxelSize);
    return [
      Math.max(0, Math.min(this.resX - 1, x)),
      Math.max(0, Math.min(this.resY - 1, y)),
      Math.max(0, Math.min(this.resZ - 1, z)),
    ];
  }

  /** Check if coordinates are within grid bounds */
  inBounds(x, y, z) {
    return x >= 0 && x < this.resX &&
           y >= 0 && y < this.resY &&
           z >= 0 && z < this.resZ;
  }

  /** Get voxel state */
  getState(x, y, z) {
    return this.state[this.index(x, y, z)];
  }

  /** Set voxel state */
  setState(x, y, z, val) {
    this.state[this.index(x, y, z)] = val;
  }

  /** Count voxels by state */
  countByState() {
    let empty = 0, boundary = 0, interior = 0;
    for (let i = 0; i < this.totalVoxels; i++) {
      switch (this.state[i]) {
        case VoxelState.EMPTY: empty++; break;
        case VoxelState.BOUNDARY: boundary++; break;
        case VoxelState.INTERIOR: interior++; break;
      }
    }
    return { empty, boundary, interior, total: this.totalVoxels };
  }
}


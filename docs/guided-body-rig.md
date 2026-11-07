# Guided humanoid body rig (test build)

Forge uses Three.js r170 for rendering, HTML/CSS/JavaScript for the interface,
and Capacitor 7 / Android WebView for the APK. This feature keeps that stack.
It does not introduce Filament or a remote processing service.

## Workflow

1. Load an upright, forward-facing (+Z), T/A-pose GLB without skins, animations
   or morph targets. Use one character scene. Existing rigs continue to use
   the Animations tab.
2. Open **Скелет**, create the geometric draft, and check all 18 joint centres
   from the front and side. The draft is proportional geometry sampling, not
   anatomical detection. Left/right refer to the character.
3. Confirm the points and calculate weights. Moving a point invalidates the
   prepared result and requires confirmation again.
4. Review the bend test, then save the prepared GLB or adopt the rig for the
   existing BVH retargeting workflow. The test pose is never saved as bind pose.

The body profile has 27 joints, 22 deforming segments, and at most four
normalized weights per vertex. It does not generate finger, ear or tail rigs,
transfer weights to separate clothes, retarget GLB/FBX animation sources, or
generate facial shapes. Automatic weights require movement review.

## Data and memory

The worker preserves triangle topology, vertex UVs, materials and embedded
image bytes. It converts positions, normals and tangents into world space,
accounts for reflected transforms, creates inverse bind matrices, and verifies
the serialized bind pose. Joint names use the `mixamorig` prefix understood by
the existing BVH mapper; this is not a guarantee of every external rig profile.

The input byte array is copied before transfer. Cancellation, timeout and errors
terminate the worker. Invalid guide points, bones outside the volume and
unweighted vertices stop export rather than assigning arbitrary fallback weights.
Limits are 650,000 expanded vertices, 1,000,000 triangles, and a conservative
task estimate checked against the existing native Android available-memory
query. Weight grids are limited to 32/48/64 samples on their longest axis.
These estimates cannot guarantee that every device has enough CPU/GPU memory.

The comparison viewport reuses source texture objects and receives positions,
indices and weights directly from the worker. It does not decode another copy
of the source's potentially 8K images. Adopting the preview transfers ownership
of those texture objects to the working rig. Saving uses prepared bytes;
the original file remains unchanged.

## Open source provenance

The local weight solver is vendored from the MIT-licensed
[poqpoq-voxel-skinner](https://github.com/increasinglyHuman/poqpoq-voxel-skinner),
version 0.1.0. Copyright (c) 2026 Allen Partridge (p0qp0q).
The license is included in `third-party/voxel-skinner-LICENSE.txt` and shipped
inside the APK at `public/codecs/rig/VOXEL_SKINNER_LICENSE.txt`.
No RiggerDroid implementation code or assets are included.

Original Git blob IDs:

| File | Blob |
| --- | --- |
| index.js | 39c9cc9f523270fafa4bb4be679c336a6069c7d6 |
| VoxelGrid.js | 534ae65a8b57778a81494f0fd42a7711f121489e |
| Voxelizer.js | da642272e990c26375e75c10553e9ab8843d0c0b |
| GeodesicSolver.js | 1a0cced863fb47a10751d6210d181a0eb57827d2 |
| WeightExtractor.js | 31bc1da491f258b749c029faeabce1f722b2be5b |

The adapter normalizes the model height before voxelization and restricts
resolution and bone count. The solver builds a voxel shell, fills the interior,
computes per-segment geodesic distance fields and extracts four influences.

### Continuous weight transitions (version 2)

The local extractor now interpolates distances between voxel centers instead
of assigning each vertex a single containing-cell distance. The interpolation
stencil follows solid face-connected cells and never admits a bone unreachable
from the containing cell. This removes steps at grid boundaries without
increasing grid resolution or building a dense vertex-by-bone matrix.

The four-influence cutoff also fades weights to zero at the fifth candidate's
raw weight. Swapping the fourth and fifth bones therefore does not abruptly
replace a nonzero influence. Fully coincident ties retain normalized weights;
unreachable vertices remain unweighted and trigger the existing export guard.

New rigs record `phoenixRig.version: 2` and
`weightSampling: connected-trilinear-compact`. Existing imported rigs are not
reweighted automatically. Geometry, normals, UVs, materials and animation
transfer behavior remain unchanged. This improves weight continuity; linear
skinning can still lose volume on large bends and every rig needs motion review.

## Validation

Node tests cover mirrored and differently scaled instances, the rest-pose
round trip through Three.js, exact image retention, normalized skin weights,
forearm/hand motion and opposite-leg isolation, shared texture identity,
cancel/error cleanup, source immutability and memory/guide rejection.
The production browser check uses the real module worker with external
requests blocked: draft/front/side controls, cancel/retry, bend review,
immutable saves, point-edit invalidation, adoption and BVH export.

The test APK uses a separate application ID so it can coexist with the installed
Forge build. Desktop/CI checks do not replace device and game-engine review.

# Offline animation packs

The animation input accepts ZIP, BVH, FBX, GLB and glTF, including multiple
selected files and glTF BIN companions. The user chooses a source file, chooses
a take inside it, reviews the bone mapping and retargeted preview, and adds
the reviewed clip to the existing output set. Selecting another file/take
restores the character pose and invalidates that preview. Previously accepted
clips survive a bad source; static files produce an explicit error.

ZIP is a container, not an animation format. The model ZIP importer still
selects a single main model; the separate motion-pack index lists all supported
animation files and preserves their folder paths. It reads the central
directory from File/Blob slices and inflates only the selected entry and needed
BIN resources. Archive images are ignored. Relative glTF BIN references resolve
inside their archive namespace, including parent folders within that namespace.
External URLs and ambiguous/traversal paths are rejected. Entries are checked
against their local ZIP headers and CRC before parsing.

## Memory and supported channels

Limits: compressed ZIP 128 MiB, 4096 directory entries, 2048 selectable source
files (up to 400 loose files per picker operation), 64 MiB per source/BIN,
256 MiB declared relevant unpacked data, and 100
clips per source. Source-task estimates use the existing Android memory query.
Increasing catalog counts does not inflate more entries: the current source
still opens alone. Common `clips`, `animations` and `motions` folders sort
before donor/demo models. Search filters source names/folders while retaining
the currently loaded file; typing a query does not parse another source.
Skeletons are limited to 200 nodes (BVH end sites are excluded from that count).
Animation accessor/track budgets and the 18,000-sample retargeting limit are
checked before large allocations.

GLB/glTF is stripped to its transform hierarchy, joint markers and skeletal
animation channels before GLTFLoader runs. Meshes, materials, textures, images,
cameras, inverse bind arrays and unrelated extensions are not loaded. Only
animation buffers are resolved, using local Blob URLs. FBX parsing runs in a
short-lived worker; source image loads are disabled there. It returns only bone
TRS and clip arrays, then terminates to release the FBX parser's retained tree
and geometry. The target character's geometry and textures stay in the viewport.

Supported retargeting channels are bone rotations and optional pelvis motion.
Morph/material tracks and translations of individual joints are not copied.
Changing source scale is unsupported; a clip requiring it is reported/skipped.
The error identifies changing scale explicitly rather than suggesting that the
archive is corrupt. In the 514-GLB private library check, all 506 ordinary
skeletal clips opened and produced finite retargeted tracks. Four clips with
changing scale were rejected, and four GLBs had no animation.
Source hierarchy scales must be positive and uniform. FBX remains subject to
the existing Three.js loader's version and feature compatibility.

## Reference pose and timing

BVH keeps its existing first-frame calibration option and CMU detection.
FBX/GLB/glTF use the source skeleton's rest pose rather than treating frame zero
as calibration, so a posed first animation frame is retained. Retargeting uses
world rotation deltas, the complete source transform hierarchy, target-local
rest rotations and optional limb/frame alignment. Optional pelvis movement
includes animated source armature parents and uniform unit scale.

Model curves are baked at 60 Hz plus original key times. STEP boundaries include
a pre-transition sample; glTF cubic curves use their actual interpolants.
The result remains an experimental body retarget: preview shoulders, elbows,
knees and facing direction before accepting. Unusual rigs and constraints can
require manual work. This does not create weights, transfer clothes or retarget
facial expressions.

Name mapping recognizes Blender/KayKit side suffixes, Unreal/Mesh2Motion body
names and common finger chains. Spine, Spine1 and Spine2 remain separate.
Exact matches are reserved first; alias fallback prioritizes an actual pelvis
over a helper root and an actual hand over an intermediate wrist. A root-only
skeleton retains the existing pelvis fallback. Reference-body alignment and
root-motion extraction use the same pelvis preference.
Body directions use named anatomical descendants rather than the first child:
for example, hips follow the spine even if a leg appears first in the file.
Weapon sockets do not define the hand frame. Model motion is evaluated relative
to the nearest corresponding source/target ancestor; this preserves static local
arm and hand poses when torso movement is adapted between T and A reference
poses, including unmapped intermediate joints.

Saving appends accepted tracks to the original target GLB container through the
existing byte-preserving animation exporter. Source characters never replace
the target, and source images never get exported into it.

## Validation

Tests cover lazy ZIP reading, duplicate base names in separate folders, path and
CRC errors, relative BIN resolution, real two-take FBX and GLB/glTF imports,
first-frame retention, cubic/STEP curves, root motion through a scaled armature,
static-file recovery and oversized sparse-accessor rejection. Existing BVH
regressions remain enabled. The production browser loads a mixed ZIP, previews
and accepts BVH/GLB/FBX/glTF clips, handles a static source error, then saves and
reimports four animations while verifying exact target BIN and image metadata.

# Optional skin-weight editor

The existing body-rig generator and arm-weight repair remain available with their existing defaults. **Веса → Открыть редактор весов** creates an independent geometry/skeleton preview. Merely opening, browsing, changing settings, or discarding it does not alter the working model or original bytes.

## Brush

Select a bone, size (diameter as a percentage of character height), strength, and Add/Remove/Smooth. Painting stops animation and restores the bind pose; playing a clip switches the editor back to camera mode. A surface cursor shows the brush footprint. A BVH ray pick and per-vertex visibility rays restrict a dab to the visible surface of the hit mesh. Other meshes can occlude it. Turn the model to paint its back.

Brush weights remain normalized with at most four influences. Add reserves the selected bone and proportionally distributes the remainder to the strongest other three. Removing the last rigid influence uses the parent bone as fallback. Smooth averages through welded triangle adjacency, including UV seams; it is computed from a snapshot before the dab. Normalized integer attributes are quantized during editing so the preview and saved values agree. Colored visualization uses temporary cloned materials; source textures are shared and never re-encoded.

Strokes have Undo/Redo. Pointer cancellation rolls back the active stroke. History retains up to 24 commands / about 12 MiB of typed deltas, with at most one complete stroke beyond that budget; a 60,000-vertex stroke limit bounds transient history. Very large dabs are rejected rather than partially painted. Reset restores original weights and joints and clears history. A spatial hash, compact adjacency, indirect BVH and input throttling bound work on Android. Actual peak memory and speed depend on device and mesh; the preflight estimate is not an Android heap guarantee.

## Shoulder tools

For tagged Forge humanoid-body rigs, the section offers reviewable shoulder suggestions from local mesh cross-sections, manual X/Y/Z coordinates, and front/side point placement. The suggestion is a draft, not an anatomical detector or a gender classifier. Clothes, hair, nonstandard poses and unusual proportions require review. No proposed point moves a bone until **Применить плечи к копии**.

Moving the Arm joint compensates the ForeArm translation to retain elbow/wrist rest positions. Rest rotations remain unchanged, preserving the coordinate frames used by existing rotation clips. Inverse bind matrices are updated as `inverse(newWorld) * oldWorld * oldInverseBind`, preserving the original rest mesh. Translation/scale animation on the affected joints is rejected for this operation. The optional torso-protection strength redistributes shoulder/upper-arm influence to the spine inside the torso with smooth spatial gates; distal arms and legs are excluded. Each application is an undoable action, and repeated applications can further reduce torso influence.

This correction preserves animation key data, but repositioning a pivot intentionally changes the resulting motion. Review the same clips before accepting it. Standard linear skinning still has limitations at extreme joint rotations.

## Save and compatibility

Save writes a separate GLB. Adopt makes the reviewed copy the current model and supports reopening it for additional edits. Exporting the original before adoption remains byte-identical. With no effective edits, export returns the original bytes exactly, including after reset/undo. Texture, geometry, material and animation payloads remain unchanged. Painting modifies joint/weight bytes; shoulder movement additionally modifies two joint translations and inverse bind entries. A skin-edit marker is added.

Supports a GLB with one 2–256-joint skin, ordinary triangle geometry, four influences, float positions and float/normalized U8/U16 weights, up to 650,000 editable vertices and available memory. Shared weight accessors, sparse/compressed geometry and incompatible bind poses are rejected. Unsupported formats need a separately prepared uncompressed GLB. Morph payloads are retained, but editing is done at default morph values.

## Validation

Unit tests cover normalization, erasing rigid weights, visibility callbacks, falloff, smoothing across UV seams, exact source/reset/undo preservation, binary changes confined to allowed attributes, integer serialization, shoulder rebinding/rest-pose consistency, animated preview/export equivalence, BVH occlusion, suggestion immutability and bounded history. Browser checks exercise the real canvas brush, save, undo/redo, shoulder rebinding, animated comparison, exact original export, adoption, reopening, mobile layout and discard, with external network blocked. Existing body-rig, arm-repair, animation-library and codec regressions run alongside them.

The three separately supplied models (203,062 / 357,245 / 48,778 vertices; 39 / 2 / 14 clips) passed file validation after shoulder adjustment and exact undo. They are not committed to the public repository. These checks do not replace Android device review.

The isolated APK is **Forge WEIGHT BRUSH**, package `com.phoenix.glbfbxconverter.rigtest.skin1`. The 1,273 embedded Humanoids/Monsters animations are inherited.

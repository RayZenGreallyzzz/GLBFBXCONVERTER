# Optional elbow/knee preparation for GLB

The **Суставы** tab creates a reviewable copy in three stages. The existing rig generator, arm fix and weight brush keep their existing defaults. Apply pending manual weights first. Existing joint forms and pre-existing morph targets are rejected for this initial implementation rather than overwritten.

1. **Local transverse rows.** Seven cross-planes add vertices near each selected joint. Shared-edge intersection caching and one-edge transition splits keep the triangulation conforming. Original positions remain, new positions lie on the original triangles, and UVs/normals/weights interpolate across each split. No global subdivision or texture re-encoding occurs.
2. **Compact weights.** Confident vertices in the two limb segments follow their own bone away from the joint. A quintic transition spans the bend. Geodesic confidence and fades near the proximal root/distal end preserve torso/other-limb separation and wrist/ankle transitions. Weights stay non-negative, normalized and limited to four influences.
3. **Bend correctives.** For each joint, eight reference shapes cover ±X/±Z swings at 90° and 135° in the joint's rest frame. A rigid dual-quaternion reference provides a bounded volume-restoring displacement. It is stronger on the convex side, reduced on the inner fold, spatially gated, and transformed back through the reference LBS matrix so standard morph-before-skinning reproduces it. Position and normal deltas are stored as sparse glTF morph accessors. The base silhouette and authored textures remain intact.

This is a procedural approximation, not anatomical retopology or a guarantee for every character. Extreme bending, combined swings/twists, unusual geometry and large changes to weights require inspection. The maximum reference angle is 135°. The initial mode supports tagged 27-bone Forge body rigs with updated arm weights and an identity mesh transform in bind pose. Select fewer joints or use a lighter source when the memory preflight rejects a large mesh. All selected joint forms must fit the existing 96 MiB expanded-morph budget; sparse on-disk size does not remove the renderer's expanded-memory cost.

## Portable animation data

Existing clips receive standard glTF `weights` channels targeting the mesh nodes. Bend direction is measured from the rest-relative bone rotation; pure bone-axis twist does not activate a bend shape. The shape anchors blend by squared half-angle sine and directional weights. Baking includes source key times, 30 Hz samples, and immediately preceding float key times for step transitions. Rotation samplers support LINEAR, STEP and CUBICSPLINE. Non-finite or malformed animation input is rejected.

Adding a new motion through Forge also bakes corrective channels when **Сохранить набор анимаций GLB** appends that clip. Existing binary data, previously baked clips and source bone keys remain intact. Playback of the newly added motion previews matching morph tracks; no proprietary shader or custom GLB extension is required to replay the saved curves.

An engine/importer must support the asset's glTF features, including skinning, animated morph targets and its existing texture extensions. Geometry, morph targets and animation curves are portable data; arbitrary new motions, engine-side IK, animation blending and retargeting outside Forge do **not** automatically regenerate correction curves. Those cases need a joint-angle driver in the engine or a new bake. No Unity/Godot/Unreal import claim is made without testing that engine/importer. Source textures keep their original codecs, including WebP where used.

A source with no animations can be reviewed with the elbow/knee test sliders. Its saved file contains zeroed morph defaults; after applying the result, add motions in the animation tab and export the set to include portable correction curves. Changing weights after generating these reference shapes invalidates them, so the weight editor directs users to the pre-correction copy.

## Review, cancellation and validation

The worker is cancellable and source bytes stay intact until adoption. Compare original/result at 90°/120° and with actual clips. Saving restores the test pose and writes a separate file. Adoption retains all original clips and supports adding further motions. Rebuilding starts from the original working file; settings invalidate a previous preview.

Tests cover conforming splits, winding/area/UV preservation, immutable source data, normalization, sparse target validation, retained skeleton transforms and clips, reference-driver behavior, baked-vs-live curves, independent GLB reload/deformation, newly appended corrective clips, and memory/repeat guards. Production browser checks cover cancellation/retry, both test sliders, animated comparison, exact original export, adoption, adding and exporting a new motion, reimport/playback and mobile layout. Existing regression suites run alongside them.

On the separately supplied 48,778-vertex model, the initial all-four-joint preparation added 1,486 vertices. That file is not committed to the public repository. Native Android performance and visual review remain necessary.

The isolated build is **Forge JOINTS GAME**, package `com.phoenix.glbfbxconverter.rigtest.joints1`. The inherited Humanoids/Monsters motion library remains unchanged.

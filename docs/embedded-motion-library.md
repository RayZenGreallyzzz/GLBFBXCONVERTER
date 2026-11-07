# Embedded motion library

The Android app has two primary libraries: **Humanoids / Monsters**. Each has
Idle, Walk, Run, Attack and Other categories, text search, and a six-card live
catalog. Switching character groups clears the previous source selection;
accepted target animations remain available. The catalog can be browsed before
loading a target. Transfer requires a skinned target and should be previewed.

The release includes 1,273 unique clips: 786 humanoid and 487 monster clips.
All 656 original monster actions are represented after exact-data deduplication.
Four humanoid effects that animate scale remain unsupported. Static source
models without movements are excluded. The shipped build and Blender coverage
reports contain the exact source provenance, duplicates and warnings.

## Data and memory

Startup loads only `/motions/index.json`. Only a selected clip and the visible
six thumbnail sources are decoded. The cache contains small sampled visuals,
not meshes, textures or original scenes. Each asset is a separate mesh-free
skeletal GLB. Imported ZIP/BVH/FBX/GLB sources can be used alongside the built-in
library without discarding accepted target clips.

`motion-library/bundle.json` and its compressed binary parts are source assets.
`npm run build` and `npm run dev` verify and unpack them into `public/motions`.
The generated directory is not committed. APK packaging verifies every clip's
size and SHA-256 and requires both character groups.

## Rebuild from original archives

```sh
npm ci --no-audit --no-fund
npm run motions:build -- /path/to/animation-archive-directory /path/to/baked-monster-glbs
npm run motions:verify
npm run motions:bundle
npm test
npm run build
npm run test:motions-browser
npm run test:browser
```

The builder preserves rest transforms, key times/values and STEP / LINEAR /
CUBICSPLINE interpolation. It removes only exact data duplicates within each
character group. Source filenames and annotations are retained as provenance.
Preserve included license files in `public/motions/licenses` before bundling.

## Blender monster sources

`scripts/export-blend-motions.py` reads local BLEND files using the official
Blender `bpy` module with embedded scripts disabled. It bakes evaluated
armatures at their original frame rate into skeletal GLB files named
`monster_<name>.glb`. Rest and sampled local transforms are reconstructed and
compared against Blender's world matrices before output. Legacy unit-scale
orthogonality noise up to 0.01% is normalized. The verified maximum world-matrix
error in the supplied sources is below 0.0001. Actual non-unit scaling is kept.
No target geometry, weights, skeletons or textures are changed.

The supplied 61 monster files produced 656 supported source actions and 487
unique clips. `verify-blend-library.mjs` independently checks that every
supported baked action is represented in the final monster library.

## Validation

Unit tests cover group isolation, category/search filtering, exact duplicates,
variant preservation, mesh stripping, interpolation, bundle checksums,
corruption handling, lazy fetches and cancellation. The focused browser script
serves ten generated fixtures through request routing; fixtures are never
shipped. It checks both groups, mobile layout, six-card pages, retarget/add and
imported/built-in switching. GitHub Actions runs it in a Chromium environment,
then builds and verifies the isolated Forge ANIMATIONS APK.

This work starts from the exact MIXAMO TEST commit
`06a51bdb7c44d01de22634b8284ca75d3de8c1e4`, preserving the prior continuous skin
weights and bounded Mixamo scale-rounding changes. The test applicationId is
`com.phoenix.glbfbxconverter.rigtest.motions1`; stable apps remain independent.

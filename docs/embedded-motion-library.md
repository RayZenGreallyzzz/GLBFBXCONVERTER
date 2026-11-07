# Embedded motion library — implementation checkpoint

The user requested all distinct uploaded movements inside the Android app,
with Idle, Walk, Run, Attack and Other sections. This work starts from the
exact MIXAMO TEST source commit `06a51bdb7c44d01de22634b8284ca75d3de8c1e4`
(GitHub Actions run 42378708172), including the continuous weights and bounded
Mixamo scale-rounding fixes.

## Current state (2026-11-08)

Source implementation and generated-fixture unit tests are prepared. All 199
Node tests and the production web build passed. The new browser test could
not run in this environment: Chromium 153 terminated at launch with SIGTRAP;
it remains unverified. **The
real animation assets have not been packaged, and there is no new APK.**
The previously uploaded ZIP bytes disappeared when the conversation resumed.
Do not claim that the earlier figure of 786 clips has been verified. Obtain
the animation archives again before building the real library. The original
APK does not need to be reuploaded because the exact source is restored.

Expected inputs: Phoenix_Rigs_Animations_ALL / Humanoids / Monsters,
Universal Animation Library 2 Standard, Mixamo Complete 156 and parties 1/2,
Stefani_Anim and ToonMouse14. Some overlap; the builder keeps provenance.

## Implemented behavior

- Startup reads only `/motions/index.json`. Clip GLBs load on demand.
- Idle / Walk / Run / Attack / Other filters appear in the main picker and
  the six-card live catalog. Search combines with the category.
- The catalog can be browsed without loading a target character. Transfer
  requires a skinned target. Imported files and the built-in library can be
  switched without discarding accepted animations.
- The offline builder stores one skeletal clip per GLB, without meshes,
  images or materials. It preserves rest transforms, key data and STEP /
  LINEAR / CUBICSPLINE interpolation. Root-motion variants remain distinct
  whenever their keys differ.
- Deduplication hashes hierarchy, rest transforms and key data, ignoring clip
  names. It removes exact data duplicates, not similar-looking movements.
- BLEND files are not parsed. Export them to GLB/FBX with animations first.
  Files or clips rejected by the existing motion importer are reported.
- APK packaging refuses a missing or corrupted library.

## Resume after the archives are available

```sh
npm ci --no-audit --no-fund
npm run motions:build -- /path/to/animation-archive-directory
npm run motions:verify
npm test
npm run build
npm run test:motions-browser
npm run test:browser
```

Inspect `public/motions/build-report.json`: counts, categories, duplicates and
every warning. Audit names/categories against the actual clips. Include
`public/motions/index.json` and all referenced `clips/*.glb` in the commit;
generated test fixtures must never be shipped as the real library.

The targeted browser script serves eight generated fixtures through request
routing, without creating `public/motions`. It tests startup without clip
requests, six-card pagination, categories/search, mobile width, retarget/add
and imported/built-in switching. It requires a functioning Chromium runtime.

Once real assets and checks pass, add `feature/embedded-motion-library` to the
workflow push branch list, give the new test APK its own applicationId and
label, verify the packed catalog/clip count, and obtain the resulting APK
artifact. Keep the old stable installations independent.

# GLB FBX Converter — Phoenix Model Forge

Standalone Android-first 3D converter and optimizer for GLB/FBX and Godot.

The stable main branch is the initial converter. This working branch builds on
`fix/3mf-optional-materials-foxgi` and retains its OBJ/MTL textures, Mixamo,
FBX, animation and large-3MF paths.

## Offline GLB codecs

- GLB/glTF imports can use Meshopt, Draco and KTX2/Basis Universal textures.
  The Draco decoder and KTX2 transcoder are packaged locally, with one decode
  worker each. Meshopt decoding is bundled in JavaScript/WASM.
- Optional compression is under **Optimization → GLB compression**. Geometry:
  Meshopt without an extra quantization pass, Draco high precision, or explicit
  decompression. These are extensions inside GLB/glTF, not new model suffixes.
- Textures: KTX2 ETC1S or UASTC. Normal/ORM data maps always use UASTC; color
  maps are encoded as sRGB, data maps as linear. Alpha and mipmaps are retained.
  Existing 512/1024/2048/4096 texture presets remain; the KTX2 encoder is capped
  at 2048 px and source images at 4096×4096 for Android memory safety.
- Encoding runs in a disposable module worker, sequentially per image. No
  runtime CDN, SharedArrayBuffer or cross-origin isolation is required. Codec
  failures cancel the preview; source file bytes are never written or detached.
- The output is reopened and checked for primitive/index counts, attributes,
  morph target structure, skin joint names and inverse bind matrices, exact
  animation channel/sample values, and material/texture counts.
- Default ordinary GLB processing and the unchanged-byte fallback remain.
  Explicitly selected codecs can produce a larger file: the UI reports this
  rather than silently returning a file with a different codec.
- KTX2 uses lossy texture encoding; Draco uses position/normal/UV quantization.
  Compare visual quality in the preview and in the destination application.
  Existing OBJ and FBX exports and Mixamo version choices are retained.
- Fixed the 3MF preview's ArrayBuffer/Uint8Array normalization. Original 3MF
  conversion still uses the complete source mesh.

Validation: `npm ci`, `npm test`, `npm run build`, `npx playwright install chromium`,
`npm run test:browser`. Browser checks exercise production workers, PNG→KTX2,
Meshopt and Draco export/download/reimport, byte-identical default output, and
streamed 3MF optimization with external network requests blocked. Android CI
also verifies that all offline codec assets are actually inside the APK.
The test APK uses `com.phoenix.glbfbxconverter.codecstest`, so it can coexist
with the owner's installed stable app. Browser/CI success does not replace
visual and memory testing on the actual Android tablet.

Android CI: `.github/workflows/android.yml`; download APK from GitHub Actions artifacts after a successful build. Original models are never overwritten.

## Experimental VRM 1.0 + color 3MF + ZIP archive importer (29.10.2026)

This branch builds **on** the existing MultiFormat / BVH adaptation work,
and does not replace the stable `main` Android APK.

- **VRM (virtual-reality humanoid avatar):** load an existing VRM losslessly
  with "VRM source", or use **VRM 1.0** export to convert a rigged humanoid
  GLB/FBX. Mixamo-style bone names are mapped to VRMC_vrm humanBones and
  required bones, skin links and ancestry are validated. Models with missing
  hips, spine, head, limbs or skin are rejected rather than renamed. This is
  basic VRM 1.0: it does not create facial expression clips, spring bones,
  look-at, MToon textures, or calibrate A-pose to T-pose. VRM animation clips
  must be exported separately in GLB. New VRM exports apply conservative
  author-only permissions; verify creator and license settings before sharing.
- **Textured 3MF (3D printing):** exports an actual 3MF OPC/ZIP package with
  `3D/3dmodel.model`, embedded PNG Albedo texture resources, texture2dgroup,
  UV indices on mesh triangles and texture relationships. Material colors
  without textures are emitted as core base materials. Transforms are baked;
  converts Three.js Y-up into 3MF Z-up. User can select **metres-to-millimetres**
  or direct millimetres, plus a 1024/2048/4096 texture limit. No rig, animation,
  normal/roughness/metallic image, supports or printer profiles are preserved.
  Does not guarantee watertight/manifold geometry; verify the slicer's size,
  textures and printability. Consumer support for textured 3MF varies.
- **3MF import:** via ThreeMFLoader. Note importer support for advanced color
  materials varies by 3MF extension and Three.js version.
- **ZIP import:** local multi-file ZIP packages from Meshy/Tripo including
  OBJ+MTL+images and glTF+BIN+images; rejects path traversal, duplicate names,
  huge uncompressed archives and missing referenced resources. Original ZIP
  is never overwritten.
- Offline conversion and Android file save remain supported.
- Tests cover exact VRM node references, errors on missing/invalid rigs,
  3MF texture relationship and UV XML, ZIP traversal rejection, dimensions,
  print warnings, and format menus.

Source-to-target matrix:
| Input | Output | Notes |
|---|---|---|
| GLB, glTF, FBX, VRM, OBJ+MTL, ZIP | GLB / FBX / OBJ ZIP | Format-dependent skin/animation preservation |
| Rigged humanoid GLB / FBX | VRM 1.0 | Basic avatar; does not generate facial/spring systems |
| Existing VRM | VRM source copy | Preserves original extension metadata exactly |
| GLB / OBJ / FBX, etc. | 3MF textured print | PNG Albedo and UV on static surface, print dimensions in mm |
| 3MF | GLB / OBJ etc. | Loader support and input colors may vary |

**Safety:** Do not claim a green CI build guarantees correct conversion
in an external slicer or VRM viewer; test with real files and the Android
device before replacing the stable app.

## 29.10.2026 — Large textured 3MF and two avatar workflows

### 3MF prints without a hard polygon cap
- Removes the artificial refusal for 650,000+ triangles. A model with
  **1,936,208 triangles** must be exportable without automatic decimation.
- Writes 3MF XML incrementally into streaming DEFLATE ZIP. This avoids holding
  one huge XML string and millions of triangle strings simultaneously.
  Periodically yields to the Android UI and reports progress.
- Geometric fidelity is maintained. Print Albedo PNG/UV, base colors, materials,
  Y-up → Z-up and metres → millimetres are preserved as in the previous
  printing exporter. Never silently simplify the user's original.
- An extremely large model can still exhaust the available RAM, storage,
  file saver budget or slicer capacity. Streaming reduces peak memory but
  is not unlimited memory. No polygon count is a 3MF-format restriction.
- For real 3D printing check watertightness, wall thickness, orientation,
  and supported texture extensions in the target slicer.

### Separate VRChat and VRM paths
1. **VRM 1.0 — VTuber / compatible avatar viewers.** Retains the basic
   humanoid-only VRM generator. Requires a properly rigged model and a
   compliant VRM skeleton. Current generator is minimal; extra MToon,
   expressions, physics and broader VRM-viewer compatibility are not guaranteed.
2. **VRChat — FBX for Unity.** New dedicated FBX 7.5 export mode
   validates humanoid bone names and that a skinned mesh exists. It keeps
   textures and original geometry. The resulting file is input for Unity,
   not a directly uploadable VRChat avatar or a Unity package.
   Finish in VRChat Creator Companion / Unity / VRChat Avatar SDK:
   select Humanoid rig, map bones, set Avatar Descriptor, viewpoint, visemes,
   materials, expressions/PhysBones, and PC or Android build target.
   The Android performance ranking recommends low triangle counts (Poor
   threshold 20k, PC Poor threshold 70k). Higher counts generate a warning,
   not silent geometry deletion; use the separate Optimizer to prepare an
   alternative mobile version.
- 3MF and VRChat/VRM are different outputs and do not replace each other.


## Geometry targets and repeated-pass protection

This quality-test branch adds an absolute triangle target (50,000 by default,
25,000/100,000 or a custom number) independently of texture resolution. Each
preview starts from the currently loaded original. Shape preservation has its
own setting and does not depend on the texture preset. A target is a goal,
not a forced count: error/topology/UV restrictions can leave more triangles.

Static simplification now includes normals, tangent data, UV coordinates and
texture-transform scale in its attribute error metric. Skinned simplification
also accounts for normalized packed normal/UV attributes and texture UV scale.
Static attachments are processed separately from skinned meshes.

Saved geometry reductions include portable history in glTF root extras. On
reimport, further geometry reduction is disabled; textures, animation-key
cleanup, geometry decompression and storage codecs remain available. Load the
original model to choose a different geometry goal. Older files without the
history marker cannot be identified reliably and should also be regenerated
from their original rather than passed through multiple percentage reductions.

Draco now uses Edgebreaker where supported. The encoder's sequential fallback
for morph targets/sparse data is retained by the underlying library. Tests also
verify the binding of bone weights and UV after vertex reordering.

The APK is named **Phoenix Forge Quality TEST** and uses the distinct ID
`com.phoenix.glbfbxconverter.qualitytest`. It can coexist with prior stable and
Codecs TEST apps. This does not claim Blender-equivalent visual quality for
all meshes; compare the preview and verify actual deformation on the target
Android device.

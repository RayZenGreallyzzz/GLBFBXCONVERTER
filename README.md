# GLB FBX Converter — Phoenix Model Forge

Standalone Android-first 3D converter and optimizer for GLB/FBX and Godot.

First version targets offline GLB optimization (textures to 512/1024/2048 px, preserved skeletons and animation clips) and FBX 7.4/7.5 export. FBX 2012/2013, polygon decimation and compressed extensions are planned but **not yet implemented**.

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

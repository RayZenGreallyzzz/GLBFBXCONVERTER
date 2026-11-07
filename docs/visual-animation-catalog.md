# Visual animation catalog

After opening a motion pack, **Каталог с живыми миниатюрами** displays six animated source schematics per page. Search matches filenames and folders. Each card shows the source path, duration and take count; a file with multiple takes initially shows its first take. The take selector below the catalog button has a separate animated schematic for the selected take.

**На персонаже** selects the source and starts the existing retarget preview when enough bones match. Incomplete mappings still require manual adjustment. Opening the catalog stops target playback and restores its pose. Selecting a card does not add an animation to the export; the existing explicit add/export controls remain responsible for that.

The schematic uses actual source motion, not a canned animation or a textured model thumbnail. It samples a private skeleton copy at approximately 12 fps for at most eight seconds, using at most 97 frames and 72 points. Horizontal root travel is centered while vertical motion remains visible. Humanoid axes are normalized from rest-pose bone landmarks. CMU BVH calibration frames are skipped when detected. Unrecognized skeletons use a bounded bone diagram. Pause controls stop either the inline schematic or all visible cards.

## Android resource use

- Canvas2D draws the schematics without creating another WebGL context. The main model renderer pauses while the dialog is open.
- Sources are read sequentially, only for the current six-card page. The GLB/glTF motion importer removes source meshes, materials and images before parsing; FBX parsing uses the existing worker.
- An LRU holds at most 24 sampled arrays or error records. It retains no source scenes, meshes, decoded textures, animation mixers or raw file buffers.
- Search, paging and closing abort obsolete requests. FBX workers terminate immediately. GLB reads/parsing check cancellation at safe boundaries; the next queue waits for the previous parser to finish, preventing overlapping source loads.
- Closing returns control only after pending work has drained. The selected file and target model remain available. Reopening with the same main search retains the page. Opening focuses Close, avoiding an unsolicited Android keyboard.

Source graphs and key arrays are never animated in place. Preview construction does not modify the original target GLB or its prepared export bytes. Existing byte-preserving animation append/export remains unchanged.

## Validation

Unit checks exercise source immutability, animated points, root travel, Y/Z-up normalization, sampling bounds and import cancellation. The production browser suite exercises moving canvas pixels, pause/resume, six-card pagination, cancellation/reopening, search, multi-format source errors and automatic target playback. Export/reimport still checks exact original image/geometry bytes. Physical Android memory/performance needs a device check; the separate **Forge VISUAL TEST** package installs alongside earlier test and stable packages.

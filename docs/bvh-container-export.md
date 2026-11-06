# Preserve the GLB container when adding BVH clips

The previous animation export serialized the Three.js viewport with
`GLTFExporter`. This decoded/re-encoded original WebP textures as PNG and
limited them to 4096px. A real character grew from 19.5MB to 51.4MB after adding
one approximately 39-second clip; only about 2MB belonged to animation tracks.

GLB sources now append BVH tracks directly to the original container.
Existing BIN bytes and JSON structures for meshes, skin, morph targets,
materials, images, texture transforms and compression extensions remain
unchanged. Existing animation channels and accessors are retained. Only new
animation metadata, FLOAT accessors, buffer views and binary arrays are added;
identical key-time arrays share an accessor. No image or geometry codec runs.

Targets are resolved through GLTFLoader node associations where available,
or unique original/sanitized names for newly generated body rigs. Ambiguous,
missing or repeated targets, malformed times, non-unit rotations and duplicate
clip names are rejected. BVH supports rotation, translation and scale with
LINEAR or STEP interpolation. The original bind pose and skin weights are never
serialized from the current viewport frame.

An output-size/task-memory check runs before allocating the output buffer and
uses the existing Android native available-memory query. The append operation
copies the original BIN once into its output, without a worker input copy or a
second model/image parse. Export sources from FBX and VRM retain their existing
Three.js export path; VRM conversion continues to require its existing warning.

Tests cover WebP plus raw/Meshopt/Draco geometry, unchanged BIN prefixes and
existing animation/morph metadata, animation sample round trips, explicit node
mapping for duplicate names and malformed-track rejection. The production
browser check creates a body rig with WebP, appends BVH, downloads/reimports it,
then adds another clip while checking that the previous container stays exact.
Private character files are not included in the repository.

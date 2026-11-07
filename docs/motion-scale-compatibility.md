# Animation-source scale rounding

Some exported Mixamo GLBs have nominal unit bone scales such as
`[1.00000036, 0.99999988, 1.00001550]`. The old absolute `1e-5` check rejected
these files before their animation clips or catalog thumbnails could load.

The motion adapter now accepts positive scale components within **0.005%**
relative error of their mean and assigns that mean uniformly to the private
bone-only source copy. Constant scale channels use the same relative policy.
Centimeter armatures retain their scale; the original source bytes and node
transforms are never edited. No additional model geometry, texture decoding
or dense animation buffers are introduced.

This is a rounding allowance, not support for arbitrary squash/stretch.
Negative, zero, non-finite, noticeably anisotropic and animated-changing
scales remain unsupported. An invalid bind transform now identifies the node
and its three scale components so a failure is actionable.

## Validation

Synthetic tests use the actual exported scale values, centimeter root motion,
small/large unit ranges, constant scale tracks, invalid/mirrored transforms,
changing scales, source immutability and finite visual/retarget output. The
production browser ZIP fixture includes a rounded-scale multi-take GLB and
checks source selection, animated catalog cards, retarget preview and exact
target bytes after animation export/reimport.

Private uploaded Mixamo batches contain 94 and 32 GLB animations; a larger
pack contains 156. Previously 93, 32 and 125 of those entries failed the scale
check. After this change all entries in these packs open and create finite
motion schematics. No user assets are committed.

Other uploaded archives include models without animations and `.blend` source
projects. Static characters belong in the main model loader, and Blender
projects require an export to a supported animation format. Scale rounding
does not turn those assets into animation sources.

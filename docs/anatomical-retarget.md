# Anatomical limb retargeting

The animation panel now enables **Подгонять T/A-позу плеч, рук и ног под движение
источника** and **Учитывать плоскости сгиба локтей и коленей** by default.

Previously, a donor lowering its arms from a T reference pose could add that
rotation to a character whose bind arms were already lowered in an A pose.
This could turn the arms inward across the torso. In the new pose-matching
mode, the donor's animated anatomical frame is aligned to the target body,
then expressed through the target bone's bind axes. The target's bone lengths,
joint positions, skin weights and inverse bind matrices are preserved.

Shoulder/elbow/wrist and hip/knee/ankle landmarks define a complete frame,
including the bend plane. A single direction vector cannot determine bone
roll. Nearly straight reference chains use body-forward landmarks to avoid
an unstable cross product. Full chains are required; incomplete or unfamiliar
chains retain the existing conservative mapping.

Optional hinge constraints operate in each target joint's anatomical bind
frame. They remove lateral elbow/knee swing and backward flexion, preserve
forearm pronation, and limit knee twist. The generic animation defaults are
0–155 degrees for elbow flexion, 0–160 for knee flexion and ±25 for knee twist.
These are an adjustable retarget policy, not rig-specific measured limits.
Uncheck the hinge option for intentionally exaggerated/stylized motion. The
pose-matching option does not automatically spread crossed arms: intentional
donor crossings remain possible.

The low-level `autoAdaptBvhClip` API retains its rest-delta default for existing
callers; the panel explicitly requests pose matching for GLB/glTF/FBX model
sources. BVH first-frame calibration behavior is retained. Turning off axis
alignment also disables anatomical frame correction.

This does not implement foot planting, hand-to-body collision avoidance or
automatic skin-weight repair. It cannot recover the original donor motion
from a previously retargeted clip. Re-transfer the original animation to apply
the complete correction, then review shoulders, elbows and knees before
adding it to an export.

Regression tests cover T-to-A arm lowering without unwanted crossing, elbow
and knee flexion under unrelated bone roll and limb lengths, hinge swing and
twist, donor pose preservation, and preservation of intentional arm crossing.

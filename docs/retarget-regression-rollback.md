# Anatomical retarget experiment withdrawn

The first anatomical retarget experiment (commit a58c5b5) is not recommended.
A user device recording showed unacceptable limb poses while trying KayKit
Idle_B, Holding_B and a Mixamo briefcase turn. Synthetic tests and successful
builds did not establish acceptable visual behavior on those actual sources.

This head restores the runtime source exactly to 06a51bd, including the
previous bone mapping, axis correction and rest-delta transfer. The new
absolute limb pose mode, bend-plane correction and generic hinge limits are
removed. The separate RETARGET RESTORED APK contains that previous behavior;
it does not claim to fix the original crossed-arm or joint problem.

A further fix requires reproducing a failing original donor clip against the
actual target bind rig, checking reference transforms, channel mappings and
bone directions, and comparing the source and target motion visually.

# Localized arm skin weights

Broad geodesic falloff mixed the upper arm, forearm and hand along most of the limb. During punches this contracted the muscle belly and shortened fingers, even with normalized weights and rotation-only animations.

The body rig now retains geodesic arm/torso separation and refines confidently identified arm surfaces. Bone-axis blend regions have quintic transitions around the elbow and wrist. The middle of each segment follows its own bone; distal hand vertices follow Hand. Shoulder confidence fades the correction into existing weights. At most four normalized influences remain per vertex. Guide placement and rest geometry still matter.

New body rigs use this calculation automatically. For a previously exported Forge body GLB, open **Скелет → Исправить веса рук**. Choose a source animation and switch **Исходник / Результат**, then save a separate GLB or apply the result to the working model. Computation runs in a cancellable worker. The original byte buffer remains untouched until explicit adoption.

Existing-rig repair is limited to the tagged Forge humanoid-body profile, one 27-joint skin and ordinary four-influence attributes. Unsupported/compressed geometry is rejected with an explanation. The output patches only JOINTS_0/WEIGHTS_0 bytes and adds the armLocalWeights marker. Mesh positions, normals, UVs, textures, inverse bind matrices, hierarchy and animation bytes are retained. The preview clones geometry and bones while sharing source textures, and uses the same animation time for both models.

Validation: unit tests cover segment localization, continuous transitions, placement/scale invariance, unchanged source data, binary preservation outside weights, GLB validation, duplicate repair/memory guards, and animated preview equivalence to saved bytes. The browser check exercises the actual worker, playing comparison, saving, unchanged original export, adopting and re-exporting the result with external network blocked.

For the separately supplied 175,358-vertex model with 16 clips, 34,687 vertices changed. All ten finger control distances retained rest length within floating point tolerance at sampled animation times; the previous punch shortened one 87.27 mm distance to 55.10 mm. This is a sampled regression on that model, not a guarantee for every character or continuous animation time. Standard linear skinning still contracts at extreme joint bends; this change does not add dual-quaternion skinning, finger joints, corrective morphs or universal volume preservation.

The isolated Android build is **Forge ARM FIX**, package `com.phoenix.glbfbxconverter.rigtest.arms1`. It inherits the embedded motion library and its Humanoids/Monsters groups.

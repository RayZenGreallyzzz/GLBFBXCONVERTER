// Preview-only lighting controls. Never modifies model or export materials.
import * as THREE from 'three';

export function createInspectionLighting(scene, hemisphere, keyLight) {
  const backLight = new THREE.DirectionalLight(0xffffff, 0);
  backLight.position.set(-5, 9, -7);
  scene.add(backLight);
  const uniformAmbient = new THREE.AmbientLight(0xffffff, 0);
  scene.add(uniformAmbient);

  const original = {
    hemiIntensity: hemisphere.intensity,
    hemiSky: hemisphere.color.clone(),
    hemiGround: hemisphere.groundColor.clone(),
    keyIntensity: keyLight.intensity,
  };
  let even = false;

  function setEvenLighting(enabled) {
    even = Boolean(enabled);
    if (even) {
      // Equal front/back fill: these lights cannot be made to alter an FBX/GLB
      // because they exist only in the preview THREE.Scene.
      hemisphere.intensity = 0.8;
      hemisphere.color.setHex(0xffffff);
      hemisphere.groundColor.setHex(0xd3dbe6);
      keyLight.intensity = 0.7;
      backLight.intensity = 0.7;
      uniformAmbient.intensity = 1.1;
    } else {
      hemisphere.intensity = original.hemiIntensity;
      hemisphere.color.copy(original.hemiSky);
      hemisphere.groundColor.copy(original.hemiGround);
      keyLight.intensity = original.keyIntensity;
      backLight.intensity = 0;
      uniformAmbient.intensity = 0;
    }
  }

  return { setEvenLighting, getEvenLighting:()=>even, backLight, uniformAmbient };
}

export function setInspectionRotation(orbit, enabled) {
  // Orbit rotates the camera, NOT the meshes. No geometry or material changes.
  orbit.autoRotate = Boolean(enabled);
  orbit.autoRotateSpeed = 1.6;
}

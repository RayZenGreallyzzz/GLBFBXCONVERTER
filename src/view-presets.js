import {Vector3} from 'three';

export const viewDirections={front:[0,0,1],back:[0,0,-1],left:[1,0,0],right:[-1,0,0]};

export function setCameraView(camera,orbit,center,direction,distance){
  const damping=orbit.enableDamping;
  orbit.enableDamping=false;
  orbit.update();
  orbit.target.copy(center);
  camera.up.set(0,1,0);
  camera.position.copy(center).addScaledVector(direction instanceof Vector3?direction:new Vector3(...direction),distance);
  orbit.update();
  orbit.enableDamping=damping;
  camera.updateMatrixWorld(true);
}

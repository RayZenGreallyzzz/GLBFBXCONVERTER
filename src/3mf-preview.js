// Low-memory viewport for large 3MF models. This is NOT mesh decimation:
// only the viewport index buffer is sampled; the full source mesh remains
// untouched for all conversion/export operations.
import * as THREE from 'three';

export function make3mfLightPreview(root,percent=25){
  if(!Number.isFinite(percent)||percent<=0||percent>=100)
    throw Error('Режим просмотра должен быть от 1 до 99%');
  const display=new THREE.Group();
  display.name='3MF lightweight viewport (non-exportable)';
  root.updateWorldMatrix(true,true);
  let sourceFaces=0,displayFaces=0;
  root.traverse(node=>{
    if(!node.isMesh||!node.visible)return;
    const geometry=node.geometry,position=geometry?.getAttribute('position');
    if(!position)return;
    const original=geometry.getIndex(),count=original?original.count:position.count;
    const faces=Math.floor(count/3);
    if(!faces)return;
    // Equidistant sampling covers the entire model, not only first N faces.
    const sampled=Math.max(1,Math.floor(faces*percent/100));
    const IndexArray=position.count>65535?Uint32Array:Uint16Array;
    const sampleIndices=new IndexArray(sampled*3);
    for(let i=0;i<sampled;i++){
      const face=Math.floor(i*faces/sampled);
      for(let j=0;j<3;j++)
        sampleIndices[i*3+j]=original?original.getX(face*3+j):face*3+j;
    }
    const proxyGeometry=new THREE.BufferGeometry();
    for(const key of Object.keys(geometry.attributes))
      proxyGeometry.setAttribute(key,geometry.getAttribute(key));
    proxyGeometry.setIndex(new THREE.BufferAttribute(sampleIndices,1));
    const proxy=new THREE.Mesh(proxyGeometry,node.material);
    proxy.name=node.name;
    proxy.matrixAutoUpdate=false;
    proxy.matrix.copy(node.matrixWorld);
    display.add(proxy);
    sourceFaces+=faces;
    displayFaces+=sampled;
  });
  if(!display.children.length)throw Error('3MF: отсутствует геометрия для предпросмотра');
  display.userData={sourceFaces,displayFaces,percent};
  return display;
}

export function dispose3mfLightPreview(group){
  if(!group)return;
  // Never dispose shared materials, textures or position/UV attributes.
  group.traverse(node=>{if(node.isMesh)node.geometry.dispose()});
}

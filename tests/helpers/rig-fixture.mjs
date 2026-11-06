import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {Document,Accessor,WebIO} from '@gltf-transform/core';
import {suggestRigGuides} from '../../src/rig-guides.js';

export async function rigFixture({scale=1,mirror=false,texture=null}={}){
 const bounds={min:[-.95,0,-.2],max:[.95,2,.2]},guides=suggestRigGuides(bounds),geometries=[];
 const sphere=(p,r)=>{const g=new THREE.SphereGeometry(r,12,10);g.translate(...p);geometries.push(g)};
 const limb=(a,b,r)=>{const start=new THREE.Vector3(...a),end=new THREE.Vector3(...b),d=end.clone().sub(start),g=new THREE.CylinderGeometry(r,r,d.length()+r*.7,12,4);g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),d.normalize()));g.translate(...start.add(end).multiplyScalar(.5).toArray());geometries.push(g)};
 sphere(guides.head,.14);limb(guides.hips,guides.chest,.22);limb(guides.chest,guides.neck,.14);limb(guides.neck,guides.head,.09);
 for(const side of ['left','right']){
  limb(guides.chest,guides[side+'Shoulder'],.13);limb(guides[side+'Shoulder'],guides[side+'Elbow'],.09);limb(guides[side+'Elbow'],guides[side+'Wrist'],.07);sphere(guides[side+'Wrist'],.07);
  limb(guides.hips,guides[side+'Hip'],.15);limb(guides[side+'Hip'],guides[side+'Knee'],.12);limb(guides[side+'Knee'],guides[side+'Ankle'],.09);limb(guides[side+'Ankle'],guides[side+'Toe'],.06);sphere(guides[side+'Toe'],.06);
 }
 const g=mergeGeometries(geometries),doc=new Document(),buffer=doc.createBuffer(),a=(values,type)=>doc.createAccessor().setBuffer(buffer).setType(type).setArray(values);
 const prim=doc.createPrimitive().setAttribute('POSITION',a(g.getAttribute('position').array,Accessor.Type.VEC3)).setAttribute('NORMAL',a(g.getAttribute('normal').array,Accessor.Type.VEC3)).setAttribute('TEXCOORD_0',a(g.getAttribute('uv').array,Accessor.Type.VEC2)).setIndices(a(new Uint32Array(g.index.array),Accessor.Type.SCALAR));
 const mat=doc.createMaterial('Body');if(texture)mat.setBaseColorTexture(doc.createTexture('Color').setMimeType('image/png').setImage(texture));prim.setMaterial(mat);
 const mesh=doc.createMesh('Body').addPrimitive(prim),node=doc.createNode('OriginalBody').setMesh(mesh).setScale([scale*(mirror?-1:1),scale,scale]),parent=doc.createNode('Placement').setTranslation([.25*scale,-.5*scale,.1*scale]).addChild(node);doc.createScene().addChild(parent);
 const worldGuides=Object.fromEntries(Object.entries(guides).map(([k,p])=>[k,[p[0]*scale+.25*scale,p[1]*scale-.5*scale,p[2]*scale+.1*scale]]));
 // Mirroring the symmetric test mesh preserves the same anatomical guide draft.
 for(const geo of geometries)geo.dispose();g.dispose();return {bytes:await new WebIO().writeBinary(doc),guides:worldGuides};
}

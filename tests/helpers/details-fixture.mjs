import {BoxGeometry} from 'three';
import {Document,WebIO} from '@gltf-transform/core';

export async function boxGlb(name='Box',depth=1){
 const doc=new Document(),buf=doc.createBuffer(),box=new BoxGeometry(1,1,depth);
 const mesh=doc.createMesh(name),prim=doc.createPrimitive();
 for(const [key,semantic,type] of [['position','POSITION','VEC3'],['normal','NORMAL','VEC3'],['uv','TEXCOORD_0','VEC2']])
   prim.setAttribute(semantic,doc.createAccessor().setType(type).setBuffer(buf).setArray(box.attributes[key].array));
 prim.setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buf).setArray(box.index.array));
 mesh.addPrimitive(prim.setMaterial(doc.createMaterial('Материал').setBaseColorFactor([.6,.6,.6,1])));
 doc.createScene().addChild(doc.createNode(name).setMesh(mesh));
 box.dispose();
 return new WebIO().writeBinary(doc);
}

import {Document,WebIO} from '@gltf-transform/core';

// Separate skull, jaw and torso triangles keep the vertex selection observable.
export async function mouthFixture() {
  const doc=new Document(), buffer=doc.createBuffer();
  const vertices=new Float32Array([
    -.034,.69,.115, .034,.69,.115, 0,.708,.132,
    -.035,.755,.15, .035,.755,.15, 0,.949,.08,
    -.15,-.952,-.22, .15,-.952,-.22, 0,0,.23
  ]);
  const pos=doc.createAccessor().setType('VEC3').setArray(vertices).setBuffer(buffer);
  const primitive=doc.createPrimitive().setAttribute('POSITION',pos);
  const mesh=doc.createMesh('Mask').addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode('DemonFixture').setMesh(mesh));
  return new WebIO().writeBinary(doc);
}

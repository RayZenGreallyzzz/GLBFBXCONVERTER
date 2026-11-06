import {Document,WebIO,Accessor} from '@gltf-transform/core';
import {KHRTextureBasisu} from '@gltf-transform/extensions';
export async function compressionFixture({texture=null,textureMime='image/ktx2',morph=false,segments=20}={}){
 const doc=new Document(),buffer=doc.createBuffer();
 const acc=(arr,type)=>doc.createAccessor().setBuffer(buffer).setType(type).setArray(arr);
 const positions=[],uv=[],joints=[],weights=[],indices=[];
 const n=segments;
 for(let y=0;y<=n;y++)for(let x=0;x<=n;x++){
  positions.push(x/n,y/n,Math.sin(x)*.005);uv.push(x/n,y/n);
  joints.push(0,1,0,0);weights.push(1-x/n,x/n,0,0);
 }
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){
  const a=y*(n+1)+x;indices.push(a,a+1,a+n+1,a+1,a+n+2,a+n+1);
 }
 const prim=doc.createPrimitive()
  .setAttribute('POSITION',acc(new Float32Array(positions),Accessor.Type.VEC3))
  .setAttribute('TEXCOORD_0',acc(new Float32Array(uv),Accessor.Type.VEC2))
  .setAttribute('JOINTS_0',acc(new Uint16Array(joints),Accessor.Type.VEC4))
  .setAttribute('WEIGHTS_0',acc(new Float32Array(weights),Accessor.Type.VEC4))
  .setIndices(acc(new Uint16Array(indices),Accessor.Type.SCALAR));
 if(morph){
  prim.addTarget(doc.createPrimitiveTarget().setAttribute('POSITION',
   acc(new Float32Array(positions.length).fill(.001),Accessor.Type.VEC3)));
 }
 if(texture){
  if(textureMime==='image/ktx2')doc.createExtension(KHRTextureBasisu).setRequired(true);
  const image=doc.createTexture('Albedo').setMimeType(textureMime).setImage(texture);
  prim.setMaterial(doc.createMaterial('TestMaterial').setBaseColorTexture(image).setAlphaMode('BLEND'));
 }
 const hips=doc.createNode('Hips'),arm=doc.createNode('Arm');hips.addChild(arm);
 const matrices=new Float32Array(32);for(let k=0;k<2;k++)for(let i=0;i<4;i++)matrices[k*16+i*5]=1;
 const skin=doc.createSkin('Skeleton').addJoint(hips).addJoint(arm)
  .setInverseBindMatrices(acc(matrices,Accessor.Type.MAT4));
 const mesh=doc.createMesh('Body').addPrimitive(prim);
 if(morph)mesh.setWeights([.2]);
 doc.createScene().addChild(hips).addChild(doc.createNode('Character').setMesh(mesh).setSkin(skin));
 const sampler=doc.createAnimationSampler().setInput(acc(new Float32Array([0,.5,1]),Accessor.Type.SCALAR))
  .setOutput(acc(new Float32Array([0,0,0,0,.1,0,0,0,0]),Accessor.Type.VEC3));
 const channel=doc.createAnimationChannel().setSampler(sampler).setTargetNode(arm).setTargetPath('translation');
 doc.createAnimation('Wave').addSampler(sampler).addChannel(channel);
 return new WebIO().registerExtensions([KHRTextureBasisu]).writeBinary(doc);
}
export function pixels(){
 const data=new Uint8Array(16*16*4);
 for(let y=0;y<16;y++)for(let x=0;x<16;x++){
  const i=(y*16+x)*4;
  data.set([x<8?240:10,y<8?20:230,30,x<8?255:60],i);
 }
 return {data,width:16,height:16};
}

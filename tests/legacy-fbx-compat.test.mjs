import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { FBXExporter } from '@comfyorg/fbx-exporter-three';
import { inspectFbx } from '../src/format.js';
import { verifyLegacyFbxMetadata } from '../src/legacy-fbx.js';

function model() {
  const group = new THREE.Group(); group.name='Humanoid';
  const hip = new THREE.Bone(); hip.name='Hips'; hip.position.y=0.8;
  const spine = new THREE.Bone(); spine.name='Spine'; spine.position.y=.4;
  hip.add(spine);group.add(hip);
  const geo = new THREE.BoxGeometry(.7,1.8,.5,2,4,2);
  const v=geo.getAttribute('position').count, indices=new Uint16Array(v*4), weights=new Float32Array(v*4);
  for(let i=0;i<v;i++){indices[i*4]=0;weights[i*4]=1;}
  geo.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));
  geo.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const mesh=new THREE.SkinnedMesh(geo,new THREE.MeshStandardMaterial());
  mesh.name='Body';group.add(mesh);mesh.bind(new THREE.Skeleton([hip,spine]));
  const clip=new THREE.AnimationClip('Idle',1,[
    new THREE.QuaternionKeyframeTrack(spine.uuid+'.quaternion',[0,1],[0,0,0,1,0,0,0,1])
  ]);
  return {group,clip};
}
for(const version of [7200,7300]){
  test('FBX '+version+' produced by writer loads back with skinned mesh and bones',async()=>{
    const {group,clip}=model();
    const bytes=await new FBXExporter().parseAsync(group,{
      version,preset:'threejs',fps:30,embedTextures:false,animations:[clip],
      onlyVisible:false
    });
    const v=inspectFbx(bytes);
    assert.equal(v.version,version,'real binary FBX version is '+version);
    const meta=verifyLegacyFbxMetadata(bytes,version);
    assert.equal(meta.internalVersion,version,'FBXHeaderExtension is genuine target version');
    assert.ok(bytes.byteLength>1000);
    const view=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    const result=new FBXLoader().parse(view,'');
    let skinned=0,bones=0,verts=0;
    result.traverse(o=>{if(o.isSkinnedMesh){skinned++;verts+=o.geometry.attributes.position.count;}if(o.isBone)bones++;});
    assert.ok(skinned>=1,'skin mesh must survive');
    assert.ok(bones>=2,'bone hierarchy must survive');
    assert.ok(verts>0,'vertices must survive');
    assert.ok((result.animations||[]).length>=1,'animation must survive');
  });
}

test('rejects a mismatch between binary FBX header and internal version metadata',async()=>{
 const {group,clip}=model();
 const data=await new FBXExporter().parseAsync(group,{
   version:7400,preset:'threejs',animations:[clip],embedTextures:false
 });
 const hacked=new Uint8Array(data);
 new DataView(hacked.buffer).setUint32(23,7300,true);
 assert.throws(()=>verifyLegacyFbxMetadata(hacked,7300),/FBXHeaderExtension/);
});

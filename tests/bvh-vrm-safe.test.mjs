import test from 'node:test';
import assert from 'node:assert/strict';
import { importBvhMotion } from '../src/bvh-motion.js';
import { inspectVrm } from '../src/vrm-safe.js';
import { importAdditional,validateImportFiles,outputNameExt,SUPPORTED_INPUTS,SUPPORTED_OUTPUTS } from '../src/model-formats.js';

const bvh=[
'HIERARCHY','ROOT Hips','{',
'  OFFSET 0 0 0',
'  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation',
'  JOINT Chest','  {',
'    OFFSET 0 1 0',
'    CHANNELS 3 Zrotation Xrotation Yrotation',
'    End Site','    {','      OFFSET 0 1 0','    }',
'  }','}',
'MOTION','Frames: 2','Frame Time: 0.0333333',
'0 0 0 0 0 0 0 0 0','0 0 0 10 0 0 5 0 0'
].join('\n')+'\n';
function glb(json){
 json={asset:{version:'2.0'},...json};
 const data=Buffer.from(JSON.stringify(json));
 const padded=4*Math.ceil(data.byteLength/4);
 const bytes=Buffer.alloc(20+padded,0x20);
 bytes.writeUInt32LE(0x46546c67,0);
 bytes.writeUInt32LE(2,4);
 bytes.writeUInt32LE(bytes.length,8);
 bytes.writeUInt32LE(padded,12);
 bytes.writeUInt32LE(0x4e4f534a,16);
 data.copy(bytes,20);
 return new Uint8Array(bytes);
}
test('BVH file parses skeleton, helper, and motion animation with 2 frames',async()=>{
 const file={name:'Hero_Idle.bvh',size:bvh.length};
 const parsed=await importAdditional(file,new TextEncoder().encode(bvh).buffer,[file]);
 assert.equal(parsed.bvhOnly,true);
 assert.equal(parsed.root.children[0].isBone,true);
 assert.equal(parsed.root.children[1].isSkeletonHelper,true);
 assert.equal(parsed.clips.length,1);
 assert.equal(parsed.clips[0].name,'Hero_Idle');
 assert.ok(parsed.clips[0].tracks.length>=4);
 assert.ok(parsed.clips[0].duration>0);
 assert.match(parsed.notice,/перенос на другой риг пока не выполняется/);
});
test('reject malformed and oversized BVH without silently using a wrong rig',()=>{
 assert.throws(()=>importBvhMotion('MOTION\nFrames: 1'),/HIERARCHY/);
 assert.throws(()=>importBvhMotion(bvh.replace('Frames: 2','Frames: 18001')),/18 000/);
 assert.ok(SUPPORTED_INPUTS.includes('bvh'));
 assert.ok(SUPPORTED_OUTPUTS.includes('vrm-source'));
});
test('recognize exact VRM 0 metadata and preserve byte-identical source',()=>{
 const source=glb({extensions:{VRM:{specVersion:'0.0',humanoid:{humanBones:[{bone:'hips',node:0}]}}}});
 const result=inspectVrm(source);
 assert.equal(result.vrmVersion,'VRM 0.x');
 assert.deepEqual(Buffer.from(source),Buffer.from(new Uint8Array(source)));
 assert.equal(outputNameExt('vrm-source'),'.vrm');
});
test('recognize VRM 1.0 only with humanoid data',()=>{
 const source=glb({extensions:{VRMC_vrm:{specVersion:'1.0',humanoid:{humanBones:{hips:{node:0}}}}}});
 assert.equal(inspectVrm(source).vrmVersion,'VRM 1.0');
 assert.throws(()=>inspectVrm(glb({extensions:{VRMC_vrm:{specVersion:'1.0'}}})),/Humanoid/);
});
test('never falsely treat a generic GLB as full VRM',()=>{
 const source=glb({scenes:[]});
 assert.throws(()=>inspectVrm(source),/Обычный GLB нельзя переименовать/);
 const file={name:'Motion.bvh',size:bvh.length};
 assert.equal(validateImportFiles([file]),file);
});

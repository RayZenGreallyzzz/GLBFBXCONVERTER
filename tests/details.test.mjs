import test from 'node:test';
import assert from 'node:assert/strict';
import {Matrix4,Quaternion,Vector3} from 'three';
import {WebIO} from '@gltf-transform/core';
import validator from 'gltf-validator';
import {cutDetail,detailPiece,paintCut,CUT_MATERIAL} from '../src/detail-knife.js';
import {assembleDetails} from '../src/details-assemble.js';
import {fingerFixture} from './helpers/finger-fixture.mjs';

import {boxGlb} from './helpers/details-fixture.mjs';

const validate=async bytes=>{
 const report=await validator.validateBytes(bytes);
 assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues.messages.filter(x=>x.severity===0)));
};

test('finite box subtraction closes both cross sections and supports keeping one side',async()=>{
 const bytes=await boxGlb(), result=await cutDetail(bytes,{
   matrix:new Matrix4().makeScale(.12,2,2).toArray(),color:[.3,.05,.01]
 });
 assert.equal(result.closed,2);assert.equal(result.open,0);assert.ok(result.changed>0);
 const io=new WebIO(), view=await io.readBinary(result.bytes),parts=view.getRoot().listMeshes()[0].listPrimitives();
 assert.equal(parts.length,3);
 const keptVertices=parts[0].getAttribute('POSITION').getArray(), ids=parts[0].getIndices().getArray();
 for(let i=0;i<ids.length;i+=3) {
   const coords=[ids[i],ids[i+1],ids[i+2]].map(id=>keptVertices[id*3]);
   assert.ok(coords.every(x=>x<-.05999)||coords.every(x=>x>.05999),'triangle crosses the removed gap');
 }
 const piece=await detailPiece(result.bytes,{node:0,primitive:0,face:0});
 assert.ok(piece.faces<piece.count);
 const kept=await detailPiece(result.bytes,{node:0,primitive:0,face:0,mode:'keep'});
 const cut=await paintCut(kept.bytes,{color:[.1,.2,.3]});
 const redone=await io.readBinary(cut.bytes);
 assert.deepEqual(redone.getRoot().listMaterials().find(m=>m.getName()===CUT_MATERIAL).getBaseColorFactor(),[.1,.2,.3,1]);
 await Promise.all([result.bytes,kept.bytes,cut.bytes].map(validate));
});

test('a finite cutter leaves opposite and out-of-bounds surfaces untouched',async()=>{
 const base=await boxGlb();
 const pose=new Matrix4().compose(new Vector3(.49,0,0),new Quaternion(),new Vector3(.2,.3,.3));
 const result=await cutDetail(base,{matrix:pose.toArray(),close:false});
 const doc=await new WebIO().readBinary(result.bytes), part=doc.getRoot().listMeshes()[0].listPrimitives()[0];
 const p=part.getAttribute('POSITION').getArray(),ix=part.getIndices().getArray();
 assert.ok(ix.some(id=>p[id*3]<-.49));
 assert.ok(ix.some(id=>p[id*3]>.49&&Math.abs(p[id*3+1])>.4));
 await assert.rejects(cutDetail(base,{matrix:new Matrix4().makeTranslation(3,3,3).toArray()}),/не пересекла/);
});

test('places several parts on the same skin and layers new bone keys over a body clip',async()=>{
 const {bytes:base}=await fingerFixture(), detail=await boxGlb('Крыло'), io=new WebIO(), original=await io.readBinary(base);
 const joints=original.getRoot().listSkins()[0].listJoints();
 const head=original.getRoot().listNodes().indexOf(joints.find(n=>n.getName()==='mixamorigHead'));
 const size=new Matrix4().makeScale(.3,.2,.15).setPosition(0,1.8,.3).toArray();
 const groups=[{bytes:detail,matrix:size,name:'Крыло',parent:head,
   points:[[0,1.8,.3],[.1,1.85,.3],[.17,1.9,.3]],animation:{name:'Мах с телом',body:0,duration:1,
   tracks:[{bone:0,keys:[{time:.5,value:[20,0,0]}]},{bone:1,keys:[{time:.6,value:[0,35,0]}]}]}},
   {bytes:detail,matrix:new Matrix4().makeTranslation(0,1.5,-.3).toArray(),name:'Рог',parent:head},
   {bytes:detail,matrix:size,name:'Ухо',parent:head,points:[[0,1.8,.3],[.1,1.85,.3]],animation:{body:0,duration:1,
   tracks:[{bone:0,keys:[{time:.4,value:[0,0,15]}]}]}}];
 const output=await assembleDetails(base,groups), made=await io.readBinary(output.bytes);
 assert.equal(output.clips,2);
 assert.equal(made.getRoot().listSkins()[0].listJoints().length,joints.length+3);
 assert.equal(made.getRoot().listNodes().filter(n=>['Крыло','Рог','Ухо'].includes(n.getName())&&!!n.getSkin()).length,3);
 const clips=made.getRoot().listAnimations();
 assert.equal(clips[1].listChannels().length,4);
 assert.deepEqual(clips[0].listSamplers()[0].getOutput().getArray(),original.getRoot().listAnimations()[0].listSamplers()[0].getOutput().getArray());
 await validate(output.bytes);
});

test('extends the existing character mesh with a tail chain and preserves weights outside its region',async()=>{
 const {bytes:base}=await fingerFixture({tail:true}), io=new WebIO(), original=(await io.readBinary(base)).getRoot();
 const skin=original.listSkins()[0], parent=original.listNodes().indexOf(skin.listJoints()[0]);
 const tail={tail:true,name:'Хвост',parent,radius:.095,points:[[0,1.09,-.075],[0,1,-.30],[0,.91,-.53],[0,.82,-.76]],
   animation:{body:0,duration:1,tracks:[{bone:1,keys:[{time:.5,value:[0,20,0]}]}]}};
 const result=await assembleDetails(base,[tail]), modified=(await io.readBinary(result.bytes)).getRoot();
 const first=skin.listJoints().length;
 assert.ok(result.tailVertices>100);
 assert.equal(modified.listSkins()[0].listJoints().length,first+3);
 assert.equal(modified.listNodes().filter(n=>n.getMesh()).length,1);
 const weights=root=>root.listMeshes()[0].listPrimitives()[0];
 const ids=weights(modified).getAttribute('JOINTS_0').getArray(), previous=weights(original).getAttribute('JOINTS_0').getArray();
 const positions=weights(original).getAttribute('POSITION').getArray();
 assert.ok(ids.some(id=>id>=first));
 for(let i=0;i<positions.length/3;i++)if(positions[i*3+2]>=-.07){
   assert.deepEqual(ids.slice(i*4,i*4+4),previous.slice(i*4,i*4+4));
 }
 assert.equal(modified.listAnimations()[1].listChannels().length,2);
 await validate(result.bytes);
});

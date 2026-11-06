import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {ModelPlayback} from '../src/model-playback.js';

function rig(){
 const root=new THREE.Group(),hips=new THREE.Bone(),head=new THREE.Bone(),ear=new THREE.Bone(),tail=new THREE.Bone();
 hips.name='Hips';head.name='Head';ear.name='Ear';tail.name='Tail';head.position.y=1;ear.position.set(.2,.2,0);tail.position.z=.3;hips.add(head,tail);head.add(ear);root.add(hips);
 const clip=(name,node,axis)=>new THREE.AnimationClip(name,1,[new THREE.QuaternionKeyframeTrack(node+'.quaternion',[0,.5,1],[0,0,0,1,...new THREE.Quaternion().setFromAxisAngle(axis,.6).toArray(),0,0,0,1])]);
 return {root,hips,head,ear,tail,clips:[clip('Ears','Ear',new THREE.Vector3(0,0,1)),clip('Tail','Tail',new THREE.Vector3(1,0,0))]};
}
function pose(root){const result=[];root.traverse(n=>result.push([n.name,...n.position,...n.quaternion,...n.scale]));return result}

test('comparison uses the same clip and time on both graphs; pause and resume preserve the current frame',()=>{
 const source=rig(),result=rig(),player=new ModelPlayback();player.setModels(source.root,source.clips,result.root,result.clips);player.play(0);
 for(let i=0;i<4;i++){player.update(.1);assert.deepEqual(pose(result.root),pose(source.root))}
 assert.ok(Math.abs(source.ear.quaternion.z)>.1);assert.equal(source.tail.quaternion.x,0);
 player.pause();const paused=pose(source.root),time=player.time;player.update(.1);assert.deepEqual(pose(source.root),paused);assert.equal(player.time,time);
 player.play(0);player.update(.1);assert.ok(player.time>time);assert.deepEqual(pose(result.root),pose(source.root));
 const oldTime=player.time;player.update(10);assert.ok(Math.abs(player.time-oldTime-.1)<1e-10,'background tab must not jump through a long animation interval');
});

test('changing clips, replacing models and disposal restore their original transforms without altering tracks',()=>{
 const source=rig(),result=rig(),player=new ModelPlayback(),original=pose(source.root),tracks=source.clips.map(c=>Array.from(c.tracks[0].values));
 player.setModels(source.root,source.clips,result.root,result.clips);player.play(0);player.update(.1);player.play(1);player.update(.1);
 assert.equal(source.ear.quaternion.z,0);assert.ok(source.tail.quaternion.x>0);assert.deepEqual(pose(result.root),pose(source.root));
 player.setModels(null);assert.deepEqual(pose(source.root),original);assert.deepEqual(pose(result.root),original);assert.equal(player.models.length,0);assert.equal(player.active,false);
 assert.deepEqual(source.clips.map(c=>Array.from(c.tracks[0].values)),tracks);
 player.setModels(source.root,source.clips);player.play(0);player.update(.1);player.dispose();assert.deepEqual(pose(source.root),original);assert.equal(player.models.length,0);
});

test('missing, mismatched and zero-duration clips fail with restored poses and no active mixers',()=>{
 const source=rig(),result=rig(),player=new ModelPlayback(),original=pose(source.root);result.clips[0].name='Other';
 player.setModels(source.root,source.clips,result.root,result.clips);assert.throws(()=>player.play(0),/не совпадают/);assert.equal(player.active,false);assert.deepEqual(pose(source.root),original);
 player.setModels(source.root,[new THREE.AnimationClip('Empty',0,[])]);assert.throws(()=>player.play(0),/длительности/);assert.equal(player.active,false);
 player.dispose();assert.throws(()=>player.play(0),/не найдена/);
});

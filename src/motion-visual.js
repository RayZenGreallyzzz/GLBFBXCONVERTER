import * as THREE from 'three';
import {findCanonicalBone,canonicalBone} from './animation-retarget.js';
import {detectCmuCalibration} from './bvh-auto-adapt.js';

const yaw=.48,pitch=.12;
const project=p=>[p[0]*Math.cos(yaw)+p[2]*Math.sin(yaw),p[1]*Math.cos(pitch)-(-p[0]*Math.sin(yaw)+p[2]*Math.cos(yaw))*Math.sin(pitch)];
const roles=['hips','spine','spine1','spine2','neck','head',...['left','right'].flatMap(s=>['shoulder','arm','forearm','hand','upleg','leg','foot','toebase'].map(p=>s+p))];

// Sample a private bone-only copy. The result contains small arrays, never a
// loaded scene, source mesh, texture, animation mixer or original file bytes.
export function createMotionVisual(source,clip=source.clip){
 if(!clip||!Number.isFinite(clip.duration)||clip.duration<=0)throw Error('У движения нет длительности');
 const graph=source.root?.clone(true)||new THREE.Group();if(!source.root){const set=new Set(source.skeleton.bones);for(const bone of set)if(!set.has(bone.parent))graph.add(bone.clone(true))}
 graph.updateMatrixWorld(true);const bones=[];graph.traverse(n=>{if(n.isBone)bones.push(n)});if(!bones.length)throw Error('Нет костей для миниатюры');
 const joint=role=>findCanonicalBone(bones,role),hip=joint('hips'),head=joint('head'),left=joint('leftarm')||joint('leftshoulder'),right=joint('rightarm')||joint('rightshoulder');
 const pos=n=>new THREE.Vector3().setFromMatrixPosition(n.matrixWorld),basis=new THREE.Quaternion();
 if(hip&&head&&left&&right){const x=pos(left).sub(pos(right)),y=pos(head).sub(pos(hip));if(x.lengthSq()>1e-12){x.normalize();y.addScaledVector(x,-y.dot(x));if(y.lengthSq()>1e-12){y.normalize();basis.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,x.clone().cross(y).normalize()))}}}
 const inverse=basis.clone().invert(),points=[],edges=[],byRole=new Map(),humanoid=hip&&head&&roles.filter(r=>joint(r)).length>=8;
 const add=(bone,name,offset=null)=>{points.push({bone,name,offset});return points.length-1};
 if(humanoid){for(const role of roles){const bone=joint(role);if(bone)byRole.set(role,add(bone,role))}
  const chain=(names,side=0,thick=0)=>{const list=names.filter(n=>byRole.has(n)).map(n=>byRole.get(n));for(let i=1;i<list.length;i++)edges.push([list[i-1],list[i],side,thick])};
  chain(['hips','spine','spine1','spine2','neck','head'],0,1);const chest=['spine2','spine1','spine','hips'].find(r=>byRole.has(r));for(const [side,color]of [['left',1],['right',2]]){chain([chest,side+'shoulder',side+'arm',side+'forearm',side+'hand'],color);chain(['hips',side+'upleg',side+'leg',side+'foot',side+'toebase'],color)}
 }else{const selected=bones.slice(0,48),indices=new Map();for(const b of selected)indices.set(b,add(b,b.name));for(const b of selected)if(indices.has(b.parent))edges.push([indices.get(b.parent),indices.get(b),0,0])}
 const rest=points.map(p=>pos(p.bone)),origin=hip?pos(hip):new THREE.Box3().setFromPoints(rest).getCenter(new THREE.Vector3()),restLocal=rest.map(p=>p.clone().sub(origin).applyQuaternion(inverse)),box=new THREE.Box3().setFromPoints(restLocal),height=Math.max(box.max.y-box.min.y,box.getSize(new THREE.Vector3()).length()*.3,1e-6),scale=1/height;
 const tip=(bone,index,direction,size,name)=>{const local=direction.normalize().multiplyScalar(height*size).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert()),i=add(bone,name,local);edges.push([index,i,0,2]);return i};
 let nose=-1;if(humanoid){nose=tip(head,byRole.get('head'),new THREE.Vector3(0,0,1).applyQuaternion(basis),.11,'face');for(const side of ['left','right']){const hand=joint(side+'hand'),forearm=joint(side+'forearm');if(hand&&forearm)tip(hand,byRole.get(side+'hand'),pos(hand).sub(pos(forearm)),.08,side+'palm')}}
 else{const originalCount=points.length;for(let i=0;i<originalCount&&points.length<72;i++){const b=points[i].bone;if(!b.children.some(n=>n.isBone)){const dir=b.parent?.isBone?pos(b).sub(pos(b.parent)):new THREE.Vector3(0,1,0);if(dir.lengthSq()<1e-12)dir.set(0,1,0);tip(b,i,dir,.18,b.name+'Tip')}}}
 let start=0;if(source.kind==='bvh'&&detectCmuCalibration(source.skeleton,clip))start=clip.tracks.find(t=>t.times.length>1)?.times[1]||0;
 const duration=Math.min(8,clip.duration-start);if(!(duration>0))throw Error('Нет кадров для миниатюры');const frames=Math.min(97,Math.max(2,Math.ceil(duration*12)+1)),values=new Float32Array(frames*points.length*3),mixer=new THREE.AnimationMixer(graph),action=mixer.clipAction(clip).setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();
 const bounds={minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity},floor=box.min.y*scale;
 try{for(let frame=0;frame<frames;frame++){
  mixer.setTime(Math.min(clip.duration-1e-7,start+duration*frame/(frames-1)));graph.updateMatrixWorld(true);const displacement=hip?pos(hip).sub(origin).applyQuaternion(inverse).multiplyScalar(scale):new THREE.Vector3();
  for(let i=0;i<points.length;i++){const p=points[i],v=pos(p.bone);if(p.offset)v.add(p.offset.clone().applyQuaternion(p.bone.getWorldQuaternion(new THREE.Quaternion())));v.sub(origin).applyQuaternion(inverse).multiplyScalar(scale);v.x-=displacement.x;v.z-=displacement.z;
   if(!v.toArray().every(Number.isFinite))throw Error('Некорректная поза миниатюры');v.toArray(values,(frame*points.length+i)*3);const q=project(v.toArray());bounds.minX=Math.min(bounds.minX,q[0]);bounds.maxX=Math.max(bounds.maxX,q[0]);bounds.minY=Math.min(bounds.minY,q[1]);bounds.maxY=Math.max(bounds.maxY,q[1]);
  }
 }}finally{mixer.stopAllAction();mixer.uncacheRoot(graph)}
 if(!values.every(Number.isFinite))throw Error('Некорректные координаты миниатюры');bounds.minY=Math.min(bounds.minY,floor)-.12;bounds.maxY+=.16;bounds.minX=Math.min(bounds.minX,-.35)-.1;bounds.maxX=Math.max(bounds.maxX,.35)+.1;
 return {name:clip.name,fullDuration:clip.duration,duration,frames,points:points.length,values,edges,head:byRole.get('head')??-1,nose,floor,humanoid,bounds,clipCount:source.clips?.length||1,pointNames:points.map(p=>p.name)};
}

export class MotionCanvas{
 constructor(canvas){this.canvas=canvas;this.ctx=canvas.getContext('2d',{alpha:false});this.data=null;this.elapsed=0;this.playing=true;this.last=null;this.frame=-1}
 set(data){this.data=data;this.elapsed=0;this.last=null;this.frame=-1;this.playing=true;this.draw(0)}
 clear(){this.data=null;this.frame=-1;this.last=null;this.canvas.removeAttribute('data-frame');this.ctx?.clearRect(0,0,this.canvas.width,this.canvas.height)}
 toggle(){this.playing=!this.playing;return this.playing}
 update(now,active=true){const delta=this.last===null?0:Math.max(0,Math.min(now-this.last,.15));this.last=now;if(!active||!this.data)return;if(this.playing)this.elapsed+=delta;const frame=Math.min(this.data.frames-1,Math.floor(this.elapsed%this.data.duration/this.data.duration*this.data.frames));if(frame!==this.frame)this.draw(frame)}
 draw(frame){if(!this.ctx||!this.data)return;const d=this.data,ctx=this.ctx,w=this.canvas.width,h=this.canvas.height,b=d.bounds,s=Math.min((w-28)/(b.maxX-b.minX),(h-26)/(b.maxY-b.minY)),cx=(b.minX+b.maxX)/2,cy=(b.minY+b.maxY)/2;
  const screen=p=>{const q=project(p);return [w/2+(q[0]-cx)*s,h/2-(q[1]-cy)*s]},point=i=>Array.from(d.values.subarray((frame*d.points+i)*3,(frame*d.points+i)*3+3));
  ctx.fillStyle='#0b1729';ctx.fillRect(0,0,w,h);ctx.lineCap='round';ctx.strokeStyle='#25405a';ctx.lineWidth=1;for(let i=-3;i<=3;i++){for(const segment of [[[i*.2,d.floor,-.6],[i*.2,d.floor,.6]],[[-.6,d.floor,i*.2],[.6,d.floor,i*.2]]]){const a=screen(segment[0]),c=screen(segment[1]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...c);ctx.stroke()}}
  const colors=['#c8d9ec','#46d4e9','#f4bd69'];for(const [a,c,side,thick]of d.edges){const p=screen(point(a)),q=screen(point(c));ctx.strokeStyle=colors[side];ctx.lineWidth=Math.max(2,s*(thick===2?.016:thick===1?.07:.038));ctx.beginPath();ctx.moveTo(...p);ctx.lineTo(...q);ctx.stroke()}
  for(let i=0;i<d.points;i++){if(i===d.nose)continue;const p=screen(point(i));ctx.fillStyle=i===d.head?'#edf3fc':'#dce8f5';ctx.beginPath();ctx.arc(...p,i===d.head?Math.max(5,s*.066):Math.max(1.7,s*.018),0,Math.PI*2);ctx.fill()}
  if(d.head>=0&&d.nose>=0){const a=screen(point(d.head)),c=screen(point(d.nose));ctx.strokeStyle='#506c86';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...c);ctx.stroke()}
  this.frame=frame;this.canvas.dataset.frame=String(frame);this.canvas.dataset.motion=d.name;
 }
}

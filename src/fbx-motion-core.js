import * as THREE from 'three';
import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
import {skeletonMotionSource} from './motion-skeleton.js';
import {asArrayBuffer} from './binary.js';

// Runs in a short-lived worker in the app. No images are decoded or requested.
// The FBX loader's module-level parse tree is released when that worker exits.
export function parseFbxMotion(bytes){
 const load=THREE.TextureLoader.prototype.load,previousWindow=globalThis.window;let root;
 try{
  THREE.TextureLoader.prototype.load=()=>new THREE.Texture();
  globalThis.window={URL:{createObjectURL:()=>''},innerWidth:1,innerHeight:1};
  root=new FBXLoader().parse(asArrayBuffer(bytes),'');const source=skeletonMotionSource(root,root.animations,'fbx'),indices=new Map(source.skeleton.bones.map((b,i)=>[b,i]));
  return {kind:'fbx',warnings:source.warnings,bones:source.skeleton.bones.map(b=>({name:b.name,parent:indices.get(b.parent)??-1,position:b.position.toArray(),quaternion:b.quaternion.toArray(),scale:b.scale.toArray()})),clips:source.clips.map(c=>({name:c.name,duration:c.duration,tracks:c.tracks.map(t=>({name:t.name,type:t.ValueTypeName,times:t.times,values:t.values,interpolation:t.getInterpolation()}))}))};
 }finally{
  THREE.TextureLoader.prototype.load=load;if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
  root?.traverse(n=>{n.geometry?.dispose();for(const m of Array.isArray(n.material)?n.material:[n.material])if(m){for(const t of Object.values(m))if(t?.isTexture)t.dispose();m.dispose()}});
 }
}

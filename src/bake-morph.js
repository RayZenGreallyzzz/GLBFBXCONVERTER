import {Vector3} from 'three';
// Tangent deltas belong to the old UV frame. Transport their endpoint frames
// into the new chart frame instead of copying or discarding those deltas.
export function transportMorphTangents(data,oldVertices,baseTangents,target){
 const delta=target.getAttribute('TANGENT').getArray(),dn=target.getAttribute('NORMAL')?.getArray();
 const n0=new Vector3(),t0=new Vector3(),b0=new Vector3(),n1=new Vector3(),t1=new Vector3(),b1=new Vector3(),newT=new Vector3(),wanted=new Vector3();
 for(let i=0;i<oldVertices.length;i++){
  if(delta[i*3]===0&&delta[i*3+1]===0&&delta[i*3+2]===0&&(!dn||(dn[i*3]===0&&dn[i*3+1]===0&&dn[i*3+2]===0)))continue;
  const old=oldVertices[i];n0.fromArray(data.normals,old*3).normalize();t0.fromArray(data.tangents,old*4).addScaledVector(n0,-t0.dot(n0)).normalize();b0.crossVectors(n0,t0).multiplyScalar(data.tangents[old*4+3]);
  n1.fromArray(data.normals,old*3);if(dn)n1.add(newT.fromArray(dn,i*3));n1.normalize();
  t1.fromArray(data.tangents,old*4).add(newT.fromArray(delta,i*3));t1.addScaledVector(n1,-t1.dot(n1)).normalize();b1.crossVectors(n1,t1).multiplyScalar(data.tangents[old*4+3]);
  newT.fromArray(baseTangents,i*4);wanted.copy(t1).multiplyScalar(newT.dot(t0)).addScaledVector(b1,newT.dot(b0)).normalize();
  if(n1.lengthSq()<.99||t1.lengthSq()<.99||wanted.lengthSq()<.99||![wanted.x,wanted.y,wanted.z].every(Number.isFinite))throw Error('Некорректный базис Blend Shapes. Используй обычную оптимизацию без переноса деталей.');
  wanted.sub(newT);delta.set([wanted.x,wanted.y,wanted.z],i*3);
 }
}

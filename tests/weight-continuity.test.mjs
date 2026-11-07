import test from 'node:test';
import assert from 'node:assert/strict';
import {VoxelGrid} from '../src/vendor/voxel-skinner/VoxelGrid.js';
import {extractWeights} from '../src/vendor/voxel-skinner/WeightExtractor.js';

function field(grid,fn){return Float64Array.from({length:grid.totalVoxels},(_,i)=>fn(...grid.worldPos(...grid.coords(i))))}
function boneWeight(result,vertex,bone){let w=0;for(let c=0;c<4;c++)if(result.skinIndices[vertex*4+c]===bone)w+=result.skinWeights[vertex*4+c];return w}
function assertValid(result){for(let i=0;i<result.skinWeights.length;i+=4){let sum=0;for(let k=0;k<4;k++){const w=result.skinWeights[i+k];assert.ok(Number.isFinite(w)&&w>=0);sum+=w}assert.ok(Math.abs(sum-1)<1e-6)}}

test('neighboring vertices stay continuous across voxel faces without changing distance fields',()=>{
 const grid=new VoxelGrid({min:[0,0,0],max:[3,3,3]},3);grid.state.fill(2);
 const fields=[field(grid,x=>Math.max(.01,x+.6)),field(grid,x=>Math.max(.01,3.6-x))],copy=fields.map(f=>f.slice()),points=new Float32Array([1-1e-5,1,1,1+1e-5,1,1]);
 const smooth=extractWeights(grid,fields,points),legacy=extractWeights(grid,fields,points,{interpolate:false});assertValid(smooth);
 assert.ok(Math.abs(boneWeight(smooth,0,0)-boneWeight(smooth,1,0))<.0001);
 assert.ok(Math.abs(boneWeight(legacy,0,0)-boneWeight(legacy,1,0))>.1,'fixture must cross an actual legacy weight step');assert.deepEqual(fields,copy);
});

test('four-influence selection fades through a fourth/fifth-bone swap',()=>{
 const grid=new VoxelGrid({min:[0,0,0],max:[3,3,3]},3);grid.state.fill(2);
 const fields=[field(grid,()=>1),field(grid,()=>1.3),field(grid,()=>1.6),field(grid,x=>2+(x-1)*.1),field(grid,x=>2-(x-1)*.1)],points=new Float32Array([1-1e-5,1,1,1+1e-5,1,1]);
 const result=extractWeights(grid,fields,points,{threshold:0});assertValid(result);
 for(let bone=0;bone<5;bone++)assert.ok(Math.abs(boneWeight(result,0,bone)-boneWeight(result,1,bone))<.0001,'bone '+bone+' changed abruptly');
});

test('interpolation cannot cross diagonally touching disconnected cells or introduce unreachable bones',()=>{
 const grid=new VoxelGrid({min:[0,0,0],max:[3,3,3]},3),a=grid.index(1,1,1),b=grid.index(2,2,1);grid.state[a]=grid.state[b]=1;
 const fields=[new Float64Array(grid.totalVoxels).fill(Infinity),new Float64Array(grid.totalVoxels).fill(Infinity),new Float64Array(grid.totalVoxels).fill(Infinity)];fields[0][a]=.1;fields[1][a]=10;fields[0][b]=10;fields[1][b]=.1;fields[2][b]=0;
 const result=extractWeights(grid,fields,new Float32Array([.99,.99,.5]));assertValid(result);assert.equal(boneWeight(result,0,0),1);assert.equal(boneWeight(result,0,1),0);assert.equal(boneWeight(result,0,2),0);
});

test('coincident bone ties remain finite and isolated components are not assigned arbitrary weights',()=>{
 const grid=new VoxelGrid({min:[0,0,0],max:[3,3,3]},3);grid.state.fill(2);const fields=Array.from({length:5},()=>new Float64Array(grid.totalVoxels).fill(0)),points=new Float32Array([1,1,1]);
 const result=extractWeights(grid,fields,points);assertValid(result);assert.equal(result.skinWeights.length,4);
 for(const f of fields)f.fill(Infinity);assert.equal(extractWeights(grid,fields,points).skinWeights.reduce((a,b)=>a+b),0,'unweighted vertices must reach the existing rejection guard');
});

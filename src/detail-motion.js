import {Euler, Quaternion} from 'three';

export function detailFrames(keys,duration){
  const frames=new Map([[0,[0,0,0]],[Math.fround(duration),[0,0,0]]]);
  for(const {time,value} of keys){
    if(!Number.isFinite(time)||time<0||time>duration+1e-5||value.some(v=>!Number.isFinite(v)))
      throw Error('Некорректный ключ движения детали.');
    frames.set(Math.fround(time),value);
  }
  return [...frames].sort((a,b)=>a[0]-b[0]);
}

export function detailTurn(value,target=new Quaternion()){
  return target.setFromEuler(new Euler(...value.map(degrees=>degrees*Math.PI/180)));
}

export function sampleDetailTurn(keys,duration,time){
  const frames=detailFrames(keys,duration), right=frames.findIndex(([at])=>at>=time);
  if(right<=0)return detailTurn(frames.at(right)[1]);
  const [a,from]=frames[right-1], [b,to]=frames[right];
  return detailTurn(from).slerp(detailTurn(to),(time-a)/(b-a));
}

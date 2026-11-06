import {Vector3,Quaternion,Matrix4} from 'three';

export const RIG_GUIDES=Object.freeze([
 ['hips','Таз'],['chest','Грудь'],['neck','Основание шеи'],['head','Центр головы'],
 ['leftShoulder','Левое плечо'],['leftElbow','Левый локоть'],['leftWrist','Левое запястье'],
 ['rightShoulder','Правое плечо'],['rightElbow','Правый локоть'],['rightWrist','Правое запястье'],
 ['leftHip','Левый тазобедренный сустав'],['leftKnee','Левое колено'],['leftAnkle','Левая щиколотка'],['leftToe','Основание пальцев левой стопы'],
 ['rightHip','Правый тазобедренный сустав'],['rightKnee','Правое колено'],['rightAnkle','Правая щиколотка'],['rightToe','Основание пальцев правой стопы']
]);
export function suggestRigGuides({min,max},positions=null){
 const h=max[1]-min[1],w=max[0]-min[0],cx=(min[0]+max[0])/2,cz=(min[2]+max[2])/2;
 if(!Number.isFinite(h+w+cx+cz)||h<=0||w<=0)throw Error('Нет объёмной геометрии для скелета');
 const point=(x,y,z=0)=>[cx+w*x,min[1]+h*y,cz+h*z];
 const out={hips:point(0,.52),chest:point(0,.73),neck:point(0,.85),head:point(0,.93)};
 for(const [side,s]of [['left',1],['right',-1]]){
  out[side+'Shoulder']=point(s*.17,.79);out[side+'Elbow']=point(s*.29,.74);out[side+'Wrist']=point(s*.385,.70);
  out[side+'Hip']=point(s*.085,.50);out[side+'Knee']=point(s*.09,.29);out[side+'Ankle']=point(s*.09,.055);out[side+'Toe']=point(s*.09,.025,.08);
 }
 if(positions){
  const median=a=>{a.sort((x,y)=>x-y);return a[Math.floor(a.length/2)]};
  // Geometric draft only. The user confirms the joint centre in both views;
  // this does not identify anatomy or promise an automatic rig without review.
  for(const side of ['left','right'])for(const part of ['Shoulder','Elbow','Wrist']){
   const p=out[side+part],ys=[],zs=[];
   for(let i=0;i<positions.length;i+=3)if(Math.abs(positions[i]-p[0])<w*.013&&positions[i+1]>out.hips[1]+h*.06){ys.push(positions[i+1]);zs.push(positions[i+2])}
   if(ys.length>=8){p[1]=median(ys);p[2]=median(zs)}
  }
  for(const side of ['left','right'])for(const part of ['Hip','Knee','Ankle']){
   const p=out[side+part],xs=[],zs=[],sign=side==='left'?1:-1;
   for(let i=0;i<positions.length;i+=3)if(Math.abs(positions[i+1]-p[1])<h*.013&&(positions[i]-cx)*sign>0&&Math.abs(positions[i]-cx)<w*.3){xs.push(positions[i]);zs.push(positions[i+2])}
   if(xs.length>=8){p[0]=median(xs);p[2]=median(zs)}
  }
  for(const side of ['left','right']){out[side+'Toe'][0]=out[side+'Ankle'][0];out[side+'Toe'][2]=Math.max(out[side+'Toe'][2],out[side+'Ankle'][2]+h*.07)}
 }return out;
}
export function rigBoneSpec(guides,bounds){
 const h=bounds.max[1]-bounds.min[1],eps=h*.004;
 if(!Number.isFinite(h)||h<=1e-8)throw Error('Некорректная высота персонажа');
 const points={};for(const [key,label]of RIG_GUIDES){const v=guides?.[key];if(!Array.isArray(v)||v.length!==3||v.some(x=>!Number.isFinite(x)))throw Error('Проверь точку: '+label);for(let k=0;k<3;k++)if(v[k]<bounds.min[k]-h*.2||v[k]>bounds.max[k]+h*.2)throw Error('Точка слишком далеко от модели: '+label);points[key]=new Vector3(...v)}
 for(const [a,b]of [['head','neck'],['neck','chest'],['chest','hips'],...['left','right'].flatMap(s=>[[s+'Hip',s+'Knee'],[s+'Knee',s+'Ankle']])])if(points[a].y-points[b].y<eps)throw Error('Проверь высоту точек: '+a+' / '+b);
 for(const side of ['left','right']){const s=side==='left'?1:-1;for(const part of ['Shoulder','Wrist','Hip','Knee','Ankle'])if((points[side+part].x-points.hips.x)*s<eps)throw Error('Перепутана сторона персонажа: '+side+part)}
 const items=[],add=(name,parent,p,tail,deform=true)=>{items.push({name:'mixamorig'+name,parent:parent?'mixamorig'+parent:null,position:p.clone(),tail:tail.clone(),deform});};
 const spine=points.hips.clone().lerp(points.chest,.33),spine1=points.hips.clone().lerp(points.chest,.66),top=points.head.clone().add(new Vector3(0,h*.055,0));
 add('Hips',null,points.hips,spine);add('Spine','Hips',spine,spine1);add('Spine1','Spine',spine1,points.chest);add('Spine2','Spine1',points.chest,points.neck);add('Neck','Spine2',points.neck,points.head);add('Head','Neck',points.head,top);add('HeadEnd','Head',top,top,false);
 for(const [side,prefix]of [['left','Left'],['right','Right']]){
  const shoulder=points[side+'Shoulder'],elbow=points[side+'Elbow'],wrist=points[side+'Wrist'],hip=points[side+'Hip'],knee=points[side+'Knee'],ankle=points[side+'Ankle'],toe=points[side+'Toe'];
  const collar=points.chest.clone().lerp(shoulder,.25),handEnd=wrist.clone().add(wrist.clone().sub(elbow).multiplyScalar(.22)),toeEnd=toe.clone().add(toe.clone().sub(ankle).multiplyScalar(.55));
  add(prefix+'Shoulder','Spine2',collar,shoulder);add(prefix+'Arm',prefix+'Shoulder',shoulder,elbow);add(prefix+'ForeArm',prefix+'Arm',elbow,wrist);add(prefix+'Hand',prefix+'ForeArm',wrist,handEnd);add(prefix+'HandEnd',prefix+'Hand',handEnd,handEnd,false);
  add(prefix+'UpLeg','Hips',hip,knee);add(prefix+'Leg',prefix+'UpLeg',knee,ankle);add(prefix+'Foot',prefix+'Leg',ankle,toe);add(prefix+'ToeBase',prefix+'Foot',toe,toeEnd);add(prefix+'ToeEnd',prefix+'ToeBase',toeEnd,toeEnd,false);
 }
 const index=new Map(items.map((b,i)=>[b.name,i]));
 for(const b of items){
  if(b.deform&&b.position.distanceTo(b.tail)<eps)throw Error('Слишком короткий сегмент: '+b.name);
  const y=b.tail.clone().sub(b.position).normalize(),ref=Math.abs(y.z)>.95?new Vector3(0,1,0):new Vector3(0,0,1);
  if(!b.deform)y.set(0,1,0);
  const x=new Vector3().crossVectors(y,ref).normalize(),z=new Vector3().crossVectors(x,y).normalize();
  b.worldRotation=new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x,y,z));
  const parent=b.parent?items[index.get(b.parent)]:null;
  b.translation=b.position.clone();b.rotation=b.worldRotation.clone();
  if(parent){b.translation.sub(parent.position).applyQuaternion(parent.worldRotation.clone().invert());b.rotation.premultiply(parent.worldRotation.clone().invert())}
  b.inverseBind=new Matrix4().compose(b.position,b.worldRotation,new Vector3(1,1,1)).invert().toArray();
 }
 return items;
}

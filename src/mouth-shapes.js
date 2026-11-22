import {Box3, Matrix3, Vector3} from 'three';

export const mouthDirections = {'+Z':[0,0,1], '-Z':[0,0,-1], '+X':[1,0,0], '-X':[-1,0,0]};
const smooth = (a,b,value) => {
  const f = Math.max(0, Math.min(1,(value-a)/(b-a)));
  return f*f*(3-2*f);
};

export class MouthShapeDraft {
  constructor(root, mesh, direction) {
    root.updateMatrixWorld(true);
    this.mesh = mesh;
    this.front = new Vector3(...mouthDirections[direction]);
    this.up = new Vector3(0,1,0);
    this.right = this.up.clone().cross(this.front);
    const box = new Box3().setFromObject(root);
    this.height = box.max.y-box.min.y;
    if (!Number.isFinite(this.height) || this.height<1e-5) throw Error('Не удалось определить размер модели');
    const unit = this.height/1.90177;
    this.pivot = box.getCenter(new Vector3()).addScaledVector(this.front,.0657*unit);
    this.pivot.y = box.max.y-.173*unit;
    this.unit = unit;
    this.size = 1;
    this.inverse = mesh.matrixWorld.clone().invert();
    const positions = mesh.geometry.getAttribute('position');
    this.points = new Float64Array(positions.count*3);
    this.overrides = new Map();
    const v = new Vector3();
    for (let i=0;i<positions.count;i++) v.fromBufferAttribute(positions,i).applyMatrix4(mesh.matrixWorld).toArray(this.points,i*3);
  }

  influence(point) {
    const unit = this.unit*this.size;
    const x = point.dot(this.right)/unit;
    const y = point.y/unit+.776;
    const z = point.dot(this.front)/unit+.069;
    const separation = .787-.98*(z-.086)+.12*Math.abs(x);
    return smooth(.001,.018,separation-y)*smooth(.060,.110,z+.20*(.715-y))*
      smooth(.635,.665,y)*(1-smooth(.045,.083,Math.abs(x)))*(1-smooth(.773,.793,y));
  }

  paint(center,radius,strength,add) {
    let changed = 0;
    const point = new Vector3(), relative = new Vector3();
    for (let i=0;i<this.points.length;i+=3) {
      point.fromArray(this.points,i);
      const f = 1-smooth(radius*.2,radius,point.distanceTo(center));
      if (!f) continue;
      const current = this.overrides.get(i) ?? this.influence(relative.copy(point).sub(this.pivot));
      const value = current+((add?1:0)-current)*f*strength;
      if (Math.abs(value-current)<1e-6) continue;
      this.overrides.set(i,value);
      changed++;
    }
    return changed;
  }

  forms(close, open) {
    const mesh = this.mesh;
    const normals = mesh.geometry.getAttribute('normal');
    const worldNormal = new Matrix3().getNormalMatrix(mesh.matrixWorld);
    const localNormal = new Matrix3().getNormalMatrix(this.inverse);
    const p=new Vector3(), relative=new Vector3(), q=new Vector3(), normal=new Vector3(), rotated=new Vector3();
    const result = [];
    for (const angle of [-close,open]) {
      const position = new Float32Array(this.points.length), deltaNormal = normals ? new Float32Array(this.points.length) : null;
      let moved = 0;
      for (let i=0;i<this.points.length;i+=3) {
        p.fromArray(this.points,i);
        relative.copy(p).sub(this.pivot);
        const amount = this.overrides.get(i) ?? this.influence(relative);
        if (amount<.00001) continue;
        const theta = angle*Math.PI/180;
        q.copy(relative).applyAxisAngle(this.right,theta).add(this.pivot).lerp(p,1-amount);
        q.applyMatrix4(this.inverse).sub(p.applyMatrix4(this.inverse)).toArray(position,i);
        if (normals) {
          normal.fromBufferAttribute(normals,i/3);
          rotated.copy(normal).applyMatrix3(worldNormal).applyAxisAngle(this.right,theta*amount)
            .applyMatrix3(localNormal).normalize().sub(normal).toArray(deltaNormal,i);
        }
        moved++;
      }
      if (!moved) throw Error('В области челюсти нет вершин. Уточни шарнир, направление лица и размер области.');
      result.push({position,normal:deltaNormal});
    }
    return result;
  }
}

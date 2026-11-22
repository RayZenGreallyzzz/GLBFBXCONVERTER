import {jointGlb} from './joint-glb.js';
import {sampleTimes} from './joint-form-animation.js';
import {inspectMorphJson} from './morph-policy.js';

export function faceNodes(json) {
  return (json.nodes || []).flatMap((node, id) => {
    const mesh = json.meshes?.[node.mesh];
    const count = mesh?.primitives?.[0]?.targets?.length || 0;
    if (!count) return [];
    const names = Array.from({length:count}, (_, i) => mesh.extras?.targetNames?.[i] || 'Форма ' + (i + 1));
    return [{id, name:node.name || mesh.name || 'Меш ' + (id + 1), names, defaults:node.weights || mesh.weights || names.map(() => 0)}];
  });
}

function interval(times, t) {
  let a = 0, b = times.length - 1;
  if (t <= times[a]) return [a, a, 0];
  if (t >= times[b]) return [b, b, 0];
  while (b - a > 1) {
    const mid = (a + b) >> 1;
    if (times[mid] <= t) a = mid;
    else b = mid;
  }
  return [a, b, (t - times[a]) / (times[b] - times[a])];
}

export class FaceTimeline {
  constructor(glb, body, duration) {
    this.body = body;
    this.duration = Math.fround(duration);
    this.shapes = new Map(faceNodes(glb.json).map(node => [node.id, node]));
    this.keys = new Map();
    this.ordered = new WeakMap();
    this.weightTracks = new Map();
    const animation = glb.json.animations?.[body];
    for (const {target, sampler} of animation?.channels || []) {
      if (target.path !== 'weights') continue;
      const s = animation.samplers[sampler];
      this.weightTracks.set(target.node, {times:glb.read(s.input), values:glb.read(s.output), interpolation:s.interpolation || 'LINEAR'});
    }
  }

  time(t) {
    return Math.fround(Math.max(0, Math.min(this.duration, t)));
  }

  getKeys(node, shape) {
    return this.keys.get(node)?.get(shape);
  }

  set(node, shape, t, weight) {
    const target = this.shapes.get(node);
    if (!target || !Number.isInteger(shape) || shape < 0 || shape >= target.names.length ||
      !Number.isFinite(t) || !Number.isFinite(weight) || Math.abs(weight) > 1) throw Error('Некорректный ключ формы');
    const shapes = this.keys.get(node) || new Map(), keys = shapes.get(shape) || new Map();
    keys.set(this.time(t), weight);
    this.ordered.delete(keys);
    shapes.set(shape, keys);
    this.keys.set(node, shapes);
  }

  remove(node, shape, t) {
    const shapes = this.keys.get(node), keys = shapes?.get(shape);
    keys?.delete(this.time(t));
    if (keys) this.ordered.delete(keys);
    if (!keys?.size) shapes?.delete(shape);
    if (!shapes?.size) this.keys.delete(node);
  }

  base(node, t) {
    const {defaults} = this.shapes.get(node), track = this.weightTracks.get(node);
    if (!track) return defaults.slice();
    const {times,values,interpolation} = track, [a,b,k] = interval(times,t);
    const n = defaults.length;
    if (interpolation !== 'CUBICSPLINE') return defaults.map((_,i) => {
      const from = values[a*n+i];
      return interpolation === 'STEP' ? from : from + (values[b*n+i] - from) * k;
    });
    const x=k*k, y=x*k, dt=times[b]-times[a];
    return defaults.map((_,i) => (2*y-3*x+1)*values[(a*3+1)*n+i] +
      (y-2*x+k)*dt*values[(a*3+2)*n+i] + (-2*y+3*x)*values[(b*3+1)*n+i] +
      (y-x)*dt*values[b*3*n+i]);
  }

  sample(node, t) {
    const weights = this.base(node, t);
    for (const [shape, keys] of this.keys.get(node) || []) {
      if (!this.ordered.has(keys)) {
        const ordered = [...keys].sort(([a],[b]) => a-b);
        this.ordered.set(keys,{times:ordered.map(([time])=>time),values:ordered.map(([,value])=>value)});
      }
      const {times,values}=this.ordered.get(keys), [a,b,k] = interval(times,t);
      weights[shape] = values[a] + (values[b] - values[a]) * k;
    }
    return weights;
  }

  bake() {
    return [...this.keys].map(([id, shapes]) => {
      const base = this.weightTracks.get(id), inputs = [...shapes.values()].map(k => [...k.keys()]);
      if (base) inputs.push(base.times);
      const times = sampleTimes(this.duration, inputs, base?.interpolation === 'STEP' ? [base.times] : []);
      const width = this.shapes.get(id).names.length;
      const values = new Float32Array(times.length * width);
      for (let i = 0; i < times.length; i++) values.set(this.sample(id, times[i]), i * width);
      return {id, times, values};
    });
  }
}

export function appendFaceClip(input, timeline, name, memoryBudgetMiB) {
  const glb = jointGlb(input), {json} = glb;
  if (!name.trim() || json.animations?.some(clip => clip.name === name)) throw Error('Дай новой анимации уникальное имя');
  const tracks = timeline.bake();
  if (!tracks.length) throw Error('Запиши хотя бы один ключ мимики');
  const base = json.animations?.[timeline.body];
  const clip = {name, channels:[], samplers:[]};
  const edited = new Set(tracks.map(track => track.id));
  for (const channel of base?.channels || []) {
    if (channel.target.path === 'weights' && edited.has(channel.target.node)) continue;
    const sampler = clip.samplers.push({...base.samplers[channel.sampler]}) - 1;
    clip.channels.push({...channel, sampler});
  }
  for (const track of tracks) {
    const sampler = clip.samplers.push({input:glb.append(track.times,1,{minmax:true}), output:glb.append(track.values,1), interpolation:'LINEAR'}) - 1;
    clip.channels.push({sampler, target:{node:track.id,path:'weights'}});
  }
  (json.animations ??= []).push(clip);
  inspectMorphJson(json);
  return glb.finish({memoryBudgetMiB});
}

export function appendMouthShapes(input, node, results, memoryBudgetMiB) {
  const glb = jointGlb(input), {json} = glb;
  const meshId = json.nodes[node]?.mesh, mesh = json.meshes[meshId], primitive = mesh?.primitives[0];
  if (!primitive || mesh.primitives.length !== 1 || json.nodes.filter(n => n.mesh === meshId).length !== 1)
    throw Error('Выбери меш с одной частью и одним экземпляром');
  if (json.extras?.phoenixJointForms?.meshes.some(m=>m.node===node||m.nodeName===json.nodes[node].name))
    throw Error('Загрузи копию меша до коррекции локтей и коленей');
  const old = primitive.targets?.length || 0;
  const names = mesh.extras?.targetNames?.slice() || Array.from({length:old}, (_,i)=>'Форма '+(i+1));
  if (names.includes('MouthOpen') || names.includes('MouthClose')) throw Error('У этого меша уже есть формы рта');
  const last = old + 2, count = json.accessors[primitive.attributes.POSITION].count;
  if (last > 64 || results.length !== 2 || results.some(({position,normal}) => position.length !== count*3 || normal && normal.length !== count*3))
    throw Error('Число вершин или форм вышло за пределы редактора');
  for (const {position,normal} of results) {
    const target={POSITION:glb.append(position,3,{sparse:true,minmax:true})};
    if (normal) target.NORMAL=glb.append(normal,3,{sparse:true});
    (primitive.targets ??= []).push(target);
  }
  (mesh.extras ??= {}).targetNames=[...names,'MouthClose','MouthOpen'];
  mesh.weights=[...(mesh.weights||Array(old).fill(0)),0,0];
  if (json.nodes[node].weights) json.nodes[node].weights.push(0,0);
  for (const animation of json.animations || []) for (const channel of animation.channels) {
    if (channel.target.node !== node || channel.target.path !== 'weights') continue;
    const source = animation.samplers[channel.sampler], values = glb.read(source.output);
    const data = new Float32Array(values.length / old * last);
    for (let i=0;i<values.length/old;i++) data.set(values.subarray(i*old,(i+1)*old),i*last);
    channel.sampler = animation.samplers.push({...source,output:glb.append(data,1)}) - 1;
  }
  inspectMorphJson(json);
  return glb.finish({memoryBudgetMiB});
}

"""Bake local .blend armature actions to mesh-free GLB using Blender's bpy.

Run with Blender's Python, or a compatible Python with the official bpy
module. No embedded scripts in the input .blend are enabled.
"""
import argparse
import json
import math
import struct
from pathlib import Path
import bpy
from mathutils import Matrix


def trs(matrix):
    position, rotation, scale = matrix.decompose()
    # Legacy 2.79 bone matrices contain orthogonality noise near unit scale.
    # Snap only this bounded 0.01% error; real scaling is left untouched.
    # The complete reconstructed world matrices are checked below afterwards.
    if all(abs(value-1.0) <= 1e-4 for value in scale):
        scale = [1.0, 1.0, 1.0]
    return list(position), [rotation.x, rotation.y, rotation.z, rotation.w], list(scale)


def compose(transform):
    from mathutils import Quaternion, Vector
    p, q, s = transform
    return Matrix.LocRotScale(Vector(p), Quaternion((q[3], *q[:3])), Vector(s))


def export_file(source, output):
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    rigs = [o for o in scene.objects if o.type == 'ARMATURE']
    if len(rigs) != 1:
        raise ValueError(f'Expected one armature; found {len(rigs)}')
    obj = rigs[0]
    bones = list(obj.data.bones)
    if not bones or len(bones) > 195:
        raise ValueError(f'Unsupported bone count {len(bones)}')
    indices = {bone.name: i + 1 for i, bone in enumerate(bones)}
    parents = [-1] + [indices[b.parent.name] if b.parent else 0 for b in bones]
    conversion = Matrix.Rotation(-math.pi / 2, 4, 'X')
    rest = [trs(conversion @ obj.matrix_world)] + [
        trs(b.parent.matrix_local.inverted() @ b.matrix_local if b.parent else b.matrix_local)
        for b in bones
    ]
    nodes = []
    for i, (name, transform) in enumerate(zip([obj.name] + [b.name for b in bones], rest)):
        p, q, s = transform
        node = dict(name=name, translation=p, rotation=q, scale=s)
        children = [j for j, parent in enumerate(parents) if parent == i]
        if children:
            node['children'] = children
        nodes.append(node)
    obj.animation_data_create()
    obj.animation_data.action = None
    for track in obj.animation_data.nla_tracks:
        track.mute = True
    fps = scene.render.fps / scene.render.fps_base
    chunks, views, accessors, animations, audit = [], [], [], [], []
    offset = 0

    def accessor(values, kind):
        nonlocal offset
        packed = struct.pack('<' + str(len(values)) + 'f', *values)
        chunks.append(packed)
        views.append(dict(buffer=0, byteOffset=offset, byteLength=len(packed)))
        offset += len(packed)
        width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[kind]
        value = dict(bufferView=len(views)-1, componentType=5126, count=len(values)//width, type=kind)
        if kind == 'SCALAR':
            value.update(min=[values[0]], max=[values[-1]])
        accessors.append(value)
        return len(accessors)-1

    for action in sorted(bpy.data.actions, key=lambda a: a.name):
        curves = list(action.fcurves)
        if not any('pose.bones[' in c.data_path for c in curves):
            continue
        first, last = map(float, action.frame_range)
        held_pose = last == first
        frames = [first, first] if held_pose else [first] + list(range(math.floor(first)+1, math.ceil(last))) + [last]
        times = [0.0, 1.0] if held_pose else [(frame-first)/fps for frame in frames]
        tracks = [[[], [], []] for _ in nodes]
        obj.animation_data.action = None
        for bone in obj.pose.bones:
            bone.matrix_basis.identity()
        obj.animation_data.action = action
        if getattr(action, 'slots', None):
            obj.animation_data.action_slot = action.slots[0]
        max_error = 0.0
        for frame in frames:
            scene.frame_set(math.floor(frame), subframe=frame-math.floor(frame))
            evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
            root = conversion @ evaluated.matrix_world
            poses = [evaluated.pose.bones[b.name] for b in bones]
            transforms = [trs(root)] + [trs(p.parent.matrix.inverted() @ p.matrix if p.parent else p.matrix) for p in poses]
            world = {}

            def world_matrix(i):
                if i not in world:
                    local = compose(transforms[i])
                    world[i] = world_matrix(parents[i]) @ local if parents[i] >= 0 else local
                return world[i]

            for i, transform in enumerate(transforms):
                expected = root @ poses[i-1].matrix if i else root
                actual = world_matrix(i)
                max_error = max(max_error, max(abs(actual[r][c]-expected[r][c]) for r in range(4) for c in range(4)))
                p, q, s = transform
                if tracks[i][1] and sum(q[j]*tracks[i][1][-4+j] for j in range(4)) < 0:
                    q = [-v for v in q]
                for target, values in zip(tracks[i], [p, q, s]):
                    target.extend(values)
        if max_error > 1e-3:
            raise ValueError(f'{action.name}: matrix decomposition error {max_error}')
        time_index = accessor(times, 'SCALAR')
        samplers, channels = [], []
        for i, values in enumerate(tracks):
            for path, data in zip(['translation', 'rotation', 'scale'], values):
                output_index = accessor(data, 'VEC4' if path == 'rotation' else 'VEC3')
                channels.append(dict(sampler=len(samplers), target=dict(node=i, path=path)))
                samplers.append(dict(input=time_index, output=output_index, interpolation='LINEAR'))
        animations.append(dict(name=action.name, samplers=samplers, channels=channels))
        audit.append(dict(action=action.name, frames=len(frames), duration=times[-1], held_pose=held_pose, max_matrix_error=max_error))
    if not animations:
        raise ValueError('No skeletal actions')
    document = dict(asset=dict(version='2.0', generator='Phoenix Blender action baker'), scene=0, scenes=[dict(nodes=[0])], nodes=nodes,
                    skins=[dict(joints=list(range(1, len(nodes))))], animations=animations,
                    accessors=accessors, bufferViews=views, buffers=[dict(byteLength=offset)])
    text = json.dumps(document, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    binary = b''.join(chunks)
    binary += b'\0' * (-len(binary) % 4)
    data = struct.pack('<III', 0x46546c67, 2, 28+len(text)+len(binary))
    data += struct.pack('<II', len(text), 0x4e4f534a) + text
    data += struct.pack('<II', len(binary), 0x004e4942) + binary
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    return dict(file=source.name, output=output.name, bones=len(bones), actions=audit)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    files = [args.input] if args.input.is_file() else sorted(args.input.rglob('*.blend'))
    report = []
    for source in files:
        output = args.output / ('monster_' + source.stem + '.glb')
        try:
            item = export_file(source.resolve(), output.resolve())
            print('EXPORTED', source.name, len(item['actions']), flush=True)
            report.append(item)
        except Exception as error:
            report.append(dict(file=source.name, error=str(error)))
            print('ERROR', source.name, str(error), flush=True)
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output/'blend-export-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))

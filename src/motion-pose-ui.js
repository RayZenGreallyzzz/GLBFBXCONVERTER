import {canonicalBone} from './animation-retarget.js';
import {limbLabels, MotionPoseEditor} from './motion-pose-editor.js';

export class MotionPoseUI {
  constructor(get, {seek, play, commit, refresh, status}) {
    this.panel = get('anim-pose');
    this.controls = get('anim-pose-controls');
    this.bone = get('anim-pose-bone');
    this.time = get('anim-pose-time');
    this.timeValue = get('anim-pose-time-value');
    this.keyList = get('anim-pose-keys');
    this.key = get('anim-pose-key');
    this.remove = get('anim-pose-remove');
    this.offsets = ['out', 'x', 'y', 'z'].map(axis => ({
      range:get('anim-pose-' + axis), value:get('anim-pose-' + axis + '-value')
    }));
    this.outward = get('anim-pose-outward');
    this.note = get('anim-pose-note');
    this.editor = null;
    this.clip = null;
    this.pending = false;

    this.sync = () => {
      this.pending = false;
      this.draw();
      seek(this.clip, this.time.valueAsNumber);
      refresh();
    };
    for (const element of [this.bone, this.time]) element.addEventListener('input', this.sync);
    this.keyList.addEventListener('change', () => {
      if (!this.keyList.value) return;
      this.time.value = this.keyList.value;
      this.sync();
    });
    for (const {range} of this.offsets) range.addEventListener('input', () => {
      if (!this.editor) return;
      const values = this.values();
      this.pending = this.editor.offsets(this.bone.value, this.time.valueAsNumber).some((value, i) => value !== values[i]);
      this.readouts();
      const rotations = this.pending ? this.editor.rotations(this.bone.value, this.time.valueAsNumber, values) : null;
      seek(this.clip, this.time.valueAsNumber, rotations);
      refresh();
    });
    const edit = (label, change) => {
      if (!this.editor) return;
      try {
        change(this.editor, this.bone.value, this.time.valueAsNumber);
        this.clip = this.editor.build();
        commit(this.clip);
        this.sync();
        status(label);
      } catch (error) {
        status('Ошибка правки позы. ' + error.message);
      }
    };
    this.key.addEventListener('click', () => edit('Ключ позы записан.', (editor, name, time) => editor.setKey(name, time, this.values())));
    get('anim-pose-all').addEventListener('click', () => edit('Положение кости изменено на весь клип.', (editor, name) => editor.setWholeClip(name, this.values())));
    this.remove.addEventListener('click', () => edit('Ключ позы удалён.', (editor, name, time) => editor.removeKey(name, time)));
    get('anim-pose-play').addEventListener('click', () => {
      if (!this.editor) return;
      try {
        this.pending = false;
        this.draw();
        play(this.clip);
        status('▶ ' + this.clip.name);
      } catch (error) {
        status('Ошибка предпросмотра. ' + error.message);
      }
    });
    this.panel.addEventListener('toggle', () => {
      if (this.panel.open && this.editor && !this.controls.disabled) this.sync();
    });
  }

  set(root, clip, editor) {
    this.editor = editor?.root === root ? editor : new MotionPoseEditor(root, clip);
    this.clip = clip;
    this.pending = false;
    this.time.max = String(this.editor.duration);
    this.time.value = '0';
    const roleOrder = Object.keys(limbLabels);
    const rank = name => {
      const index = roleOrder.indexOf(canonicalBone(name));
      return index < 0 ? roleOrder.length : index;
    };
    const names = [...this.editor.bones.keys()].sort((a, b) => rank(a) - rank(b));
    this.bone.replaceChildren(...names.map(name => new Option(limbLabels[canonicalBone(name)] || name, name)));
    if (names.length) this.draw();
  }

  clear() {
    this.editor = null;
    this.clip = null;
    this.pending = false;
    this.panel.open = false;
  }

  refresh(enabled, clip) {
    if (!clip && this.editor) this.clear();
    this.panel.hidden = !this.editor?.bones.size;
    this.controls.disabled = !enabled;
  }

  values() {
    return this.offsets.map(({range}) => range.valueAsNumber);
  }

  readouts() {
    for (const {range, value} of this.offsets) value.textContent = Number(range.valueAsNumber.toFixed(1)) + '°';
    this.note.textContent = this.pending ? 'Запиши ключ или примени угол ко всему клипу.'
      : 'Ключи плавно соединяются. Для постоянной поправки нажми «На весь клип».';
  }

  draw() {
    const name = this.bone.value, time = this.editor.time(this.time.valueAsNumber);
    const offsets = this.editor.offsets(name, time), keys = this.editor.keys.get(name);
    this.offsets.forEach(({range}, i) => { range.value = String(offsets[i]); });
    this.outward.hidden = !this.editor.outward.has(name);
    this.timeValue.textContent = time.toFixed(3) + ' / ' + this.editor.duration.toFixed(3) + ' с';
    this.keyList.replaceChildren(new Option(keys?.size ? 'Перейти к ключу' : 'Ключей пока нет', ''),
      ...[...keys?.keys() || []].sort((a, b) => a - b).map(value => new Option(value.toFixed(3) + ' с', value)));
    this.remove.disabled = !keys?.has(time);
    if (keys?.has(time)) this.keyList.value = String(time);
    this.key.textContent = keys?.has(time) ? 'Обновить ключ' : 'Записать ключ';
    this.readouts();
  }
}

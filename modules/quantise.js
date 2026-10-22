// Quantise — snaps notes to a scale, and turns a control signal into notes on each trigger.

const SCALES = {
  'pent-major': { label: 'Pentatonic major', s: [0, 2, 4, 7, 9] },
  'pent-minor': { label: 'Pentatonic minor', s: [0, 3, 5, 7, 10] },
  major: { label: 'Major', s: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Natural minor', s: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: 'Dorian', s: [0, 2, 3, 5, 7, 9, 10] },
  whole: { label: 'Whole tone', s: [0, 2, 4, 6, 8, 10] },
  chromatic: { label: 'Chromatic', s: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export default {
  id: 'quantise',
  name: 'Quantise',
  short: 'Quant',
  version: 1,
  kind: 'utility',
  multiple: true,
  sound: false,
  description: 'Snaps notes to a scale. On each trigger it also turns a control signal (or chance, if none is patched) into a note.',

  defaults() { return { scale: 'pent-major', root: 2, low: 48, span: 2, dur: 0.4 }; },

  create(host) {
    const { clamp, esc, NOTE_NAMES, noteName } = host.util;
    const st = () => host.state;
    let cv = null, played = [], panel = null, ctl = null, keys = [], readout = null;

    const scale = () => (SCALES[st().scale] || SCALES['pent-major']).s;
    const inScale = pc => scale().includes(((pc - st().root) % 12 + 12) % 12);
    function snap(midi) {
      const m = Math.round(midi);
      for (let d = 0; d <= 6; d++) { if (inScale(m - d)) return m - d; if (inScale(m + d)) return m + d; }
      return m;
    }
    function send(midi, time, vel, dur) {
      const q = snap(midi);
      host.emit('note', { kind: 'note', time, midi: q, vel: vel ?? 0.8, dur: dur ?? st().dur });
      played.push({ time, midi: q }); if (played.length > 16) played.shift();
    }
    function render() {
      if (!ctl) return;
      const s = st();
      ctl.innerHTML = `
        <label class="field"><span>Scale</span><select class="qn-scale">${Object.entries(SCALES).map(([k, v]) => `<option value="${k}" ${k === s.scale ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
        <div class="row">
          <label class="field" style="flex:1"><span>Root</span><select class="qn-root">${NOTE_NAMES.map((n, i) => `<option value="${i}" ${i === s.root ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="field" style="flex:1"><span>From</span><select class="qn-low">${[36, 48, 60, 72].map(v => `<option value="${v}" ${v === s.low ? 'selected' : ''}>${noteName(v)}</option>`).join('')}</select></label>
        </div>
        <div class="field"><span>Range for control</span><div class="stepper"><button data-qn="-1" aria-label="Narrower">−</button><output>${s.span}</output><button data-qn="1" aria-label="Wider">+</button><span class="note">octaves</span></div></div>
        ${host.portsBox('')}`;
      keys.forEach((k, i) => k.classList.toggle('in', inScale(i)));
    }

    return {
      ports() {
        return [
          { id: 'note-in', label: 'note in', dir: 'in', type: 'note' },
          { id: 'cv', label: 'control', dir: 'in', type: 'control' },
          { id: 'sample', label: 'sample', dir: 'in', type: 'trigger' },
          { id: 'note', label: 'note', dir: 'out', type: 'note' },
        ];
      },
      schedule() { if (!host.isPatched('cv')) cv = null; },
      input(port, msg) {
        if (port === 'cv') cv = clamp(msg.value, 0, 1);
        else if (port === 'note-in') send(msg.midi, msg.time, msg.vel, msg.dur);
        else if (port === 'sample') {
          const v = cv !== null ? cv : Math.random();
          send(st().low + v * st().span * 12, msg.time, msg.vel);
        }
      },
      mount(stage, pnl) {
        panel = pnl;
        panel.innerHTML = `<div class="keys">${NOTE_NAMES.map(n => `<span>${n}</span>`).join('')}</div><p class="mono qn-read">—</p><div class="qn-ctl"></div>`;
        keys = [...panel.querySelectorAll('.keys span')]; ctl = panel.querySelector('.qn-ctl'); readout = panel.querySelector('.qn-read');
        readout.style.margin = '0';
        panel.addEventListener('click', e => { const b = e.target.closest('[data-qn]'); if (!b) return; st().span = clamp(st().span + (+b.dataset.qn), 1, 5); host.save(); render(); });
        panel.addEventListener('change', e => {
          const t = e.target;
          if (t.classList.contains('qn-scale')) st().scale = t.value;
          else if (t.classList.contains('qn-root')) st().root = +t.value;
          else if (t.classList.contains('qn-low')) st().low = +t.value;
          else return;
          host.save(); render();
        });
        render();
      },
      draw(T) {
        let last = null; for (let k = played.length - 1; k >= 0; k--) if (played[k].time <= T) { last = played[k]; break; }
        const on = last && T - last.time < 0.25 ? ((last.midi % 12) + 12) % 12 : -1;
        keys.forEach((k, i) => k.classList.toggle('on', i === on));
        readout.textContent = last ? 'last note ' + noteName(last.midi) : 'waiting for notes';
      },
      render,
      reset() { played = []; cv = null; },
    };
  },
};

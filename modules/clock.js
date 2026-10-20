// Clock — a steady master clock with two dividers and a chance gate.
// It is also the simplest complete module, so copy this file when starting a new one.
// See MODULES.md for the full contract.

export default {
  // id must match the file name (modules/clock.js) and use only a–z, 0–9 and hyphens.
  id: 'clock',
  name: 'Clock',
  short: 'Clock',
  version: 1,

  // Saved settings for a fresh rack. Plain JSON only: no functions, no audio nodes.
  defaults() {
    return { bpm: 100, a: 2, b: 3, chance: 0.35, tick: false };
  },

  // create() runs once. Keep runtime things (timers, audio nodes) in local variables here,
  // and always read settings through host.state, because loading a patch replaces it.
  create(host) {
    const { clamp } = host.util;
    const st = () => host.state;
    let next = 0, beat = 0, tmod = 1, hist = [];
    let cv = null, panel = null;

    function tickSound(time, accent) {
      if (!st().tick || !host.ctx) return;
      const ctx = host.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = accent ? 1760 : 1320;
      g.gain.setValueAtTime(0.12, time); g.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
      o.connect(g); g.connect(host.output); o.start(time); o.stop(time + 0.05);
    }
    function fire(time) {
      beat++;
      const s = st(), out = { beat: true, a: beat % s.a === 0, b: beat % s.b === 0, chance: Math.random() < s.chance };
      hist.push({ time, ...out }); if (hist.length > 16) hist.shift();
      host.emit('beat', { kind: 'clock', time });
      if (out.a) host.emit('a', { kind: 'trigger', time, vel: 0.8 });
      if (out.b) host.emit('b', { kind: 'trigger', time, vel: 0.8 });
      if (out.chance) host.emit('chance', { kind: 'trigger', time, vel: 0.8 });
      tickSound(time, out.a);
    }

    function render() {
      if (!panel) return;
      const s = st();
      panel.innerHTML = `<div class="ph"><h2>Clock</h2><p class="lede">A steady beat for modules that follow a clock, with two dividers and a chance gate for looser patterns.</p></div>
        <fieldset class="group"><legend>Tempo</legend>
          <label class="field"><span>Tempo <output id="ck-bpmOut">${s.bpm} bpm</output></span><input type="range" id="ck-bpm" min="30" max="240" step="1" value="${s.bpm}"></label>
          <div class="field"><span>Output A fires every</span><div class="stepper"><button data-act="ck-step" data-k="a" data-d="-1" aria-label="Fewer beats for A">−</button><output>${s.a}</output><button data-act="ck-step" data-k="a" data-d="1" aria-label="More beats for A">+</button><span class="note">beats</span></div></div>
          <div class="field"><span>Output B fires every</span><div class="stepper"><button data-act="ck-step" data-k="b" data-d="-1" aria-label="Fewer beats for B">−</button><output>${s.b}</output><button data-act="ck-step" data-k="b" data-d="1" aria-label="More beats for B">+</button><span class="note">beats</span></div></div>
          <label class="field"><span>Chance per beat <output id="ck-chanceOut">${Math.round(s.chance * 100)}%</output></span><input type="range" id="ck-chance" min="0" max="1" step="0.01" value="${s.chance}"></label>
          <label class="toggle"><input type="checkbox" id="ck-tick" ${s.tick ? 'checked' : ''}>Audible tick</label>
        </fieldset>${host.portsBox('')}`;
    }

    return {
      // Ports: ids are local to this module. Types: clock, trigger, note, control.
      ports() {
        return [
          { id: 'beat', label: 'beat', dir: 'out', type: 'clock' },
          { id: 'a', label: 'A', dir: 'out', type: 'trigger' },
          { id: 'b', label: 'B', dir: 'out', type: 'trigger' },
          { id: 'chance', label: 'chance', dir: 'out', type: 'trigger' },
          { id: 'tempo', label: 'tempo', dir: 'in', type: 'control' },
          { id: 'reset', label: 'reset', dir: 'in', type: 'trigger' },
        ];
      },

      // Called every 25 ms with the audio clock. Schedule everything that happens before `until`.
      schedule(now, until) {
        if (!host.isPatched('tempo')) tmod = 1;
        if (!next || next < now - 0.5) next = now + 0.05;
        while (next < until) { fire(next); next += 60 / (st().bpm * tmod); }
      },

      // Messages arriving on input ports. msg.time is the audio time the event should happen.
      input(port, msg) {
        if (port === 'tempo') tmod = 0.5 + clamp(msg.value, 0, 1);
        else if (port === 'reset') { beat = 0; next = Math.max(msg.time, host.now()); }
      },

      // Build the page once: the stage (left) and the panel (right).
      mount(stage, pnl) {
        panel = pnl;
        cv = host.makeCanvas(stage);
        panel.addEventListener('click', e => {
          const b = e.target.closest('[data-act="ck-step"]'); if (!b) return;
          st()[b.dataset.k] = clamp(st()[b.dataset.k] + (+b.dataset.d), 1, 16); host.save(); render();
        });
        panel.addEventListener('input', e => {
          const v = parseFloat(e.target.value);
          if (e.target.id === 'ck-bpm') { st().bpm = v; panel.querySelector('#ck-bpmOut').textContent = v + ' bpm'; }
          else if (e.target.id === 'ck-chance') { st().chance = v; panel.querySelector('#ck-chanceOut').textContent = Math.round(v * 100) + '%'; }
          else return;
          host.save();
        });
        panel.addEventListener('change', e => { if (e.target.id === 'ck-tick') { st().tick = e.target.checked; host.save(); } });
        render();
      },

      // Called every animation frame while this page is showing. T is the audio time.
      draw(T) {
        const C = host.colours(), g = cv.getContext('2d'), W = cv.width, H = cv.height; if (!W || !H) return;
        const dpr = W / (cv.clientWidth || W);
        g.fillStyle = C.paper; g.fillRect(0, 0, W, H);
        let last = null; for (let k = hist.length - 1; k >= 0; k--) if (hist[k].time <= T) { last = hist[k]; break; }
        const age = last ? T - last.time : 9, cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.22;
        const lamp = (x, y, r, on, col) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); if (on) { g.fillStyle = col; g.fill(); } else { g.strokeStyle = C.rule; g.lineWidth = 2 * dpr; g.stroke(); } };
        lamp(cx, cy, R * (1 + Math.max(0, 0.15 - age) ), age < 0.12, C.ink);
        const fresh = last && age < 0.18;
        lamp(cx - R * 1.9, cy + R * 1.2, R * 0.28, fresh && last.a, C.blue);
        lamp(cx, cy + R * 1.6, R * 0.28, fresh && last.b, C.teal);
        lamp(cx + R * 1.9, cy + R * 1.2, R * 0.28, fresh && last.chance, C.orange);
        g.fillStyle = C.muted; g.font = `500 ${11 * dpr}px "IBM Plex Mono", monospace`; g.textAlign = 'center'; g.textBaseline = 'top';
        g.fillText('A', cx - R * 1.9, cy + R * 1.55); g.fillText('B', cx, cy + R * 1.95); g.fillText('chance', cx + R * 1.9, cy + R * 1.55);
        g.textAlign = 'start';
      },

      // Rebuild the panel. The host calls this when cables change.
      render,

      // Called after a patch is loaded or the rack is reset.
      reset() { beat = 0; next = 0; hist = []; },
    };
  },
};

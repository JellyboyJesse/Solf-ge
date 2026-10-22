// LFO — a slow control-signal source: sine, triangle, ramp, square, random steps or drift.
// Sends a control signal, plus a trigger at the start of every cycle.

const SHAPES = {
  sine: { label: 'Sine', f: p => 0.5 - 0.5 * Math.cos(2 * Math.PI * p) },
  triangle: { label: 'Triangle', f: p => 1 - Math.abs(2 * p - 1) },
  ramp: { label: 'Ramp', f: p => p },
  square: { label: 'Square', f: p => (p < 0.5 ? 1 : 0) },
  steps: { label: 'Random steps', f: (p, a) => a },
  drift: { label: 'Drift', f: (p, a, b) => b + (a - b) * (0.5 - 0.5 * Math.cos(Math.PI * p)) },
};
const RMIN = 0.02, RMAX = 8;   // Hz
const toSlider = hz => Math.log(hz / RMIN) / Math.log(RMAX / RMIN);
const fromSlider = v => RMIN * Math.pow(RMAX / RMIN, v);

export default {
  id: 'lfo',
  name: 'LFO',
  short: 'LFO',
  version: 1,
  kind: 'utility',
  multiple: true,
  sound: false,
  description: 'A slow wave for moving things: sine, triangle, ramp, square, random steps or drift. Also fires a trigger every cycle.',

  defaults() { return { rate: 0.25, shape: 'sine', depth: 1 }; },

  create(host) {
    const { clamp, esc } = host.util;
    const st = () => host.state;
    let phase = 0, lastN = null, rmod = 1, rnd = Math.random(), rndPrev = Math.random(), lastWrap = -1, value = 0.5;
    let trace = [], cycles = [], panel = null, ctl = null, cv = null, lamp = null;

    const shapeOf = () => SHAPES[st().shape] || SHAPES.sine;
    const rate = () => st().rate * rmod;
    const fmtHz = hz => (hz >= 1 ? hz.toFixed(2) + ' Hz' : (1 / hz).toFixed(1) + ' s per cycle');

    function render() {
      if (!ctl) return;
      const s = st();
      ctl.innerHTML = `
        <label class="field"><span>Shape</span><select class="lfo-shape">${Object.entries(SHAPES).map(([k, v]) => `<option value="${k}" ${k === s.shape ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
        <label class="field"><span>Rate <output class="lfo-rateOut">${fmtHz(s.rate)}</output></span><input type="range" class="lfo-rate" min="0" max="1" step="0.001" value="${toSlider(s.rate)}"></label>
        <label class="field"><span>Depth <output class="lfo-depthOut">${Math.round(s.depth * 100)}%</output></span><input type="range" class="lfo-depth" min="0" max="1" step="0.01" value="${s.depth}"></label>
        ${host.portsBox('')}`;
    }

    return {
      ports() {
        return [
          { id: 'rate', label: 'rate', dir: 'in', type: 'control' },
          { id: 'reset', label: 'reset', dir: 'in', type: 'trigger' },
          { id: 'out', label: 'out', dir: 'out', type: 'control' },
          { id: 'cycle', label: 'cycle', dir: 'out', type: 'trigger' },
        ];
      },
      schedule(n, until) {
        if (!host.isPatched('rate')) rmod = 1;
        if (lastN === null || n - lastN > 1) lastN = n;
        phase += (n - lastN) * rate(); lastN = n;
        while (phase >= 1) { phase -= 1; rndPrev = rnd; rnd = Math.random(); }
        const tw = n + (1 - phase) / rate();
        if (tw < until && tw - lastWrap > 0.02) { lastWrap = tw; host.emit('cycle', { kind: 'trigger', time: tw, vel: 0.8 }); cycles.push(tw); if (cycles.length > 8) cycles.shift(); }
        const raw = shapeOf().f(phase, rnd, rndPrev);
        value = clamp(0.5 + (raw - 0.5) * st().depth, 0, 1);
        host.emit('out', { kind: 'control', time: n, value });
        trace.push(value); if (trace.length > 160) trace.shift();
      },
      input(port, msg) {
        if (port === 'rate') rmod = Math.pow(4, clamp(msg.value, 0, 1) * 2 - 1);   // ×¼ … ×4
        else if (port === 'reset') { phase = 0; lastN = Math.max(msg.time, host.now()); }
      },
      mount(stage, pnl) {
        panel = pnl;
        panel.innerHTML = `<div class="scope"></div><div class="lamps"><span class="lamp t-trigger"><i></i>cycle</span></div><div class="lfo-ctl"></div>`;
        cv = host.makeCanvas(panel.querySelector('.scope'));
        lamp = panel.querySelector('.lamp'); ctl = panel.querySelector('.lfo-ctl');
        panel.addEventListener('input', e => {
          const t = e.target, v = parseFloat(t.value);
          if (t.classList.contains('lfo-rate')) { st().rate = fromSlider(v); panel.querySelector('.lfo-rateOut').textContent = fmtHz(st().rate); }
          else if (t.classList.contains('lfo-depth')) { st().depth = v; panel.querySelector('.lfo-depthOut').textContent = Math.round(v * 100) + '%'; }
          else return;
          host.save();
        });
        panel.addEventListener('change', e => { if (e.target.classList.contains('lfo-shape')) { st().shape = e.target.value; host.save(); } });
        render();
      },
      draw(T) {
        const C = host.colours(), g = cv.getContext('2d'), W = cv.width, H = cv.height; if (!W || !H) return;
        g.fillStyle = C.paper; g.fillRect(0, 0, W, H);
        g.strokeStyle = C.rule; g.lineWidth = 1; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
        if (trace.length > 1) {
          g.strokeStyle = C.orange; g.lineWidth = Math.max(2, H / 30); g.lineJoin = 'round'; g.beginPath();
          trace.forEach((v, i) => { const x = W * i / 159, y = H - 4 - v * (H - 8); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
          g.stroke();
          const x = W * (trace.length - 1) / 159, y = H - 4 - value * (H - 8);
          g.fillStyle = C.ink; g.beginPath(); g.arc(x, y, Math.max(3, H / 14), 0, Math.PI * 2); g.fill();
        }
        lamp.classList.toggle('on', cycles.some(t => T >= t && T - t < 0.12));
      },
      render,
      reset() { phase = 0; lastN = null; trace = []; cycles = []; },
    };
  },
};

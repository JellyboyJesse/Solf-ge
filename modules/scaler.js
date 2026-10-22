// Scaler — scales, offsets, inverts and smooths a control signal.
// It also fires triggers when the signal rises above, or falls back below, a threshold.

export default {
  id: 'scaler',
  name: 'Scaler',
  short: 'Scaler',
  version: 1,
  kind: 'utility',
  multiple: true,
  sound: false,
  description: 'Scales, offsets, inverts and smooths a control signal, and fires triggers when it crosses a threshold.',

  defaults() { return { amount: 1, offset: 0, slew: 0, threshold: 0.6 }; },

  create(host) {
    const { clamp } = host.util;
    const st = () => host.state;
    let x = 0, y = null, lastT = 0, above = false, crossed = [], panel = null, ctl = null, mIn = null, mOut = null, mThr = null, lamps = {};

    function render() {
      if (!ctl) return;
      const s = st();
      ctl.innerHTML = `
        <label class="field"><span>Amount <output class="sc-aOut">${Math.round(s.amount * 100)}%</output></span><input type="range" class="sc-amount" min="-1" max="1" step="0.01" value="${s.amount}"></label>
        <label class="field"><span>Offset <output class="sc-oOut">${Math.round(s.offset * 100)}%</output></span><input type="range" class="sc-offset" min="-1" max="1" step="0.01" value="${s.offset}"></label>
        <label class="field"><span>Smoothing <output class="sc-sOut">${s.slew ? s.slew.toFixed(2) + ' s' : 'off'}</output></span><input type="range" class="sc-slew" min="0" max="2" step="0.01" value="${s.slew}"></label>
        <label class="field"><span>Threshold <output class="sc-tOut">${Math.round(s.threshold * 100)}%</output></span><input type="range" class="sc-thr" min="0.05" max="0.95" step="0.01" value="${s.threshold}"></label>
        <p class="note">A negative amount turns the signal upside down. Amount −100% with offset +100% inverts it.</p>
        ${host.portsBox('')}`;
    }

    return {
      ports() {
        return [
          { id: 'in', label: 'in', dir: 'in', type: 'control' },
          { id: 'out', label: 'out', dir: 'out', type: 'control' },
          { id: 'rise', label: 'rises', dir: 'out', type: 'trigger' },
          { id: 'fall', label: 'falls', dir: 'out', type: 'trigger' },
        ];
      },
      input(port, msg) {
        if (port !== 'in') return;
        const s = st(); x = clamp(msg.value, 0, 1);
        const target = clamp(s.offset + s.amount * x, 0, 1);
        const dt = Math.max(0, msg.time - lastT); lastT = msg.time;
        y = y === null || s.slew < 0.01 ? target : y + (target - y) * (1 - Math.exp(-dt / s.slew));
        host.emit('out', { kind: 'control', time: msg.time, value: y });
        if (!above && y >= s.threshold) { above = true; host.emit('rise', { kind: 'trigger', time: msg.time, vel: 0.8 }); crossed.push({ time: msg.time, k: 'rise' }); }
        else if (above && y < s.threshold - 0.03) { above = false; host.emit('fall', { kind: 'trigger', time: msg.time, vel: 0.8 }); crossed.push({ time: msg.time, k: 'fall' }); }
        if (crossed.length > 12) crossed.shift();
      },
      mount(stage, pnl) {
        panel = pnl;
        panel.innerHTML = `<div class="field"><span class="note">in</span><div class="meter t-control"><i class="sc-in"></i></div></div>
          <div class="field"><span class="note">out</span><div class="meter t-control"><i class="sc-out"></i><b class="sc-thrm"></b></div></div>
          <div class="lamps"><span class="lamp t-trigger" data-l="rise"><i></i>rises</span><span class="lamp t-trigger" data-l="fall"><i></i>falls</span></div>
          <div class="sc-ctl"></div>`;
        mIn = panel.querySelector('.sc-in'); mOut = panel.querySelector('.sc-out'); mThr = panel.querySelector('.sc-thrm'); ctl = panel.querySelector('.sc-ctl');
        panel.querySelectorAll('[data-l]').forEach(el => { lamps[el.dataset.l] = el; });
        panel.addEventListener('input', e => {
          const t = e.target, v = parseFloat(t.value), s = st(), out = c => panel.querySelector(c);
          if (t.classList.contains('sc-amount')) { s.amount = v; out('.sc-aOut').textContent = Math.round(v * 100) + '%'; }
          else if (t.classList.contains('sc-offset')) { s.offset = v; out('.sc-oOut').textContent = Math.round(v * 100) + '%'; }
          else if (t.classList.contains('sc-slew')) { s.slew = v; out('.sc-sOut').textContent = v ? v.toFixed(2) + ' s' : 'off'; }
          else if (t.classList.contains('sc-thr')) { s.threshold = v; out('.sc-tOut').textContent = Math.round(v * 100) + '%'; }
          else return;
          host.save();
        });
        render();
      },
      draw(T) {
        const live = host.isPatched('in');
        mIn.style.width = (live ? x * 100 : 0) + '%';
        mOut.style.width = (live && y !== null ? y * 100 : 0) + '%';
        mThr.style.left = 'calc(' + st().threshold * 100 + '% - 1px)';
        for (const k of ['rise', 'fall']) lamps[k].classList.toggle('on', crossed.some(c => c.k === k && T >= c.time && T - c.time < 0.15));
      },
      render,
      reset() { y = null; above = false; crossed = []; },
    };
  },
};

// Delay — echoes triggers and notes: each one comes back a set number of times, quieter each time.

export default {
  id: 'delay',
  name: 'Delay',
  short: 'Delay',
  version: 1,
  kind: 'utility',
  multiple: true,
  sound: false,
  description: 'Echoes triggers and notes: each comes back a set number of times, softer each time.',

  defaults() { return { time: 0.3, repeats: 3, decay: 0.7 }; },

  create(host) {
    const { clamp } = host.util;
    const st = () => host.state;
    let queue = [], sent = [], tmod = null, panel = null, ctl = null, lampEl = null;
    const delayTime = () => (host.isPatched('time') && tmod !== null ? 0.02 + tmod * 1.98 : st().time);

    function echo(port, msg) {
      const d = delayTime(), s = st();
      for (let k = 1; k <= s.repeats; k++) {
        const vel = (msg.vel ?? 0.8) * Math.pow(s.decay, k - 1);
        if (vel < 0.02) break;
        queue.push({ at: msg.time + k * d, port, msg: { ...msg, vel } });
      }
      if (queue.length > 256) queue.splice(0, queue.length - 256);
    }
    function render() {
      if (!ctl) return;
      const s = st(), ext = host.isPatched('time');
      ctl.innerHTML = `
        <label class="field"><span>Time <output class="dl-timeOut">${Math.round(s.time * 1000)} ms</output></span><input type="range" class="dl-time" min="0.02" max="2" step="0.01" value="${s.time}" ${ext ? 'disabled' : ''}></label>
        <div class="field"><span>Repeats</span><div class="stepper"><button data-dl="-1" aria-label="Fewer repeats">−</button><output>${s.repeats}</output><button data-dl="1" aria-label="More repeats">+</button></div></div>
        <label class="field"><span>Each echo <output class="dl-decayOut">${Math.round(s.decay * 100)}%</output></span><input type="range" class="dl-decay" min="0.2" max="1" step="0.01" value="${s.decay}"></label>
        ${host.portsBox('')}`;
    }

    return {
      ports() {
        return [
          { id: 'in', label: 'in', dir: 'in', type: 'trigger' },
          { id: 'note-in', label: 'note in', dir: 'in', type: 'note' },
          { id: 'time', label: 'time', dir: 'in', type: 'control' },
          { id: 'out', label: 'out', dir: 'out', type: 'trigger' },
          { id: 'note-out', label: 'note out', dir: 'out', type: 'note' },
        ];
      },
      // Echoes wait here and go out only when they are about to happen, so modules
      // further down the patch see them in time order.
      schedule(n, until) {
        if (!host.isPatched('time')) tmod = null;
        if (!queue.length) return;
        const due = queue.filter(q => q.at < until), rest = queue.filter(q => q.at >= until);
        queue = rest;
        due.sort((a, b) => a.at - b.at);
        for (const q of due) {
          const time = Math.max(q.at, n);
          host.emit(q.port, { ...q.msg, time });
          sent.push(time); if (sent.length > 16) sent.shift();
        }
      },
      input(port, msg) {
        if (port === 'time') tmod = clamp(msg.value, 0, 1);
        else if (port === 'in') echo('out', { kind: 'trigger', time: msg.time, vel: msg.vel });
        else if (port === 'note-in') echo('note-out', { kind: 'note', time: msg.time, midi: msg.midi, vel: msg.vel, dur: msg.dur });
      },
      mount(stage, pnl) {
        panel = pnl;
        panel.innerHTML = `<div class="lamps"><span class="lamp t-trigger"><i></i>echo</span><span class="mono dl-q"></span></div><div class="dl-ctl"></div>`;
        lampEl = panel.querySelector('.lamp'); ctl = panel.querySelector('.dl-ctl');
        panel.addEventListener('click', e => {
          const b = e.target.closest('[data-dl]'); if (!b) return;
          st().repeats = clamp(st().repeats + (+b.dataset.dl), 1, 12); host.save(); render();
        });
        panel.addEventListener('input', e => {
          const t = e.target, v = parseFloat(t.value);
          if (t.classList.contains('dl-time')) { st().time = v; panel.querySelector('.dl-timeOut').textContent = Math.round(v * 1000) + ' ms'; }
          else if (t.classList.contains('dl-decay')) { st().decay = v; panel.querySelector('.dl-decayOut').textContent = Math.round(v * 100) + '%'; }
          else return;
          host.save();
        });
        render();
      },
      draw(T) {
        lampEl.classList.toggle('on', sent.some(t => T >= t && T - t < 0.1));
        const q = panel.querySelector('.dl-q'); const n = queue.length;
        q.textContent = n ? n + ' waiting' : '';
      },
      render,
      reset() { queue = []; sent = []; },
    };
  },
};

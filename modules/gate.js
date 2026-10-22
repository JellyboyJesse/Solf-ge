// Gate — a coin toss for every trigger: it goes out of A with the set chance, otherwise out of B.

export default {
  id: 'gate',
  name: 'Gate',
  short: 'Gate',
  version: 1,
  kind: 'utility',
  multiple: true,
  sound: false,
  description: 'A coin toss for every trigger: it goes out of A with the set chance, otherwise out of B.',

  defaults() { return { chance: 0.5 }; },

  create(host) {
    const { clamp } = host.util;
    const st = () => host.state;
    let mod = null, fired = [], panel = null, ctl = null, lamps = {};
    const chance = () => (host.isPatched('chance') && mod !== null ? mod : st().chance);

    function render() {
      if (!ctl) return;
      const ext = host.isPatched('chance');
      ctl.innerHTML = `
        <label class="field"><span>Chance of A <output class="gt-out">${Math.round(st().chance * 100)}%</output></span><input type="range" class="gt-chance" min="0" max="1" step="0.01" value="${st().chance}" ${ext ? 'disabled' : ''}></label>
        ${ext ? '<p class="note">The chance input is setting this.</p>' : ''}
        ${host.portsBox('')}`;
    }

    return {
      ports() {
        return [
          { id: 'in', label: 'in', dir: 'in', type: 'trigger' },
          { id: 'chance', label: 'chance', dir: 'in', type: 'control' },
          { id: 'a', label: 'A', dir: 'out', type: 'trigger' },
          { id: 'b', label: 'B', dir: 'out', type: 'trigger' },
        ];
      },
      schedule() { if (!host.isPatched('chance')) mod = null; },
      input(port, msg) {
        if (port === 'chance') { mod = clamp(msg.value, 0, 1); return; }
        if (port !== 'in') return;
        const out = Math.random() < chance() ? 'a' : 'b';
        host.emit(out, { kind: 'trigger', time: msg.time, vel: msg.vel ?? 0.8 });
        fired.push({ time: msg.time, out }); if (fired.length > 16) fired.shift();
      },
      mount(stage, pnl) {
        panel = pnl;
        panel.innerHTML = `<div class="lamps"><span class="lamp t-trigger" data-l="a"><i></i>A</span><span class="lamp t-trigger" data-l="b"><i></i>B</span></div><div class="gt-ctl"></div>`;
        ctl = panel.querySelector('.gt-ctl');
        panel.querySelectorAll('[data-l]').forEach(el => { lamps[el.dataset.l] = el; });
        panel.addEventListener('input', e => {
          if (!e.target.classList.contains('gt-chance')) return;
          st().chance = parseFloat(e.target.value); panel.querySelector('.gt-out').textContent = Math.round(st().chance * 100) + '%'; host.save();
        });
        render();
      },
      draw(T) {
        for (const k of ['a', 'b']) lamps[k].classList.toggle('on', fired.some(f => f.out === k && T >= f.time && T - f.time < 0.12));
      },
      render,
      reset() { fired = []; mod = null; },
    };
  },
};

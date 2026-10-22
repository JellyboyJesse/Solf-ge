// Clock — a steady beat with two dividers and a chance gate.
// It is also the simplest complete utility, so copy this file when starting a new one.
// See MODULES.md for the full contract.

export default {
  // id must match the file name (modules/clock.js) and use only a–z, 0–9 and hyphens.
  id: 'clock',
  name: 'Clock',
  short: 'Clock',
  version: 1,
  kind: 'utility',          // lives on the Utilities page as a strip
  multiple: true,           // the rack can hold several clocks: clock, clock-2, …
  description: 'A steady beat with two dividers and a chance gate, for modules that follow a clock.',

  // Saved settings for a new instance. Plain JSON only: no functions, no audio nodes.
  defaults() {
    return { bpm: 100, a: 2, b: 3, chance: 0.35, tick: false };
  },

  // create() runs once per instance. Keep runtime things (timers, audio nodes) in local variables
  // here, and always read settings through host.state, because loading a patch replaces it.
  create(host) {
    const { clamp } = host.util;
    const st = () => host.state;
    let next = 0, beat = 0, tmod = 1, hist = [];
    let panel = null, ctl = null, lamps = {};

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

    // The panel has a fixed part (lamps) and a part rebuilt by render() (controls and jacks).
    function render() {
      if (!ctl) return;
      const s = st();
      ctl.innerHTML = `
        <label class="field"><span>Tempo <output class="ck-bpmOut">${s.bpm} bpm</output></span><input type="range" class="ck-bpm" min="30" max="240" step="1" value="${s.bpm}" ${host.isPatched('tempo') ? 'disabled' : ''}></label>
        <div class="field"><span>A every</span><div class="stepper"><button data-ck="a" data-d="-1" aria-label="Fewer beats for A">−</button><output>${s.a}</output><button data-ck="a" data-d="1" aria-label="More beats for A">+</button><span class="note">beats</span></div></div>
        <div class="field"><span>B every</span><div class="stepper"><button data-ck="b" data-d="-1" aria-label="Fewer beats for B">−</button><output>${s.b}</output><button data-ck="b" data-d="1" aria-label="More beats for B">+</button><span class="note">beats</span></div></div>
        <label class="field"><span>Chance per beat <output class="ck-chanceOut">${Math.round(s.chance * 100)}%</output></span><input type="range" class="ck-chance" min="0" max="1" step="0.01" value="${s.chance}"></label>
        <label class="toggle"><input type="checkbox" class="ck-tick" ${s.tick ? 'checked' : ''}>Audible tick</label>
        ${host.portsBox('')}`;
    }

    return {
      // Ports: ids are local to this module. Types: clock, trigger, note, control.
      ports() {
        return [
          { id: 'tempo', label: 'tempo', dir: 'in', type: 'control' },
          { id: 'reset', label: 'reset', dir: 'in', type: 'trigger' },
          { id: 'beat', label: 'beat', dir: 'out', type: 'clock' },
          { id: 'a', label: 'A', dir: 'out', type: 'trigger' },
          { id: 'b', label: 'B', dir: 'out', type: 'trigger' },
          { id: 'chance', label: 'chance', dir: 'out', type: 'trigger' },
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
        if (port === 'tempo') tmod = 0.5 + clamp(msg.value, 0, 1) * 1.5;
        else if (port === 'reset') { beat = 0; next = Math.max(msg.time, host.now()); }
      },

      // Build the page once. A utility gets no stage (null), only its strip's body as the panel.
      // Scope every lookup to the panel: there may be several clocks on the page.
      mount(stage, pnl) {
        panel = pnl;
        panel.innerHTML = `<div class="lamps">${['beat', 'a', 'b', 'chance'].map(k => `<span class="lamp ${k === 'beat' ? 't-clock' : 't-trigger'}" data-lamp="${k}"><i></i>${k === 'a' ? 'A' : k === 'b' ? 'B' : k}</span>`).join('')}</div><div class="ck-ctl"></div>`;
        ctl = panel.querySelector('.ck-ctl');
        panel.querySelectorAll('[data-lamp]').forEach(el => { lamps[el.dataset.lamp] = el; });
        panel.addEventListener('click', e => {
          const b = e.target.closest('[data-ck]'); if (!b) return;
          st()[b.dataset.ck] = clamp(st()[b.dataset.ck] + (+b.dataset.d), 1, 16); host.save(); render();
        });
        panel.addEventListener('input', e => {
          const v = parseFloat(e.target.value);
          if (e.target.classList.contains('ck-bpm')) { st().bpm = v; panel.querySelector('.ck-bpmOut').textContent = v + ' bpm'; }
          else if (e.target.classList.contains('ck-chance')) { st().chance = v; panel.querySelector('.ck-chanceOut').textContent = Math.round(v * 100) + '%'; }
          else return;
          host.save();
        });
        panel.addEventListener('change', e => { if (e.target.classList.contains('ck-tick')) { st().tick = e.target.checked; host.save(); } });
        render();
      },

      // Called every animation frame while this module is on screen. T is the audio time.
      draw(T) {
        let last = null; for (let k = hist.length - 1; k >= 0; k--) if (hist[k].time <= T) { last = hist[k]; break; }
        const fresh = last && T - last.time < 0.12;
        for (const k in lamps) lamps[k].classList.toggle('on', !!(fresh && last[k]));
      },

      // Rebuild the controls. The host calls this when cables change.
      render,

      // Called after a patch is loaded.
      reset() { beat = 0; next = 0; hist = []; },
    };
  },
};

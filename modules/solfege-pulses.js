// Solfège Pulses — do, re, mi… each sung every so many pulses.
// Runs on its own tempo unless something is patched into clock or step.

const SYL = ['do', 're', 'mi', 'fa', 'sol', 'la', 'ti'];
const SEMI = [0, 2, 4, 5, 7, 9, 11];
const VOWEL = { do: 'o', re: 'e', mi: 'i', fa: 'a', sol: 'o', la: 'a', ti: 'i' };
const FORMANTS = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [300, 2250, 3000], o: [520, 860, 2410] };

export default {
  id: 'solfege-pulses',
  name: 'Solfège Pulses',
  short: 'Pulses',
  version: 1,

  defaults() {
    return {
      bpm: 96, key: 2,
      voices: [{ every: 4, on: true }, { every: 6, on: false }, { every: 3, on: true }, { every: 8, on: false }, { every: 5, on: true }, { every: 9, on: false }, { every: 7, on: true }],
    };
  },

  create(host) {
    const { clamp, mtof, noteName, NOTE_NAMES } = host.util;
    const st = () => host.state;
    let count = 0, next = 0, tmod = 1, hist = [], fired = [], lastPulse = 0, interval = 0.31;
    let sbus = [], cv = null, panel = null;
    const external = () => host.isPatched('clock') || host.isPatched('step');

    function sing(i, midi, time, dur, vel, incoming) {
      fired.push({ time, i, incoming }); if (fired.length > 40) fired.shift();
      const ctx = host.ctx; if (!ctx || !sbus[i]) return;
      const f = mtof(midi), F = FORMANTS[VOWEL[SYL[i]]], end = time + dur + 0.4;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, time); env.gain.linearRampToValueAtTime(0.2 * vel, time + 0.06);
      env.gain.setValueAtTime(0.2 * vel, time + Math.max(0.07, dur)); env.gain.exponentialRampToValueAtTime(0.0001, end);
      env.connect(sbus[i]);
      const pre = ctx.createGain(); pre.gain.value = 0.5;
      F.forEach((ff, k) => {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = ff; bp.Q.value = [6, 10, 13][k];
        const g = ctx.createGain(); g.gain.value = [3, 1.8, 1.1][k]; pre.connect(bp); bp.connect(g); g.connect(env);
      });
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2;
      const lg = ctx.createGain(); lg.gain.setValueAtTime(0, time); lg.gain.linearRampToValueAtTime(f * 0.012, time + 0.35); lfo.connect(lg);
      for (const m of [1, 1.005]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * m; lg.connect(o.frequency); o.connect(pre); o.start(time); o.stop(end); }
      lfo.start(time); lfo.stop(end);
    }
    function pulse(time) {
      if (lastPulse && external()) interval = clamp(time - lastPulse, 0.08, 1.5);
      lastPulse = time; count++;
      hist.push({ time, count }); if (hist.length > 24) hist.shift();
      host.emit('pulse', { kind: 'clock', time });
      st().voices.forEach((v, i) => {
        if (v.on && count % v.every === 0) {
          const midi = 60 + st().key + SEMI[i], dur = Math.min(1.6, interval * Math.min(v.every, 4) * 0.85);
          sing(i, midi, time, dur, 0.8, false);
          host.emit('notes', { kind: 'note', time, midi, vel: 0.8, dur });
        }
      });
    }

    function render() {
      if (!panel) return;
      const s = st(), ext = external();
      panel.innerHTML = `<div class="ph"><h2>Solfège Pulses</h2><p class="lede">Each syllable sings every so many pulses. Notes arriving from other modules are sung as the nearest syllable.</p></div>
        <fieldset class="group"><legend>Timing</legend>
          <p class="status">${ext ? 'Following its clock / step input' : 'Running on its own tempo'}</p>
          <label class="field"><span>Tempo <output id="sp-bpmOut">${s.bpm} bpm</output></span><input type="range" id="sp-bpm" min="40" max="200" step="1" value="${s.bpm}" ${ext ? 'disabled' : ''}></label>
          <label class="field"><span>Key (do =)</span><select id="sp-key">${NOTE_NAMES.map((n, i) => `<option value="${i}" ${i === s.key ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        </fieldset>
        <fieldset class="group"><legend>Syllables</legend>
          <ul class="sp-syls">${s.voices.map((v, i) => `<li><button class="sp-syl ${v.on ? 'on' : ''}" data-act="sp-toggle" data-i="${i}" aria-pressed="${v.on}">${SYL[i]}</button><span class="note">every</span>
            <div class="stepper"><button data-act="sp-step" data-i="${i}" data-d="-1" aria-label="Fewer pulses for ${SYL[i]}">−</button><output>${v.every}</output><button data-act="sp-step" data-i="${i}" data-d="1" aria-label="More pulses for ${SYL[i]}">+</button></div>
            <span class="mono">${noteName(60 + s.key + SEMI[i])}</span></li>`).join('')}</ul>
        </fieldset>${host.portsBox('')}`;
    }

    return {
      ports() {
        return [
          { id: 'notes', label: 'notes', dir: 'out', type: 'note' },
          { id: 'pulse', label: 'pulse', dir: 'out', type: 'clock' },
          { id: 'clock', label: 'clock', dir: 'in', type: 'clock' },
          { id: 'step', label: 'step', dir: 'in', type: 'trigger' },
          { id: 'sing', label: 'sing', dir: 'in', type: 'note' },
          { id: 'tempo', label: 'tempo', dir: 'in', type: 'control' },
        ];
      },
      audioSources() { return SYL.map(s => ({ id: s, label: s })); },
      getBus(sub) { const i = SYL.indexOf(sub); return i < 0 ? null : sbus[i]; },
      audioInit() { sbus = SYL.map(() => { const g = host.ctx.createGain(); g.connect(host.output); return g; }); },
      schedule(n, until) {
        if (!host.isPatched('tempo')) tmod = 1;
        if (external()) { next = 0; return; }
        if (!next || next < n - 0.5) next = n + 0.05;
        while (next < until) { const iv = 60 / (st().bpm * tmod) / 2; interval = iv; pulse(next); next += iv; }
      },
      input(port, msg) {
        const t = Math.max(msg.time, host.now());
        if (port === 'clock' || port === 'step') pulse(t);
        else if (port === 'tempo') tmod = 0.5 + clamp(msg.value, 0, 1);
        else if (port === 'sing') {
          const k = st().key, rel = msg.midi - (60 + k), oct = Math.floor(rel / 12), pc = ((rel % 12) + 12) % 12;
          let bi = 0, bd = 99;
          SEMI.forEach((s, i) => { const d = Math.min(Math.abs(pc - s), 12 - Math.abs(pc - s)); if (d < bd) { bd = d; bi = i; } });
          sing(bi, 60 + k + clamp(oct, -1, 1) * 12 + SEMI[bi], t, clamp(msg.dur || 0.5, 0.15, 1.5), clamp(msg.vel || 0.7, 0.1, 1) * 0.85, true);
        }
      },
      mount(stage, pnl) {
        panel = pnl;
        cv = host.makeCanvas(stage);
        const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Each ring is one syllable · it sings when its dot reaches the top'; stage.appendChild(hint);
        const css = document.createElement('style');
        css.textContent = `.sp-syls{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
          .sp-syls li{display:grid;grid-template-columns:62px auto 1fr auto;align-items:center;gap:10px}
          .sp-syl{border:1.5px solid var(--rule);background:transparent;border-radius:6px;padding:5px 0;font-family:var(--font-display);font-weight:800;cursor:pointer;color:var(--muted)}
          .sp-syl.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}`;
        stage.appendChild(css);
        panel.addEventListener('click', e => {
          const b = e.target.closest('[data-act]'); if (!b) return; const v = st().voices[+b.dataset.i];
          if (b.dataset.act === 'sp-toggle') v.on = !v.on;
          else if (b.dataset.act === 'sp-step') v.every = clamp(v.every + (+b.dataset.d), 1, 16);
          else return;
          host.save(); render();
        });
        panel.addEventListener('input', e => {
          if (e.target.id !== 'sp-bpm') return;
          st().bpm = +e.target.value; panel.querySelector('#sp-bpmOut').textContent = st().bpm + ' bpm'; host.save();
        });
        panel.addEventListener('change', e => { if (e.target.id === 'sp-key') { st().key = +e.target.value; host.save(); render(); } });
        render();
      },
      draw(T) {
        const C = host.colours(), g = cv.getContext('2d'), W = cv.width, H = cv.height; if (!W || !H) return;
        const dpr = W / (cv.clientWidth || W);
        g.fillStyle = C.paper; g.fillRect(0, 0, W, H);
        const cx = W / 2, cy = H / 2 + 4 * dpr, maxR = Math.min(W, H) * 0.43, inner = maxR * 0.26;
        let cnt = 0; for (let k = hist.length - 1; k >= 0; k--) if (hist[k].time <= T) { cnt = hist[k].count; break; }
        g.font = `700 ${11 * dpr}px "IBM Plex Mono", monospace`; g.textBaseline = 'middle';
        st().voices.forEach((v, i) => {
          const r = inner + (maxR - inner) * i / 6, n = v.every;
          let fl = null; for (let k = fired.length - 1; k >= 0; k--) { const f = fired[k]; if (f.i === i && f.time <= T && T - f.time < 0.45) { fl = f; break; } }
          g.strokeStyle = C.rule; g.lineWidth = dpr; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
          if (fl) { g.strokeStyle = fl.incoming ? C.blue : C.pink; g.globalAlpha = 1 - (T - fl.time) / 0.45; g.lineWidth = 3 * dpr; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1; }
          for (let k = 0; k < n; k++) {
            const a = -Math.PI / 2 + Math.PI * 2 * k / n, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, act = v.on && cnt % n === k;
            g.fillStyle = !v.on ? C.rule : act ? (k === 0 ? C.pink : C.ink) : C.muted;
            g.beginPath(); g.arc(x, y, (act ? 5 : 2.4) * dpr, 0, Math.PI * 2); g.fill();
          }
          g.fillStyle = v.on ? C.ink : C.muted; g.fillText(SYL[i], cx + 9 * dpr, cy - r - 1);
        });
        g.textAlign = 'center'; g.fillStyle = C.ink; g.font = `800 ${18 * dpr}px Syne, sans-serif`; g.fillText(NOTE_NAMES[st().key], cx, cy - 6 * dpr);
        g.font = `500 ${10 * dpr}px "IBM Plex Mono", monospace`; g.fillStyle = C.muted;
        g.fillText(external() ? 'ext pulse' : Math.round(st().bpm * tmod) + ' bpm', cx, cy + 12 * dpr); g.textAlign = 'start';
      },
      render,
      reset() { count = 0; next = 0; hist = []; fired = []; lastPulse = 0; },
    };
  },
};

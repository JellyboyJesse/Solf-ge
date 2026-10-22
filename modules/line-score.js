// Line Score — draw lines in five inks; a player runs along each one.
// Line height opens the filter, crossings bend the sound and send notes,
// and each ink can sample audio from any other module.

const COLOURS = [{ id: 'pink', name: 'Pink' }, { id: 'blue', name: 'Blue' }, { id: 'yellow', name: 'Yellow' }, { id: 'teal', name: 'Teal' }, { id: 'orange', name: 'Orange' }];
const W0 = 1000, H0 = 625;                       // drawing space, in world units
const CROSS_DET = [700, -500, 1200, -1200, 300];  // detune in cents when crossing each ink
const MAX_PLAYERS = 4;

function mkLine(id, c, fn, n, phase) {
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const u = k / n, [x, y] = fn(u);
    const w = Math.max(1.8, Math.min(9.5, 5 + 2.6 * Math.sin(u * 7 + phase) + 1.2 * Math.sin(u * 21)));
    pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(w * 10) / 10]);
  }
  return { id, c, pts };
}

export default {
  id: 'line-score',
  name: 'Line Score',
  short: 'Score',
  version: 1,
  kind: 'instrument',
  description: 'Draw ink lines that play as sounds. Crossings bend the sound and send notes; each ink can sample any other module.',

  defaults() {
    return {
      nextId: 5, sel: 0, root: 2,
      lines: [
        mkLine(1, 0, u => [140 + u * 600, 300 + 105 * Math.sin(u * Math.PI * 3)], 90, 0),
        mkLine(2, 1, u => [170 + u * 650, 565 - u * 470 + 38 * Math.sin(u * Math.PI * 2)], 80, 2),
        mkLine(3, 2, u => { const a = Math.PI * 0.85 + u * Math.PI * 1.5; return [560 + 190 * Math.cos(a), 330 + 165 * Math.sin(a)]; }, 90, 4),
        mkLine(4, 3, u => [610 + u * 310, 470 + 48 * Math.sin(u * Math.PI * 4) + u * 70], 50, 1),
      ],
      colours: COLOURS.map((c, i) => ({ source: 'ink', from: i === 0 ? 'bell-towers.t2' : 'bell-towers', len: 2, vol: 0.8, take: 0 })),
    };
  },

  create(host) {
    const { clamp, mtof, esc, armed, r1, NOTE_NAMES } = host.util;
    const st = () => host.state;
    let rt = {}, takes = COLOURS.map(() => []), rec = [], tool = 'draw', cur = null;
    let layers = [], layersDirty = true, view = null, cbus = null, waves = null;
    let cv = null, panel = null, hint = null;

    const sel = () => st().sel || 0;
    const trigMode = ci => host.isPatched(COLOURS[ci].id + '.start');
    function yMidi(y) { const s = clamp(Math.floor((1 - y / H0) * 14), 0, 13), pent = [0, 2, 4, 7, 9]; return 48 + st().root + 12 * Math.floor(s / 5) + pent[s % 5]; }

    function recompute() {
      const old = rt, lines = st().lines; rt = {};
      for (const L of lines) {
        const o = old[L.id], cum = [0]; let bb = [1e9, 1e9, -1e9, -1e9];
        for (let k = 0; k < L.pts.length; k++) {
          const p = L.pts[k];
          if (k) cum.push(cum[k - 1] + Math.hypot(p[0] - L.pts[k - 1][0], p[1] - L.pts[k - 1][1]));
          bb = [Math.min(bb[0], p[0]), Math.min(bb[1], p[1]), Math.max(bb[2], p[0]), Math.max(bb[3], p[1])];
        }
        const len = cum[cum.length - 1] || 1;
        rt[L.id] = { cum, len, dur: Math.max(0.5, len / 200), cross: [], plays: o ? o.plays : [], flashes: o ? o.flashes : [], bb };
      }
      for (const id in old) if (!rt[id]) for (const p of old[id].plays) fade(p);
      for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
        const A = lines[i], B = lines[j]; if (A.c === B.c) continue;
        const ra = rt[A.id], rb = rt[B.id];
        if (ra.bb[2] < rb.bb[0] || rb.bb[2] < ra.bb[0] || ra.bb[3] < rb.bb[1] || rb.bb[3] < ra.bb[1]) continue;
        for (let a = 0; a < A.pts.length - 1; a++) {
          const p1 = A.pts[a], p2 = A.pts[a + 1];
          for (let b = 0; b < B.pts.length - 1; b++) {
            const q1 = B.pts[b], q2 = B.pts[b + 1];
            if (Math.max(p1[0], p2[0]) < Math.min(q1[0], q2[0]) || Math.max(q1[0], q2[0]) < Math.min(p1[0], p2[0]) ||
                Math.max(p1[1], p2[1]) < Math.min(q1[1], q2[1]) || Math.max(q1[1], q2[1]) < Math.min(p1[1], p2[1])) continue;
            const rx = p2[0] - p1[0], ry = p2[1] - p1[1], sx = q2[0] - q1[0], sy = q2[1] - q1[1], den = rx * sy - ry * sx;
            if (Math.abs(den) < 1e-9) continue;
            const t = ((q1[0] - p1[0]) * sy - (q1[1] - p1[1]) * sx) / den, u = ((q1[0] - p1[0]) * ry - (q1[1] - p1[1]) * rx) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            const x = p1[0] + rx * t, y = p1[1] + ry * t;
            ra.cross.push({ t: (ra.cum[a] + t * (ra.cum[a + 1] - ra.cum[a])) / ra.len, x, y, oc: B.c });
            rb.cross.push({ t: (rb.cum[b] + u * (rb.cum[b + 1] - rb.cum[b])) / rb.len, x, y, oc: A.c });
          }
        }
      }
      const n = host.now();
      for (const id in rt) {
        const r = rt[id];
        r.cross.sort((a, b) => a.t - b.t); r.cross = r.cross.filter((c, k, arr) => !k || c.t - arr[k - 1].t > 0.004);
        for (const p of r.plays) { const prog = (n - p.start) / p.dur; let k = 0; while (k < r.cross.length && r.cross[k].t <= prog) k++; p.ci = k; }
      }
      layersDirty = true;
    }
    function posAt(L, u) {
      const r = rt[L.id], d = clamp(u, 0, 1) * r.len, cum = r.cum, pts = L.pts; let lo = 0, hi = cum.length - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
      const f = clamp((d - cum[lo]) / ((cum[hi] - cum[lo]) || 1), 0, 1);
      return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
    }

    /* sound */
    function voice(L, time, dur) {
      const ctx = host.ctx, ci = L.c, cs = st().colours[ci];
      const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.Q.value = 4;
      const g = ctx.createGain();
      const N = 48, curve = new Float32Array(N);
      for (let k = 0; k < N; k++) curve[k] = 160 * Math.pow(2, (1 - posAt(L, k / (N - 1))[1] / H0) * 6.3);
      filt.frequency.setValueCurveAtTime(curve, time, dur);
      const a = Math.min(0.03, dur * 0.2);
      g.gain.setValueAtTime(0, time); g.gain.linearRampToValueAtTime(0.15, time + a);
      g.gain.setValueAtTime(0.15, Math.max(time + a, time + dur - 0.06)); g.gain.linearRampToValueAtTime(0, time + dur);
      const take = cs.source === 'sample' && takes[ci][cs.take]; let src;
      if (take) { src = ctx.createBufferSource(); src.buffer = take.buf; src.playbackRate.value = clamp(take.buf.duration / dur, 0.0625, 16); }
      else { src = ctx.createOscillator(); src.setPeriodicWave(waves[ci]); src.frequency.value = mtof(yMidi(L.pts[0][1]) - 12); }
      src.connect(filt); filt.connect(g); g.connect(cbus[ci]); src.start(time); src.stop(time + dur + 0.05);
      return { src, g, filt };
    }
    function fade(p) {
      if (!p.voice) return;
      try {
        const t = host.now(), gg = p.voice.g.gain;
        if (gg.cancelAndHoldAtTime) gg.cancelAndHoldAtTime(t); else gg.cancelScheduledValues(t);
        gg.setTargetAtTime(0, t, 0.02); p.voice.src.stop(t + 0.15);
      } catch (e) { /* already stopped */ }
    }
    function startPlay(L, time, free) {
      const r = rt[L.id]; if (!r || !host.ctx) return;
      const active = r.plays.filter(p => !p.dead && p.start + p.dur > host.now());
      if (active.length >= MAX_PLAYERS) { const old = active[0]; fade(old); old.dead = true; old.endDone = true; r.plays = r.plays.filter(p => p !== old); }
      let v = null; try { v = voice(L, time, r.dur); } catch (e) { console.error(e); }
      r.plays.push({ start: time, dur: r.dur, ci: 0, free, voice: v, endDone: false });
    }
    function crossEvent(L, x, tt, p) {
      const id = COLOURS[L.c].id, r = rt[L.id];
      host.emit(id + '.cross', { kind: 'trigger', time: tt, vel: 0.8 });
      host.emit(id + '.note', { kind: 'note', time: tt, midi: yMidi(x.y), vel: 0.8, dur: 0.45 });
      const v = p.voice;
      if (v) {
        try {
          const d = v.src.detune;
          if (d) { d.setValueAtTime(0, tt); d.linearRampToValueAtTime(CROSS_DET[x.oc], tt + 0.05); d.linearRampToValueAtTime(0, tt + 0.8); }
          v.filt.Q.setValueAtTime(14, tt); v.filt.Q.setTargetAtTime(4, tt + 0.05, 0.25);
        } catch (e) { /* voice ended */ }
      }
      r.flashes.push({ time: tt, x: x.x, y: x.y, oc: x.oc }); if (r.flashes.length > 12) r.flashes.shift();
    }

    /* sampling */
    function sourceLabel(id) { return (host.audioSources().find(s => s.id === id) || { label: id }).label; }
    function capture(ci, time) {
      const ctx = host.ctx; if (!ctx || rec[ci]) return;
      const cs = st().colours[ci], bus = host.getBus(cs.from);
      if (!bus) { host.toast('That sound source no longer exists. Pick another one.'); return; }
      if (!ctx.createScriptProcessor) { host.toast('This browser cannot record from other modules.'); return; }
      const sr = ctx.sampleRate, n = Math.floor(cs.len * sr), data = new Float32Array(n); let w = 0;
      const sp = ctx.createScriptProcessor(4096, 1, 1), z = ctx.createGain(); z.gain.value = 0;
      bus.connect(sp); sp.connect(z); z.connect(ctx.destination);
      const r = rec[ci] = { progress: 0, from: cs.from };
      sp.onaudioprocess = e => {
        const inp = e.inputBuffer.getChannelData(0), t0 = e.playbackTime || ctx.currentTime;
        for (let k = 0; k < inp.length && w < n; k++) { if (t0 + k / sr < time) continue; data[w++] = inp[k]; }
        r.progress = w / n;
        if (w >= n) {
          sp.onaudioprocess = null;
          try { bus.disconnect(sp); } catch (err) { /* gone */ }
          sp.disconnect(); z.disconnect(); rec[ci] = null; finishTake(ci, data, r.from);
        }
      };
      render();
    }
    function addTake(ci, buf, label) {
      const tk = takes[ci]; tk.unshift({ buf, label }); if (tk.length > 4) tk.pop();
      const cs = st().colours[ci]; cs.take = 0; cs.source = 'sample'; host.save(); render();
    }
    function finishTake(ci, data, from) {
      const label = sourceLabel(from); let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      if (peak < 0.0005) { host.toast(label + ' was silent during the take. Record while it is sounding.'); render(); return; }
      const g = 0.9 / peak; for (let i = 0; i < data.length; i++) data[i] *= g;
      const buf = host.ctx.createBuffer(1, data.length, host.ctx.sampleRate); buf.copyToChannel(data, 0);
      addTake(ci, buf, label); host.toast('New take on ' + COLOURS[ci].name + ' · ' + label);
    }
    async function loadFile(file) {
      if (!file || !host.ctx) return; const ci = sel();
      try { const buf = await host.ctx.decodeAudioData(await file.arrayBuffer()); addTake(ci, buf, file.name.replace(/\.[^.]+$/, '').slice(0, 24)); host.toast('Loaded ' + file.name + ' into ' + COLOURS[ci].name); }
      catch (e) { host.toast('That file could not be decoded. Try a WAV, MP3 or OGG file.'); }
    }

    /* drawing */
    function toWorld(e) { const rc = cv.getBoundingClientRect(), dpr = cv.width / rc.width, v = view || { s: 1, ox: 0, oy: 0 }; return [((e.clientX - rc.left) * dpr - v.ox) / v.s, ((e.clientY - rc.top) * dpr - v.oy) / v.s]; }
    function eraseAt(x, y) {
      let best = null, bd = 18;
      for (const L of st().lines) for (let k = 0; k < L.pts.length - 1; k++) {
        const a = L.pts[k], b = L.pts[k + 1], dx = b[0] - a[0], dy = b[1] - a[1];
        const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / ((dx * dx + dy * dy) || 1), 0, 1), d = Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y);
        if (d < bd) { bd = d; best = L; }
      }
      if (best) { st().lines = st().lines.filter(L => L !== best); recompute(); host.save(); render(); }
    }
    function buildLayers(Wd, Hd) {
      const C = host.colours(), v = view;
      layers = COLOURS.map((c, ci) => {
        let lc = layers[ci]; if (!lc) lc = document.createElement('canvas');
        if (lc.width !== Wd || lc.height !== Hd) { lc.width = Wd; lc.height = Hd; }
        const g = lc.getContext('2d'); g.clearRect(0, 0, Wd, Hd); g.strokeStyle = C[c.id]; g.lineCap = 'round'; g.lineJoin = 'round';
        for (const L of st().lines) {
          if (L.c !== ci) continue;
          for (let k = 1; k < L.pts.length; k++) {
            const a = L.pts[k - 1], b = L.pts[k]; g.lineWidth = Math.max(1, (a[2] + b[2]) / 2 * v.s);
            g.beginPath(); g.moveTo(v.ox + a[0] * v.s, v.oy + a[1] * v.s); g.lineTo(v.ox + b[0] * v.s, v.oy + b[1] * v.s); g.stroke();
          }
        }
        return lc;
      });
      layersDirty = false;
    }
    function drawWave() {
      const wc = panel && panel.querySelector('#ls-wave'); if (!wc) return;
      const cs = st().colours[sel()], tk = takes[sel()][cs.take]; if (!tk) return;
      const dpr = window.devicePixelRatio || 1; wc.width = Math.round(wc.clientWidth * dpr); wc.height = Math.round(wc.clientHeight * dpr);
      const g = wc.getContext('2d'), Wd = wc.width, Hd = wc.height, d = tk.buf.getChannelData(0);
      g.fillStyle = host.colours()[COLOURS[sel()].id]; const step = Math.max(1, Math.floor(d.length / Wd));
      for (let x = 0; x < Wd; x++) {
        let mn = 1, mx = -1; for (let k = x * step; k < Math.min(d.length, (x + 1) * step); k++) { const v = d[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
        g.fillRect(x, (1 - mx) * Hd / 2, 1, Math.max(1, (mx - mn) * Hd / 2));
      }
    }

    function render() {
      if (!panel) return;
      const ci = sel(), c = COLOURS[ci], cs = st().colours[ci], n = st().lines.filter(l => l.c === ci).length, trig = trigMode(ci), tk = takes[ci];
      const srcs = host.audioSources().filter(s => s.id !== host.id + '.' + c.id && s.id !== host.id);
      if (!srcs.some(s => s.id === cs.from) && srcs.length) cs.from = srcs[0].id;
      const groups = []; for (const s of srcs) { let gr = groups.find(x => x.module === s.module); if (!gr) groups.push(gr = { module: s.module, name: s.moduleName || s.module, list: [] }); gr.list.push(s); }
      if (hint) hint.textContent = tool === 'erase' ? 'Tap a line to erase it' : 'Drawing in ' + c.name.toLowerCase() + ' · slow strokes give thicker ink';
      const ctx = host.ctx;
      panel.innerHTML = `<div class="ph"><h2>Line Score</h2><p class="lede">Each line is a sound. A player runs along it, the line's height opens the filter, and where inks cross the sound bends and a note goes out.</p></div>
        <div class="row"><div class="segs"><button class="seg ${tool === 'draw' ? 'on' : ''}" data-act="ls-tool" data-tool="draw">Draw</button><button class="seg ${tool === 'erase' ? 'on' : ''}" data-act="ls-tool" data-tool="erase">Erase</button></div><button class="btn ghost" data-act="ls-undo">Undo line</button></div>
        <div class="ls-inks">${COLOURS.map((k, i) => `<button class="ls-ink ${i === ci ? 'on' : ''}" style="--ink-c:var(--${k.id})" data-act="ls-colour" data-i="${i}"><span></span>${k.name}${rec[i] ? '<i>rec</i>' : ''}</button>`).join('')}</div>
        <fieldset class="group"><legend>${c.name} ink</legend>
          <p class="status">${n} line${n === 1 ? '' : 's'} · ${trig ? 'each start trigger sends out a new player' : 'loops on its own'}</p>
          <div class="field"><span>Sound</span><div class="segs"><button class="seg ${cs.source !== 'sample' || !tk.length ? 'on' : ''}" data-act="ls-src" data-v="ink">Ink tone</button><button class="seg ${cs.source === 'sample' && tk.length ? 'on' : ''}" data-act="ls-src" data-v="sample" ${tk.length ? '' : 'disabled'}>Sample</button></div></div>
          <label class="field"><span>Sample from</span><select id="ls-from">${groups.map(gr => `<optgroup label="${esc(gr.name)}">${gr.list.map(s => `<option value="${s.id}" ${s.id === cs.from ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`).join('')}</select></label>
          <label class="field"><span>Take length</span><select id="ls-len">${[1, 2, 4, 8].map(v => `<option value="${v}" ${v === cs.len ? 'selected' : ''}>${v} s</option>`).join('')}</select></label>
          <div class="row"><button class="btn primary" data-act="ls-rec" ${ctx && !rec[ci] ? '' : 'disabled'}>Record ${cs.len} s</button><span id="ls-recProgress" class="mono"></span></div>
          <p class="note">${ctx ? `Or patch a trigger into <b>${c.name} · record</b> to capture on cue. Takes last until you reload the page.` : 'Start sound first, then record from any module.'}</p>
          ${tk.length ? `<div class="field"><span>Takes</span><div class="chips">${tk.map((t, i) => `<button class="chip ${i === cs.take ? 'on' : ''}" data-act="ls-take" data-i="${i}">${i + 1} · ${esc(t.label)}</button>`).join('')}</div><canvas class="wave" id="ls-wave"></canvas></div>` : ''}
          <label class="field"><span>Or load a sound file</span><input type="file" id="ls-file" accept="audio/*" ${ctx ? '' : 'disabled'}></label>
          <label class="field"><span>Scale root</span><select id="ls-root">${NOTE_NAMES.map((nm, i) => `<option value="${i}" ${i === st().root ? 'selected' : ''}>${nm}</option>`).join('')}</select></label>
          <label class="field"><span>Volume</span><input type="range" id="ls-vol" min="0" max="1" step="0.01" value="${cs.vol}"></label>
          <button class="btn ghost danger" data-act="ls-clear" data-confirm="Tap again to clear ${c.name.toLowerCase()}">Clear ${c.name.toLowerCase()} lines</button>
        </fieldset>${host.portsBox(c.id + '.')}`;
      drawWave();
    }

    return {
      ports() {
        const o = [];
        for (const c of COLOURS) {
          const n = c.name;
          o.push({ id: c.id + '.start', label: n + ' · start', dir: 'in', type: 'trigger' },
                 { id: c.id + '.rec', label: n + ' · record', dir: 'in', type: 'trigger' },
                 { id: c.id + '.end', label: n + ' · end', dir: 'out', type: 'trigger' },
                 { id: c.id + '.cross', label: n + ' · crossing', dir: 'out', type: 'trigger' },
                 { id: c.id + '.note', label: n + ' · note', dir: 'out', type: 'note' },
                 { id: c.id + '.mod', label: n + ' · mod', dir: 'out', type: 'control' });
        }
        return o;
      },
      audioSources() { return COLOURS.map(c => ({ id: c.id, label: c.name + ' lines' })); },
      getBus(sub) { const i = COLOURS.findIndex(c => c.id === sub); return i < 0 || !cbus ? null : cbus[i]; },
      audioInit() {
        const ctx = host.ctx;
        cbus = COLOURS.map((c, i) => { const g = ctx.createGain(); g.gain.value = st().colours[i].vol; g.connect(host.output); return g; });
        const wave = fn => { const N = 24, re = new Float32Array(N), im = new Float32Array(N); for (let n = 1; n < N; n++) im[n] = fn(n); return ctx.createPeriodicWave(re, im); };
        waves = [wave(n => 1 / n), wave(n => (n % 2 ? 1 / n : 0)), wave(n => ({ 1: 1, 2: 0.5, 4: 0.18 })[n] || 0), wave(n => [0, 1, 0.15, 0.5, 0.05, 0.35, 0, 0.2][n] || 0), wave(n => (n % 2 ? 1 : 0.45) / Math.pow(n, 0.7))];
      },
      schedule(n, until) {
        const lines = st().lines;
        for (const L of lines) {
          const r = rt[L.id]; if (!r) continue; const trig = trigMode(L.c);
          if (!trig && !r.plays.some(p => p.free && !p.dead && p.start + p.dur > n)) startPlay(L, n + 0.05, true);
          for (const p of r.plays.slice()) {
            if (p.dead) continue;
            while (p.ci < r.cross.length) { const x = r.cross[p.ci], tt = p.start + x.t * p.dur; if (tt >= until) break; p.ci++; if (tt >= n - 0.05) crossEvent(L, x, tt, p); }
            const end = p.start + p.dur;
            if (!p.endDone && end < until) {
              p.endDone = true;
              host.emit(COLOURS[L.c].id + '.end', { kind: 'trigger', time: Math.max(end, n), vel: 0.8 });
              if (p.free && !trig) startPlay(L, end < n - 1 ? n + 0.05 : end, true);
            }
          }
          r.plays = r.plays.filter(p => p.start + p.dur > n - 0.4);
        }
        COLOURS.forEach((c, ci) => {
          if (!host.isOutPatched(c.id + '.mod')) return;
          let best = null;
          for (const L of lines) { if (L.c !== ci || !rt[L.id]) continue; for (const p of rt[L.id].plays) if (!p.dead && p.start <= n && n < p.start + p.dur && (!best || p.start > best.p.start)) best = { L, p }; }
          if (best) host.emit(c.id + '.mod', { kind: 'control', time: n, value: 1 - posAt(best.L, (n - best.p.start) / best.p.dur)[1] / H0 });
        });
      },
      input(port, msg) {
        const [cid, p] = port.split('.'), ci = COLOURS.findIndex(c => c.id === cid); if (ci < 0) return;
        const t = Math.max(msg.time, host.now());
        if (p === 'start') { for (const L of st().lines) if (L.c === ci) startPlay(L, t, false); }
        else if (p === 'rec') capture(ci, t);
      },
      sourceRenamed(from, to) { for (const cs of st().colours) if (cs.from === from) cs.from = to; host.save(); },
      themeChanged() { layersDirty = true; },
      mount(stage, pnl) {
        panel = pnl;
        cv = host.makeCanvas(stage, () => { layersDirty = true; });
        hint = document.createElement('p'); hint.className = 'hint'; stage.appendChild(hint);
        const css = document.createElement('style');
        css.textContent = `.ls-inks{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px}
          .ls-ink{display:flex;flex-direction:column;align-items:center;gap:4px;border:1.5px solid transparent;background:none;border-radius:8px;padding:6px 2px;cursor:pointer;font-size:.78rem;font-weight:700;color:var(--muted)}
          .ls-ink span{width:26px;height:26px;border-radius:50%;background:var(--ink-c);mix-blend-mode:var(--blend)}
          .ls-ink.on{border-color:var(--ink);color:var(--ink)}
          .ls-ink i{font:normal 10px var(--font-mono);color:var(--pink)}`;
        stage.appendChild(css);
        recompute();

        cv.addEventListener('pointerdown', e => {
          const [x, y] = toWorld(e); if (x < 0 || y < 0 || x > W0 || y > H0) return;
          if (tool === 'erase') { eraseAt(x, y); return; }
          cv.setPointerCapture(e.pointerId); cur = { c: sel(), pts: [[r1(x), r1(y), 6]], lt: performance.now(), w: 6 };
        });
        cv.addEventListener('pointermove', e => {
          if (!cur) return; let [x, y] = toWorld(e); x = clamp(x, 0, W0); y = clamp(y, 0, H0);
          const last = cur.pts[cur.pts.length - 1], d = Math.hypot(x - last[0], y - last[1]); if (d < 5) return;
          const t = performance.now(), sp = d / Math.max(1, t - cur.lt); cur.lt = t;
          cur.w = cur.w * 0.6 + clamp(12 / (1 + sp * 2.5), 1.6, 11) * 0.4; cur.pts.push([r1(x), r1(y), r1(cur.w)]);
        });
        const end = () => {
          const c = cur; cur = null; if (!c || c.pts.length < 3) return;
          c.pts[0][2] = c.pts[1][2];
          st().lines.push({ id: st().nextId++, c: c.c, pts: c.pts }); recompute(); host.save(); render();
        };
        cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

        panel.addEventListener('click', e => {
          const b = e.target.closest('[data-act]'); if (!b || b.disabled) return; const s = st();
          switch (b.dataset.act) {
            case 'ls-tool': tool = b.dataset.tool; break;
            case 'ls-colour': s.sel = +b.dataset.i; host.save(); break;
            case 'ls-undo': { if (!s.lines.length) return; let mx = s.lines[0]; for (const l of s.lines) if (l.id > mx.id) mx = l; s.lines = s.lines.filter(l => l !== mx); recompute(); host.save(); break; }
            case 'ls-clear': if (!armed(b)) return; s.lines = s.lines.filter(l => l.c !== sel()); recompute(); host.save(); break;
            case 'ls-src': s.colours[sel()].source = b.dataset.v; host.save(); break;
            case 'ls-take': s.colours[sel()].take = +b.dataset.i; s.colours[sel()].source = 'sample'; host.save(); break;
            case 'ls-rec': capture(sel(), host.now() + 0.03); return;
            default: return;
          }
          render();
        });
        panel.addEventListener('input', e => {
          if (e.target.id !== 'ls-vol') return; const v = parseFloat(e.target.value);
          st().colours[sel()].vol = v; if (cbus) cbus[sel()].gain.setTargetAtTime(v, host.now(), 0.02); host.save();
        });
        panel.addEventListener('change', e => {
          const cs = st().colours[sel()];
          if (e.target.id === 'ls-from') cs.from = e.target.value;
          else if (e.target.id === 'ls-len') { cs.len = +e.target.value; render(); }
          else if (e.target.id === 'ls-root') st().root = +e.target.value;
          else if (e.target.id === 'ls-file') { loadFile(e.target.files && e.target.files[0]); return; }
          else return;
          host.save();
        });
        render();
      },
      draw(T) {
        const C = host.colours(), g = cv.getContext('2d'), W = cv.width, H = cv.height; if (!W || !H) return;
        const dpr = W / (cv.clientWidth || W);
        const s = Math.min(W / W0, H / H0), ox = (W - W0 * s) / 2, oy = (H - H0 * s) / 2;
        if (!view || view.s !== s || view.ox !== ox || view.oy !== oy) { view = { s, ox, oy }; layersDirty = true; }
        if (layersDirty) buildLayers(W, H);
        g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
        g.fillStyle = C.panel; g.fillRect(0, 0, W, H); g.fillStyle = C.paper; g.fillRect(ox, oy, W0 * s, H0 * s);
        g.fillStyle = C.rule; for (let x = 50; x < W0; x += 50) for (let y = 50; y < H0; y += 50) g.fillRect(ox + x * s - dpr, oy + y * s - dpr, 2 * dpr, 2 * dpr);
        g.globalCompositeOperation = C.blend === 'screen' ? 'screen' : 'multiply'; g.globalAlpha = 0.92;
        for (const l of layers) g.drawImage(l, 0, 0);
        g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
        if (cur) {
          g.strokeStyle = C[COLOURS[cur.c].id]; g.lineCap = 'round'; const p = cur.pts;
          for (let k = 1; k < p.length; k++) { g.lineWidth = Math.max(1, (p[k - 1][2] + p[k][2]) / 2 * s); g.beginPath(); g.moveTo(ox + p[k - 1][0] * s, oy + p[k - 1][1] * s); g.lineTo(ox + p[k][0] * s, oy + p[k][1] * s); g.stroke(); }
        }
        for (const L of st().lines) {
          const r = rt[L.id]; if (!r) continue; const col = C[COLOURS[L.c].id];
          for (const f of r.flashes) {
            const dt = T - f.time; if (dt < 0 || dt > 0.7) continue;
            g.globalAlpha = 1 - dt / 0.7; g.strokeStyle = C[COLOURS[f.oc].id]; g.lineWidth = 2.5 * dpr;
            g.beginPath(); g.arc(ox + f.x * s, oy + f.y * s, (8 + dt * 60) * s, 0, Math.PI * 2); g.stroke();
          }
          g.globalAlpha = 1; let any = false;
          for (const p of r.plays) {
            if (p.dead || T < p.start || T > p.start + p.dur) continue; any = true;
            const [x, y] = posAt(L, (T - p.start) / p.dur);
            g.fillStyle = C.ink; g.beginPath(); g.arc(ox + x * s, oy + y * s, 5 * dpr, 0, Math.PI * 2); g.fill();
            g.strokeStyle = col; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(ox + x * s, oy + y * s, 9 * dpr, 0, Math.PI * 2); g.stroke();
          }
          if (!any && trigMode(L.c)) { g.strokeStyle = C.ink; g.lineWidth = 1.5 * dpr; g.beginPath(); g.arc(ox + L.pts[0][0] * s, oy + L.pts[0][1] * s, 6 * dpr, 0, Math.PI * 2); g.stroke(); }
        }
        const el = panel.querySelector('#ls-recProgress'); if (el) { const r = rec[sel()]; el.textContent = r ? 'Recording ' + Math.round(r.progress * 100) + '%' : ''; }
      },
      render,
      reset() {
        for (const id in rt) for (const p of rt[id].plays) fade(p);
        rt = {}; takes = COLOURS.map(() => []);
        if (cbus) cbus.forEach((g, i) => { g.gain.value = st().colours[i].vol; });
        recompute();
      },
    };
  },
};

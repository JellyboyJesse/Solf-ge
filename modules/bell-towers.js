// Bell Towers — bells that swing at speeds set by their size.
// Each tower has its own ports: strike and swing-clock out; ring and size in.

const MATERIALS = {
  bronze: { label: 'Bronze', click: 0.25, p: [[0.5, 0.5, 4], [1, 1, 3], [1.183, 0.6, 2.2], [1.506, 0.4, 1.6], [2, 0.5, 1.4], [2.514, 0.25, 0.9], [3.011, 0.2, 0.7]] },
  iron:   { label: 'Iron',   click: 0.5,  p: [[0.5, 0.35, 2], [1, 1, 1.6], [1.21, 0.55, 1.1], [1.53, 0.5, 0.9], [2.03, 0.4, 0.7], [2.6, 0.3, 0.5], [3.2, 0.25, 0.35]] },
  glass:  { label: 'Glass',  click: 0.15, p: [[1, 1, 1.8], [2.32, 0.5, 1], [4.25, 0.3, 0.6], [6.63, 0.15, 0.35]] },
  wood:   { label: 'Wood',   click: 1.1,  p: [[1, 1, 0.25], [2.76, 0.45, 0.12], [5.4, 0.2, 0.06]] },
};

export default {
  id: 'bell-towers',
  name: 'Bell Towers',
  short: 'Bells',
  version: 1,
  kind: 'instrument',
  description: 'Bells swinging at speeds set by their size. Every strike and swing can drive other modules.',

  defaults() {
    return {
      nextId: 4, sel: 't1',
      towers: [
        { id: 't0', size: 0.25, material: 'bronze', force: 0.7, vol: 0.8, swing: true },
        { id: 't1', size: 0.55, material: 'bronze', force: 0.8, vol: 0.85, swing: true },
        { id: 't2', size: 0.82, material: 'iron', force: 0.9, vol: 0.8, swing: true },
        { id: 't3', size: 0.14, material: 'glass', force: 0.6, vol: 0.7, swing: true },
      ],
    };
  },

  create(host) {
    const { clamp, noteName, hzToMidi, esc, armed, r1 } = host.util;
    let rt = {};          // runtime per tower: strike history, next strike time, audio bus
    let hit = [], map = null, off = null, cv = null, panel = null;
    const st = () => host.state;

    const tName = t => 'Tower ' + (parseInt(t.id.slice(1), 10) + 1);
    const curTower = () => st().towers.find(t => t.id === st().sel);
    function rtFor(t) {
      let r = rt[t.id];
      if (!r) r = rt[t.id] = { hist: [], next: 0, side: 1, mod: 0, free: 0 };
      if (host.ctx && host.output && !r.bus) { r.bus = host.ctx.createGain(); r.bus.gain.value = t.vol; r.bus.connect(host.output); }
      return r;
    }
    const eff = t => clamp(t.size + rtFor(t).mod, 0, 1);
    const period = t => 1.4 + eff(t) * 3.6;
    const freq = t => 880 * Math.pow(0.12, eff(t));
    const sizeText = t => noteName(hzToMidi(freq(t))) + ' · ' + period(t).toFixed(1) + ' s swing';

    function sound(t, time, vel) {
      const ctx = host.ctx; if (!ctx) return;
      const r = rtFor(t), e = eff(t), f0 = freq(t), mat = MATERIALS[t.material] || MATERIALS.bronze;
      const out = ctx.createGain(); out.gain.value = 0.09 * (0.4 + vel * 0.8); out.connect(r.bus);
      const L = 0.6 + e * 1.2;
      for (const [ratio, amp, dec] of mat.p) {
        const fr = f0 * ratio; if (fr > 15000) continue;
        const o = ctx.createOscillator(); o.frequency.value = fr;
        const g = ctx.createGain(), d = dec * L;
        g.gain.setValueAtTime(0.0001, time); g.gain.exponentialRampToValueAtTime(amp, time + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, time + d);
        o.connect(g); g.connect(out); o.start(time); o.stop(time + d + 0.05);
      }
      const nz = ctx.createBufferSource(); nz.buffer = host.noise();
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = Math.min(9000, f0 * 3); bp.Q.value = 2;
      const ng = ctx.createGain(); ng.gain.setValueAtTime(mat.click, time); ng.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      nz.connect(bp); bp.connect(ng); ng.connect(out); nz.start(time); nz.stop(time + 0.07);
    }
    function strike(t, time, free) {
      const r = rtFor(t);
      if (free) { r.side = -r.side; r.free++; }
      r.hist.push({ time, free, side: r.side }); if (r.hist.length > 10) r.hist.shift();
      sound(t, time, t.force);
      host.emit(t.id + '.strike', { kind: 'trigger', time, vel: t.force });
      if (free && r.free % 2 === 0) host.emit(t.id + '.clock', { kind: 'clock', time });
    }
    function angle(t, T) {
      const r = rtFor(t), A = 0.45 + t.force * 0.5; let a = 0;
      if (t.swing && host.ctx) {
        const fr = r.hist.filter(h => h.free);
        for (let k = fr.length - 1; k >= 0; k--) {
          if (fr[k].time <= T) {
            const s0 = fr[k], s1 = fr[k + 1] ? fr[k + 1].time : r.next;
            if (s1 > s0.time) a = s0.side * A * Math.cos(Math.PI * clamp((T - s0.time) / (s1 - s0.time), 0, 1));
            break;
          }
        }
      }
      for (const h of r.hist) if (!h.free) { const dt = T - h.time; if (dt >= 0 && dt < 1.2) a += 0.4 * Math.exp(-dt * 4) * Math.sin(dt * 26); }
      return a;
    }

    function drawTower(p, t, x, gy, T, C) {
      const e = eff(t), r = rtFor(t);
      const th = Math.round(20 + e * 24), tw = Math.round(9 + e * 5), left = x - Math.floor(tw / 2), top = gy - th;
      p.fillStyle = C.stone; p.fillRect(left, top, tw, th + 6); p.fillStyle = C['stone-hi']; p.fillRect(left, top, 2, th + 6);
      for (let k = 0; k <= Math.ceil(tw / 2) + 1; k++) { p.fillStyle = k % 3 === 0 ? C['stone-hi'] : C.stone; p.fillRect(left - 1 + k, top - 1 - k, Math.max(1, tw + 2 - 2 * k), 1); }
      const oh = Math.round(8 + e * 6), ow = tw - 4;
      p.globalAlpha = 0.85; p.fillStyle = C.ink; p.fillRect(left + 2, top + 2, ow, oh); p.globalAlpha = 1;
      const a = angle(t, T), len = oh - 3, bx = x + Math.round(Math.sin(a) * len * 0.7), by = top + 3 + Math.round(Math.cos(a) * len * 0.9);
      const bw = Math.max(3, Math.round(3 + e * 4)), bh = Math.max(3, Math.round(len * 0.75));
      p.fillStyle = C.bell;
      for (let k = 0; k < bh; k++) { const w = Math.max(1, Math.round(bw * (0.45 + 0.55 * k / Math.max(1, bh - 1)))); p.fillRect(bx - Math.floor(w / 2), by - bh + k + 1, w, 1); }
      p.lineWidth = 1; p.strokeStyle = C.bell;
      for (const h of r.hist) { const dt = T - h.time; if (dt >= 0 && dt < 0.8) { p.globalAlpha = 1 - dt / 0.8; p.beginPath(); p.arc(x, top + 6, 6 + dt * 34, Math.PI * 1.08, Math.PI * 1.92); p.stroke(); } }
      p.globalAlpha = 1;
      if (!t.swing) { p.fillStyle = C.muted; p.fillRect(left + 2, gy + 1, tw - 4, 1); }
      if (t.id === st().sel) { p.fillStyle = C.pink; const ty = top - Math.ceil(tw / 2) - 6; p.fillRect(x - 2, ty, 5, 1); p.fillRect(x - 1, ty + 1, 3, 1); p.fillRect(x, ty + 2, 1, 1); }
    }

    function render() {
      if (!panel) return;
      const s = st(); let t = curTower() || s.towers[0]; if (t) s.sel = t.id;
      let h = `<div class="ph"><h2>Bell Towers</h2><p class="lede">Each bell swings at a speed set by its size, so the towers drift in and out of step. Every strike can fire other modules.</p></div>
        <div class="chips">${s.towers.map(x => `<button class="chip ${t && x.id === t.id ? 'on' : ''}" data-act="bt-sel" data-id="${x.id}">${tName(x)}</button>`).join('')}<button class="chip add" data-act="bt-add" ${s.towers.length >= 7 ? 'disabled' : ''}>+ Tower</button></div>`;
      if (t) {
        h += `<fieldset class="group"><legend>${tName(t)}</legend>
          <label class="field"><span>Bell size <output id="bt-sizeOut">${sizeText(t)}</output></span><input type="range" id="bt-size" min="0" max="1" step="0.01" value="${t.size}"></label>
          <label class="field"><span>Material</span><select id="bt-mat">${Object.entries(MATERIALS).map(([k, m]) => `<option value="${k}" ${k === t.material ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
          <label class="field"><span>Strike force <output id="bt-forceOut">${Math.round(t.force * 100)}%</output></span><input type="range" id="bt-force" min="0.1" max="1" step="0.01" value="${t.force}"></label>
          <label class="field"><span>Volume</span><input type="range" id="bt-vol" min="0" max="1" step="0.01" value="${t.vol}"></label>
          <label class="toggle"><input type="checkbox" id="bt-swing" ${t.swing ? 'checked' : ''}>Swings on its own</label>
          <p class="note">When off, the bell only rings when its <b>ring</b> input gets a trigger.</p>
          <button class="btn ghost danger" data-act="bt-rm" data-confirm="Tap again to remove">Remove ${esc(tName(t))}</button></fieldset>`;
        h += host.portsBox(t.id + '.');
      }
      panel.innerHTML = h;
    }

    return {
      ports() {
        const o = [];
        for (const t of st().towers) {
          const n = tName(t);
          o.push({ id: t.id + '.strike', label: n + ' · strike', dir: 'out', type: 'trigger' },
                 { id: t.id + '.clock', label: n + ' · swing clock', dir: 'out', type: 'clock' },
                 { id: t.id + '.ring', label: n + ' · ring', dir: 'in', type: 'trigger' },
                 { id: t.id + '.size', label: n + ' · size', dir: 'in', type: 'control' });
        }
        return o;
      },
      audioSources() { return st().towers.map(t => ({ id: t.id, label: tName(t) })); },
      getBus(sub) { const t = st().towers.find(x => x.id === sub); return t ? rtFor(t).bus : null; },
      audioInit() { for (const t of st().towers) rtFor(t); },
      schedule(n, until) {
        for (const t of st().towers) {
          const r = rtFor(t);
          if (!host.isPatched(t.id + '.size')) r.mod = 0;
          if (!t.swing) continue;
          if (r.next < n - 0.5) r.next = n + 0.05 + Math.random() * 0.3;
          while (r.next < until) { strike(t, Math.max(r.next, n), true); r.next += period(t) / 2; }
        }
      },
      input(port, msg) {
        const [tid, p] = port.split('.'); const t = st().towers.find(x => x.id === tid); if (!t) return;
        if (p === 'ring') strike(t, Math.max(msg.time, host.now()), false);
        else if (p === 'size') rtFor(t).mod = (msg.value - 0.5) * 0.7;
      },
      mount(stage, pnl) {
        panel = pnl;
        cv = host.makeCanvas(stage);
        const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Tap a tower to edit its bell'; stage.appendChild(hint);
        cv.addEventListener('pointerdown', e => {
          if (!map) return;
          const rc = cv.getBoundingClientRect(), dpr = cv.width / rc.width;
          const lx = ((e.clientX - rc.left) * dpr - map.ox) / map.s;
          let best = null, bd = 1e9; for (const h of hit) { const d = Math.abs(h.x - lx); if (d < bd) { bd = d; best = h; } }
          if (best && bd < 16) { st().sel = best.id; host.save(); render(); }
        });
        panel.addEventListener('click', e => {
          const b = e.target.closest('[data-act]'); if (!b || b.disabled) return; const s = st();
          if (b.dataset.act === 'bt-sel') { s.sel = b.dataset.id; host.save(); render(); }
          else if (b.dataset.act === 'bt-add') {
            const id = 't' + s.nextId++;
            s.towers.push({ id, size: r1(0.1 + Math.random() * 0.8), material: ['bronze', 'iron', 'glass', 'wood'][Math.floor(Math.random() * 4)], force: 0.7, vol: 0.8, swing: true });
            s.sel = id; host.save(); host.portsChanged();
          } else if (b.dataset.act === 'bt-rm') {
            if (!armed(b)) return; const t = curTower(); if (!t) return;
            const r = rt[t.id]; if (r && r.bus) { try { r.bus.disconnect(); } catch (err) { /* gone */ } } delete rt[t.id];
            s.towers = s.towers.filter(x => x !== t); s.sel = (s.towers[0] || {}).id;
            host.renameSource(t.id, null); host.removeCables(t.id + '.'); host.save();
          }
        });
        panel.addEventListener('input', e => {
          const t = curTower(); if (!t) return; const v = parseFloat(e.target.value);
          if (e.target.id === 'bt-size') { t.size = v; panel.querySelector('#bt-sizeOut').textContent = sizeText(t); }
          else if (e.target.id === 'bt-force') { t.force = v; panel.querySelector('#bt-forceOut').textContent = Math.round(v * 100) + '%'; }
          else if (e.target.id === 'bt-vol') { t.vol = v; const r = rt[t.id]; if (r && r.bus) r.bus.gain.setTargetAtTime(v, host.now(), 0.02); }
          else return;
          host.save();
        });
        panel.addEventListener('change', e => {
          const t = curTower(); if (!t) return;
          if (e.target.id === 'bt-mat') t.material = e.target.value;
          else if (e.target.id === 'bt-swing') { t.swing = e.target.checked; if (rt[t.id]) rt[t.id].next = 0; }
          else return;
          host.save();
        });
        render();
      },
      draw(T) {
        const C = host.colours(), g = cv.getContext('2d'), W = cv.width, H = cv.height; if (!W || !H) return;
        const lh = 108, lw = clamp(Math.round(lh * W / H), 120, 320);
        if (!off) off = document.createElement('canvas');
        if (off.width !== lw || off.height !== lh) { off.width = lw; off.height = lh; }
        const p = off.getContext('2d');
        p.fillStyle = C.sky; p.fillRect(0, 0, lw, lh);
        p.fillStyle = C['hill-a']; for (let x = 0; x < lw; x++) { const y = Math.round(56 + 9 * Math.sin(x * 0.045 + 1) + 4 * Math.sin(x * 0.13)); p.fillRect(x, y, 1, lh - y); }
        const ground = x => Math.round(82 + 5 * Math.sin(x * 0.03 + 2) + 2 * Math.sin(x * 0.11));
        p.fillStyle = C['hill-b']; for (let x = 0; x < lw; x++) { const y = ground(x); p.fillRect(x, y, 1, lh - y); }
        const towers = st().towers, n = towers.length; hit = [];
        towers.forEach((t, i) => { const x = Math.round(lw * (i + 1) / (n + 1)); hit.push({ id: t.id, x }); drawTower(p, t, x, ground(x), T, C); });
        const s = Math.max(W / lw, H / lh); map = { s, ox: (W - lw * s) / 2, oy: (H - lh * s) / 2 };
        g.imageSmoothingEnabled = false; g.fillStyle = C.sky; g.fillRect(0, 0, W, H); g.drawImage(off, 0, 0, lw, lh, map.ox, map.oy, lw * s, lh * s);
      },
      render,
      reset() { for (const id in rt) { const r = rt[id]; if (r.bus) { try { r.bus.disconnect(); } catch (e) { /* gone */ } } } rt = {}; },
    };
  },
};

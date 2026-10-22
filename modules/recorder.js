// Recorder — records everything you hear to a WAV file.
// Start and stop by hand, or patch triggers into start and stop so a patch can record itself.

const MAX_SECONDS = 300;

function encodeWav(left, right, frames, sr) {
  const bytes = frames * 4, buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, bytes, true);
  let o = 44;
  for (let c = 0; c < left.length; c++) {
    const L = left[c], R = right[c];
    for (let i = 0; i < L.length; i++) { v.setInt16(o, L[i], true); v.setInt16(o + 2, R[i], true); o += 4; }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
const toI16 = f32 => { const out = new Int16Array(f32.length); for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return out; };

export default {
  id: 'recorder',
  name: 'Recorder',
  short: 'Rec',
  version: 1,
  kind: 'utility',
  sound: false,
  description: 'Records everything you hear to a WAV file, by hand or when a trigger tells it to.',

  defaults() { return {}; },

  create(host) {
    const { esc } = host.util;
    let rec = null, takes = [], panel = null, ctl = null, clockEl = null, btn = null;

    function start() {
      const ctx = host.ctx;
      if (!ctx || !host.mainOut) { host.toast('Start sound first, then record.'); return; }
      if (rec) return;
      if (!ctx.createScriptProcessor) { host.toast('This browser cannot record here.'); return; }
      const sp = ctx.createScriptProcessor(4096, 2, 2), z = ctx.createGain(); z.gain.value = 0;
      host.mainOut.connect(sp); sp.connect(z); z.connect(ctx.destination);
      rec = { sp, z, L: [], R: [], frames: 0, sr: ctx.sampleRate, began: ctx.currentTime };
      sp.onaudioprocess = e => {
        if (!rec) return;
        rec.L.push(toI16(e.inputBuffer.getChannelData(0)));
        rec.R.push(toI16(e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : e.inputBuffer.getChannelData(0)));
        rec.frames += e.inputBuffer.length;
        if (rec.frames >= MAX_SECONDS * rec.sr) { stop(); host.toast(`The Recorder stops at ${MAX_SECONDS / 60} minutes. Your take is saved.`); }
      };
      render();
    }
    function stop() {
      if (!rec) return;
      const r = rec; rec = null;
      try { host.mainOut.disconnect(r.sp); } catch (e) { /* gone */ }
      r.sp.onaudioprocess = null; r.sp.disconnect(); r.z.disconnect();
      if (r.frames < r.sr * 0.2) { render(); return; }
      const blob = encodeWav(r.L, r.R, r.frames, r.sr);
      const d = new Date(), pad = n => String(n).padStart(2, '0');
      const name = `patchwork-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.wav`;
      takes.unshift({ url: URL.createObjectURL(blob), name, secs: r.frames / r.sr });
      while (takes.length > 3) URL.revokeObjectURL(takes.pop().url);
      render();
    }
    const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    function render() {
      if (!ctl) return;
      btn.textContent = rec ? 'Stop' : 'Record';
      btn.classList.toggle('primary', !rec);
      ctl.innerHTML = `
        ${takes.length ? `<ul class="takes">${takes.map(t => `<li><div class="row spread"><span class="mono">${esc(t.name)} · ${fmt(t.secs)}</span><a class="btn small" href="${t.url}" download="${esc(t.name)}">Save</a></div><audio controls preload="none" src="${t.url}"></audio></li>`).join('')}</ul>` : '<p class="note">Takes appear here. They are kept until you reload the page, so save the ones you want.</p>'}
        ${host.portsBox('')}`;
    }

    return {
      ports() {
        return [
          { id: 'start', label: 'start', dir: 'in', type: 'trigger' },
          { id: 'stop', label: 'stop', dir: 'in', type: 'trigger' },
        ];
      },
      input(port, msg) {
        const go = () => (port === 'start' ? start() : stop());
        const wait = (msg.time - host.now()) * 1000;
        if (wait > 5) setTimeout(go, wait); else go();
      },
      mount(stage, pnl) {
        panel = pnl;
        panel.innerHTML = `<div class="row spread"><span class="big rc-clock">0:00</span><button class="btn primary rc-btn">Record</button></div><div class="rc-ctl"></div>`;
        clockEl = panel.querySelector('.rc-clock'); btn = panel.querySelector('.rc-btn'); ctl = panel.querySelector('.rc-ctl');
        btn.addEventListener('click', () => (rec ? stop() : start()));
        render();
      },
      draw() {
        const s = rec ? rec.frames / rec.sr : 0;
        clockEl.textContent = fmt(s);
        clockEl.style.color = rec ? 'var(--pink)' : '';
      },
      render,
      destroy() { stop(); for (const t of takes) URL.revokeObjectURL(t.url); },
    };
  },
};

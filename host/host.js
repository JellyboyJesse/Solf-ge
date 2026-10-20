// Patchwork host.
// Loads the modules listed in modules/index.json, runs one shared audio engine and clock,
// and routes messages between module ports along the cables in the patch.
// The module contract is described in MODULES.md.

/* ---------- utilities handed to every module as host.util ---------- */
const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const util = {
  NOTE_NAMES,
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  mtof: m => 440 * Math.pow(2, (m - 69) / 12),
  hzToMidi: f => 69 + 12 * Math.log2(f / 440),
  noteName: m => { const r = Math.round(m); return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); },
  esc: s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  r1: v => Math.round(v * 10) / 10,
  // Two-tap confirmation for buttons with data-confirm="…". Returns true on the second tap.
  armed(b) {
    if (!b.dataset.confirm || b.dataset.armed === '1') return true;
    b.dataset.armed = '1'; b.dataset.orig = b.textContent; b.textContent = b.dataset.confirm;
    setTimeout(() => { if (b.isConnected && b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = b.dataset.orig; } }, 3500);
    return false;
  },
};
const { clamp, esc } = util;
const $ = s => document.querySelector(s);

/* ---------- state ---------- */
const LS = 'patchwork-v1';
const LS_LOCAL = 'patchwork-local-modules-v1';
const clone = o => JSON.parse(JSON.stringify(o));
function blankState() { return { v: 1, view: null, modules: {}, cables: [], mix: { master: 0.8, mods: {} }, patches: {} }; }
function loadSaved() { try { const j = JSON.parse(localStorage.getItem(LS)); if (j && j.v === 1) return j; } catch (e) { /* none saved */ } return null; }
let S = blankState();
let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { toast('This browser would not save the patch.'); } }, 400); }
function mixFor(id) { if (!S.mix.mods) S.mix.mods = {}; return S.mix.mods[id] || (S.mix.mods[id] = { vol: 0.8, mute: false }); }
function localModules() { try { return JSON.parse(localStorage.getItem(LS_LOCAL)) || []; } catch (e) { return []; } }
function setLocalModules(list) { try { localStorage.setItem(LS_LOCAL, JSON.stringify(list)); } catch (e) { toast('This browser would not store the module.'); } }

/* ---------- engine ---------- */
const E = { ctx: null, master: null, depth: 0, timer: null, noise: null };
const mods = [];          // registered modules: { id, def, inst, api, source, el, out }
const byId = {};
let repoIds = [];
let cur = null;
let C = {};
const now = () => (E.ctx ? E.ctx.currentTime : 0);
const isPatched = full => S.cables.some(c => c.to === full);
const isOutPatched = full => S.cables.some(c => c.from === full);
const cableEls = new WeakMap();

function emit(modId, port, msg) {
  if (msg.kind !== 'control') ledFlash(modId, msg.time);
  if (E.depth > 4) return;           // stops feedback loops that fire at the same instant
  E.depth++;
  try {
    const from = modId + '.' + port;
    for (const c of S.cables) {
      if (c.from !== from) continue;
      const i = c.to.indexOf('.');
      const m = byId[c.to.slice(0, i)];
      if (!m || !m.inst.input) continue;
      try { m.inst.input(c.to.slice(i + 1), Object.assign({}, msg)); } catch (e) { console.error(e); }
      if (msg.kind !== 'control') cableFlash(c, msg.time);
    }
  } finally { E.depth--; }
}
function later(time, fn) { setTimeout(fn, Math.max(0, (time - now()) * 1000)); }
function ledFlash(id, time) {
  const el = document.getElementById('led-' + id); if (!el) return;
  later(time || now(), () => { el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), 90); });
}
function cableFlash(c, time) {
  const el = cableEls.get(c); if (!el || $('#sheet').hidden) return;
  later(time || now(), () => { el.classList.add('flash'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('flash'), 120); });
}
function compatible(outT, inT) { if (inT === 'control') return outT === 'control'; if (inT === 'note') return outT === 'note'; return outT !== 'control'; }
function modPorts(m) { try { return m.inst.ports ? m.inst.ports() : []; } catch (e) { console.error(e); return []; } }
function allPorts(dir) { const res = []; for (const m of mods) for (const p of modPorts(m)) if (p.dir === dir) res.push({ ...p, full: m.id + '.' + p.id, mod: m.id }); return res; }
function findPort(full) { const i = full.indexOf('.'); const m = byId[full.slice(0, i)]; if (!m) return null; const p = modPorts(m).find(x => x.id === full.slice(i + 1)); return p ? { m, p } : null; }
function portLabel(full) { const f = findPort(full); return f ? (f.m.def.short || f.m.def.name) + ' · ' + f.p.label : full + ' (missing)'; }
function portType(full) { const f = findPort(full); return f ? f.p.type : 'trigger'; }
function allAudioSources() {
  const out = [];
  for (const m of mods) {
    out.push({ id: m.id, label: m.def.name + ' · all', module: m.id, moduleName: m.def.name });
    let parts = []; try { parts = m.inst.audioSources ? m.inst.audioSources() : []; } catch (e) { console.error(e); }
    for (const s of parts) out.push({ id: m.id + '.' + s.id, label: (m.def.short || m.def.name) + ' · ' + s.label, module: m.id, moduleName: m.def.name });
  }
  return out;
}
function getBus(id) {
  const i = id.indexOf('.'); const m = byId[i < 0 ? id : id.slice(0, i)];
  if (!m || !m.out) return null;
  if (i < 0) return m.out.tap;
  try { return m.inst.getBus ? m.inst.getBus(id.slice(i + 1)) : null; } catch (e) { return null; }
}
function noiseBuf() {
  if (!E.ctx) return null;
  if (!E.noise) { const n = Math.floor(E.ctx.sampleRate * 0.1); E.noise = E.ctx.createBuffer(1, n, E.ctx.sampleRate); const d = E.noise.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; }
  return E.noise;
}
function startModuleAudio(m) {
  if (m.out) return;
  const tap = E.ctx.createGain(), vol = E.ctx.createGain(); tap.connect(vol); vol.connect(E.master);
  const mx = mixFor(m.id); vol.gain.value = mx.mute ? 0 : mx.vol; m.out = { tap, vol };
  try { m.inst.audioInit && m.inst.audioInit(); } catch (e) { console.error(e); toast(m.def.name + ' could not start its sound.'); }
}
function applyMix() {
  if (!E.ctx) return; const t = now();
  E.master.gain.setTargetAtTime(S.mix.master, t, 0.02);
  for (const m of mods) if (m.out) { const mx = mixFor(m.id); m.out.vol.gain.setTargetAtTime(mx.mute ? 0 : mx.vol, t, 0.02); }
}

/* ---------- theme ---------- */
const TOKENS = ['paper', 'panel', 'ink', 'muted', 'rule', 'pink', 'blue', 'yellow', 'teal', 'orange', 'sky', 'hill-a', 'hill-b', 'stone', 'stone-hi', 'bell', 'blend'];
function readColours() {
  const cs = getComputedStyle(document.documentElement);
  const next = {}; for (const k of TOKENS) next[k] = cs.getPropertyValue('--' + k).trim();
  C = next;
  for (const m of mods) { try { m.inst.themeChanged && m.inst.themeChanged(); } catch (e) { console.error(e); } }
}

/* ---------- module API ---------- */
function makeCanvas(stage, onResize) {
  const cv = document.createElement('canvas'); stage.appendChild(cv);
  const ro = new ResizeObserver(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(stage.clientWidth * dpr), h = Math.round(stage.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; if (onResize) onResize(); }
  });
  ro.observe(stage);
  return cv;
}
function makeApi(m) {
  const id = m.id;
  return {
    id, util,
    get state() { return S.modules[id]; },
    save,
    now,
    get ctx() { return E.ctx; },
    get output() { return m.out ? m.out.tap : null; },
    get visible() { return cur === id; },
    emit: (port, msg) => emit(id, port, msg),
    isPatched: p => isPatched(id + '.' + p),
    isOutPatched: p => isOutPatched(id + '.' + p),
    removeCables(prefix) { const pre = id + '.' + prefix; S.cables = S.cables.filter(c => !c.from.startsWith(pre) && !c.to.startsWith(pre)); save(); refresh(); },
    renameSource(from, to) { for (const ms of mods) { try { ms.inst.sourceRenamed && ms.inst.sourceRenamed(id + '.' + from, to ? id + '.' + to : id); } catch (e) { console.error(e); } } },
    portsChanged: () => refresh(),
    portsBox: prefix => portsBox(id, prefix || ''),
    portLabel,
    audioSources: allAudioSources,
    getBus,
    noise: noiseBuf,
    colours: () => C,
    toast,
    makeCanvas,
    openPatch,
  };
}

/* ---------- loading modules ---------- */
function register(def, source) {
  if (!def || typeof def !== 'object') throw new Error('The file must `export default` a module object.');
  if (!def.id || !def.name || typeof def.create !== 'function') throw new Error('A module needs id, name and create().');
  if (!/^[a-z0-9-]+$/.test(def.id)) throw new Error('Module id must use only a–z, 0–9 and hyphens.');
  if (byId[def.id]) unregister(byId[def.id]);
  if (!S.modules[def.id]) S.modules[def.id] = def.defaults ? def.defaults() : {};
  const m = { id: def.id, def, source };
  m.api = makeApi(m);
  m.inst = def.create(m.api) || {};
  const view = document.createElement('section'); view.className = 'view'; view.id = 'view-' + def.id; view.hidden = true; view.setAttribute('aria-label', def.name);
  const stage = document.createElement('div'); stage.className = 'stage';
  const panel = document.createElement('aside'); panel.className = 'panel';
  view.append(stage, panel); $('#views').appendChild(view);
  m.el = { view, stage, panel };
  mods.push(m); byId[def.id] = m;
  try { m.inst.mount && m.inst.mount(stage, panel); } catch (e) { console.error(e); panel.innerHTML = `<p class="note">${esc(def.name)} failed to draw its page: ${esc(e.message)}</p>`; }
  if (E.ctx) startModuleAudio(m);
  return m;
}
function unregister(m) {
  try { m.inst.destroy && m.inst.destroy(); } catch (e) { console.error(e); }
  if (m.out) { try { m.out.vol.disconnect(); } catch (e) { /* already gone */ } }
  m.el.view.remove();
  mods.splice(mods.indexOf(m), 1); delete byId[m.id];
}
async function importSource(src) {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try { return (await import(url)).default; } finally { URL.revokeObjectURL(url); }
}
async function loadRepoModule(id) { const mod = await import(`../modules/${id}.js`); return register(mod.default, 'repo'); }

/* ---------- patches ---------- */
function snapshot() { return clone({ modules: S.modules, cables: S.cables, mix: S.mix }); }
function applyPatch(p) {
  S.modules = clone(p.modules || {});
  for (const m of mods) if (!S.modules[m.id]) S.modules[m.id] = m.def.defaults ? m.def.defaults() : {};
  S.cables = (p.cables || []).filter(c => c && c.from && c.to).map(c => ({ from: c.from, to: c.to }));
  if (p.mix) { S.mix = clone(p.mix); if (!S.mix.mods) S.mix.mods = {}; if (typeof S.mix.master !== 'number') S.mix.master = 0.8; }
  for (const m of mods) { try { m.inst.reset && m.inst.reset(); } catch (e) { console.error(e); } }
  applyMix(); $('#masterVol').value = S.mix.master; save(); refresh();
}
async function defaultPatch() {
  try { const r = await fetch('patches/default.json', { cache: 'no-cache' }); if (r.ok) return await r.json(); } catch (e) { /* no default */ }
  return { cables: [] };
}

/* ---------- UI: chrome, ports box, patch sheet ---------- */
function renderChrome() {
  $('#tabs').innerHTML = mods.map(m => `<a href="#${m.id}" data-view="${m.id}" class="${m.source === 'local' ? 'local' : ''}">${esc(m.def.name)}</a>`).join('');
  $('#leds').innerHTML = mods.map(m => `<span><i class="led" id="led-${m.id}"></i>${esc(m.def.short || m.def.name)}</span>`).join('');
}
function portsBox(id, prefix) {
  const m = byId[id]; if (!m) return '';
  const rows = modPorts(m).filter(p => p.id.startsWith(prefix)).map(p => {
    const full = id + '.' + p.id;
    const cs = S.cables.filter(c => (p.dir === 'out' ? c.from === full : c.to === full));
    const names = cs.map(c => esc(portLabel(p.dir === 'out' ? c.to : c.from))).join(', ');
    return `<li><span class="pt t-${p.type}">${p.dir} · ${p.type}</span><span class="pn">${esc(p.label)}</span><span class="pc">${cs.length ? (p.dir === 'out' ? '→ ' : '← ') + names : 'not patched'}</span></li>`;
  }).join('');
  return `<section class="ports"><div class="ports-h"><h3>Ports</h3><button class="btn small" data-act="open-patch">Edit patch</button></div><ul>${rows || '<li class="note">This module has no ports.</li>'}</ul></section>`;
}
function optGroups(list) {
  return mods.map(m => { const l = list.filter(p => p.mod === m.id); return l.length ? `<optgroup label="${esc(m.def.name)}">${l.map(p => `<option value="${p.full}">${esc(p.label)} (${p.type})</option>`).join('')}</optgroup>` : ''; }).join('');
}
function fillTo() {
  const from = $('#p-from').value; const ft = portType(from);
  const ins = allPorts('in').filter(p => compatible(ft, p.type) && !S.cables.some(c => c.from === from && c.to === p.full));
  $('#p-to').innerHTML = optGroups(ins); $('#p-connect').disabled = !from || !ins.length;
}
function renderSheet() {
  const prev = $('#p-from').value; const outs = allPorts('out');
  $('#p-from').innerHTML = optGroups(outs); if (prev && outs.some(p => p.full === prev)) $('#p-from').value = prev; fillTo();
  const ul = $('#p-list'); ul.innerHTML = '';
  if (!S.cables.length) ul.innerHTML = '<p class="empty">No cables yet. Each module still plays on its own.</p>';
  S.cables.forEach((c, i) => {
    const li = document.createElement('li'); const ty = portType(c.from); li.className = 't-' + ty;
    li.innerHTML = `<span class="cab">${esc(portLabel(c.from))} → ${esc(portLabel(c.to))}<small>${ty}</small></span><button data-act="rm-cable" data-i="${i}" aria-label="Remove cable">×</button>`;
    ul.appendChild(li); cableEls.set(c, li);
  });
  $('#p-mix').innerHTML = mods.map(m => { const mx = mixFor(m.id); return `<span>${esc(m.def.name)}</span><input type="range" data-mixvol="${m.id}" min="0" max="1" step="0.01" value="${mx.vol}" aria-label="${esc(m.def.name)} volume"><button class="chip ${mx.mute ? 'on' : ''}" data-act="mute" data-mod="${m.id}">${mx.mute ? 'Muted' : 'Mute'}</button>`; }).join('');
  const names = Object.keys(S.patches || {});
  $('#patchList').innerHTML = names.length ? names.map(n => `<li><span class="grow">${esc(n)}<small>${S.patches[n].cables.length} cables</small></span><button class="btn small" data-act="load-patch" data-name="${esc(n)}" data-confirm="Tap again">Load</button><button class="btn small ghost" data-act="del-patch" data-name="${esc(n)}" data-confirm="Delete?">×</button></li>`).join('') : '<p class="empty">Saved patches appear here.</p>';
  $('#modList').innerHTML = mods.map(m => `<li><span class="grow">${esc(m.def.name)}<small>${m.id}.js · v${esc(m.def.version || 1)} · ${m.source === 'local' ? 'this browser only' : 'from the repo'}</small></span>${m.source === 'local' ? `<button class="btn small ghost" data-act="rm-local" data-id="${m.id}" data-confirm="Remove?">Remove</button>` : ''}</li>`).join('');
}
function refresh() {
  for (const m of mods) { try { m.inst.render && m.inst.render(); } catch (e) { console.error(e); } }
  $('#patchBtn').textContent = 'Patch · ' + S.cables.length + ' cable' + (S.cables.length === 1 ? '' : 's');
  if (!$('#sheet').hidden) renderSheet();
}
function openPatch() { $('#sheet').hidden = false; renderSheet(); }

/* ---------- routing, drawing, scheduling ---------- */
function route() {
  let v = location.hash.slice(1);
  if (!byId[v]) v = byId[S.view] ? S.view : (mods[0] && mods[0].id);
  cur = v; S.view = v; save();
  for (const m of mods) m.el.view.hidden = m.id !== v;
  document.querySelectorAll('#tabs a').forEach(a => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
function frame() {
  const m = byId[cur];
  if (m && m.inst.draw) { try { m.inst.draw(now()); } catch (e) { console.error(e); } }
  requestAnimationFrame(frame);
}
function tick() {
  if (!E.ctx || E.ctx.state !== 'running') return;
  const n = E.ctx.currentTime, until = n + (document.hidden ? 1.2 : 0.12);
  for (const m of mods) if (m.inst.schedule) { try { m.inst.schedule(n, until); } catch (e) { console.error(e); } }
}
let wake = null;
async function keepAwake() { try { if (navigator.wakeLock && !document.hidden) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed */ } }
async function startSound() {
  const btn = $('#startBtn');
  if (E.ctx) {
    if (E.ctx.state === 'running') { await E.ctx.suspend(); btn.textContent = 'Resume'; }
    else { await E.ctx.resume(); btn.textContent = 'Pause'; keepAwake(); }
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { toast('This browser has no Web Audio support.'); return; }
  E.ctx = new AC({ latencyHint: 'interactive' });
  const comp = E.ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.connect(E.ctx.destination);
  E.master = E.ctx.createGain(); E.master.gain.value = S.mix.master; E.master.connect(comp);
  for (const m of mods) startModuleAudio(m);
  if (E.ctx.state !== 'running') await E.ctx.resume();
  E.timer = setInterval(tick, 25); tick();
  btn.textContent = 'Pause'; btn.classList.remove('primary'); keepAwake(); refresh();
}

/* ---------- toast ---------- */
let toastT;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3400);
}

/* ---------- interactions ---------- */
function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const ACTIONS = {
  'open-patch'() { openPatch(); },
  'close-patch'() { $('#sheet').hidden = true; },
  'rm-cable'(b) { S.cables.splice(+b.dataset.i, 1); save(); refresh(); },
  'mute'(b) { const mx = mixFor(b.dataset.mod); mx.mute = !mx.mute; applyMix(); save(); renderSheet(); },
  'load-patch'(b) { if (!util.armed(b)) return; const p = S.patches[b.dataset.name]; if (p) { applyPatch(p); toast('Loaded ' + b.dataset.name); } },
  'del-patch'(b) { if (!util.armed(b)) return; delete S.patches[b.dataset.name]; save(); renderSheet(); },
  async 'rm-local'(b) {
    if (!util.armed(b)) return; const id = b.dataset.id;
    setLocalModules(localModules().filter(x => x.id !== id));
    if (byId[id]) unregister(byId[id]);
    if (repoIds.includes(id)) { try { await loadRepoModule(id); if (E.ctx) startModuleAudio(byId[id]); } catch (e) { console.error(e); } }
    renderChrome(); route(); refresh(); toast('Removed the local copy of ' + id);
  },
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const f = ACTIONS[b.dataset.act]; if (f) { e.preventDefault(); f(b, e); }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'masterVol') { S.mix.master = parseFloat(el.value); applyMix(); save(); }
  else if (el.dataset && el.dataset.mixvol) { mixFor(el.dataset.mixvol).vol = parseFloat(el.value); applyMix(); save(); }
});
$('#p-from').addEventListener('change', fillTo);
$('#p-connect').addEventListener('click', () => {
  const from = $('#p-from').value, to = $('#p-to').value; if (!from || !to) return;
  S.cables.push({ from, to }); save(); refresh();
});
$('#startBtn').addEventListener('click', startSound);
$('#p-reset').addEventListener('click', async e => {
  const b = e.currentTarget; if (!util.armed(b)) return; b.dataset.armed = ''; b.textContent = b.dataset.orig;
  const p = await defaultPatch(); applyPatch({ modules: {}, cables: p.cables || [], mix: p.mix }); toast('Example patch restored');
});
$('#patchSave').addEventListener('click', () => {
  const name = $('#patchName').value.trim() || ('Patch ' + (Object.keys(S.patches).length + 1));
  S.patches[name] = snapshot(); $('#patchName').value = ''; save(); renderSheet(); toast('Saved ' + name);
});
$('#patchExport').addEventListener('click', () => {
  download('patchwork-patch-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ patchwork: 1, ...snapshot() }, null, 1));
});
$('#patchImport').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const p = JSON.parse(await f.text()); if (!p || !Array.isArray(p.cables)) throw new Error('no cables'); applyPatch(p); toast('Loaded ' + f.name); }
  catch (err) { toast('That file is not a Patchwork patch.'); }
});
$('#modFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const src = await f.text(); const def = await importSource(src);
    const m = register(def, 'local');
    setLocalModules([...localModules().filter(x => x.id !== def.id), { id: def.id, source: src }]);
    renderChrome(); location.hash = m.id; route(); refresh(); toast('Added ' + def.name + ' to this browser');
  } catch (err) { console.error(err); toast('Could not load that module: ' + err.message); }
});
addEventListener('hashchange', route);
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) $('#sheet').hidden = true; });
document.addEventListener('visibilitychange', () => { if (!document.hidden && E.ctx && E.ctx.state === 'running') keepAwake(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColours);
new MutationObserver(readColours).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/* ---------- boot ---------- */
async function boot() {
  readColours();
  const saved = loadSaved();
  if (saved) { S = saved; if (!S.patches) S.patches = {}; if (!S.mix || !S.mix.mods) S.mix = { master: 0.8, mods: {} }; }
  const failed = [];
  try { const r = await fetch('modules/index.json', { cache: 'no-cache' }); repoIds = await r.json(); }
  catch (e) { toast('Could not read modules/index.json.'); }
  for (const id of repoIds) { try { await loadRepoModule(id); } catch (e) { console.error(e); failed.push(id); } }
  for (const lm of localModules()) { try { register(await importSource(lm.source), 'local'); } catch (e) { console.error(e); failed.push(lm.id + ' (local)'); } }
  if (!saved) { const p = await defaultPatch(); S.cables = (p.cables || []).map(c => ({ from: c.from, to: c.to })); }
  $('#loading').remove();
  $('#masterVol').value = S.mix.master;
  renderChrome(); route(); refresh(); requestAnimationFrame(frame);
  if (!mods.length) $('#views').innerHTML = '<p class="loading">No modules loaded. Check modules/index.json.</p>';
  if (failed.length) toast('Could not load: ' + failed.join(', '));
}
boot();

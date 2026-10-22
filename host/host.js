// Patchwork host.
// Loads the modules listed in modules/index.json, runs one shared audio engine and clock,
// and routes messages between module jacks along the cables in the patch.
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
const { esc } = util;
const $ = s => document.querySelector(s);
const TYPE_SHORT = { trigger: 'trig', clock: 'clock', note: 'note', control: 'ctrl' };

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
const modOf = full => full.slice(0, full.indexOf('.'));

function emit(modId, port, msg) {
  const from = modId + '.' + port;
  if (msg.kind !== 'control') { ledFlash(modId, msg.time); jackFlash(from, msg.time); }
  if (E.depth > 4) return;           // stops feedback loops that fire at the same instant
  E.depth++;
  try {
    for (const c of S.cables) {
      if (c.from !== from) continue;
      const m = byId[modOf(c.to)];
      if (!m || !m.inst.input) continue;
      try { m.inst.input(c.to.slice(m.id.length + 1), Object.assign({}, msg)); } catch (e) { console.error(e); }
      if (msg.kind !== 'control') { cableFlash(c, msg.time); jackFlash(c.to, msg.time); }
    }
  } finally { E.depth--; }
}
function later(time, fn) { setTimeout(fn, Math.max(0, (time - now()) * 1000)); }
function blink(el, cls, ms) { el.classList.add(cls); clearTimeout(el['_' + cls]); el['_' + cls] = setTimeout(() => el.classList.remove(cls), ms); }
function ledFlash(id, time) { const el = document.getElementById('led-' + id); if (el) later(time || now(), () => blink(el, 'on', 90)); }
function cableFlash(c, time) { const el = cableEls.get(c); if (el && !$('#sheet').hidden) later(time || now(), () => blink(el, 'flash', 120)); }
function jackFlash(full, time) {
  if (modOf(full) !== cur || document.hidden) return;
  later(time || now(), () => { document.querySelectorAll(`#view-${cur} .jack[data-jack="${full}"]`).forEach(el => blink(el, 'flash', 110)); });
}
function compatible(outT, inT) { if (inT === 'control') return outT === 'control'; if (inT === 'note') return outT === 'note'; return outT !== 'control'; }
function whyNot(outT, inT) {
  if (outT === 'control') return 'Control signals only go into control inputs.';
  if (inT === 'control') return 'Control inputs only take control signals.';
  return 'Note inputs only take notes.';
}
function modPorts(m) { try { return m.inst.ports ? m.inst.ports() : []; } catch (e) { console.error(e); return []; } }
function allPorts(dir) { const res = []; for (const m of mods) for (const p of modPorts(m)) if (p.dir === dir) res.push({ ...p, full: m.id + '.' + p.id, mod: m.id }); return res; }
function findPort(full) { const m = byId[modOf(full)]; if (!m) return null; const p = modPorts(m).find(x => x.id === full.slice(m.id.length + 1)); return p ? { m, p } : null; }
function portLabel(full) { const f = findPort(full); return f ? (f.m.def.short || f.m.def.name) + ' · ' + f.p.label : full + ' (missing)'; }
function portType(full) { const f = findPort(full); return f ? f.p.type : 'trigger'; }
function shortLabel(label) { const i = label.lastIndexOf(' · '); return i < 0 ? label : label.slice(i + 3); }
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

/* ---------- jacks: picking up and plugging in cables ----------
   Tap a jack to pick up a cable from it. While a cable is held, every jack it can
   plug into lights up on every page, the tray lists them, and module tabs show how
   many each page has. Tap a lit jack to connect, a linked one to unplug. */
let held = null;   // { full, dir, type }

const linksOf = (full, dir) => S.cables.filter(c => (dir === 'out' ? c.from === full : c.to === full));
function endsWith(full) { return held.dir === 'out' ? [held.full, full] : [full, held.full]; }
function relation(full, p) {           // how a jack relates to the held cable
  if (!held) return '';
  if (held.full === full) return 'held';
  if (p.dir === held.dir) return 'same';
  const [from, to] = endsWith(full);
  if (S.cables.some(c => c.from === from && c.to === to)) return 'linked';
  return compatible(portType(from), portType(to)) ? 'ok' : 'no';
}
function jackClass(full, p) {
  const r = relation(full, p);
  return 'jack t-' + p.type + (linksOf(full, p.dir).length ? ' patched' : '') + (r ? ' ' + r : '');
}
function jackHTML(full, p) {
  const links = linksOf(full, p.dir), n = links.length;
  const peers = links.map(c => portLabel(p.dir === 'out' ? c.to : c.from));
  const desc = `${portLabel(full)}, ${p.type} ${p.dir === 'out' ? 'output' : 'input'}, ${n ? 'patched to ' + peers.join(', ') : 'not patched'}`;
  return `<button class="${jackClass(full, p)}" data-jack="${esc(full)}" aria-label="${esc(desc)}" title="${esc(desc)}">` +
    `<span class="socket"><b class="n">${n > 1 ? n : ''}</b></span><span class="jl">${esc(shortLabel(p.label))}</span><span class="jt">${TYPE_SHORT[p.type] || p.type}</span></button>`;
}
function faceplate(id, ports) {
  const row = (dir, name) => {
    const l = ports.filter(p => p.dir === dir);
    return l.length ? `<div class="jrow"><span class="jside">${name}</span><div class="jgrid">${l.map(p => jackHTML(id + '.' + p.id, p)).join('')}</div></div>` : '';
  };
  return `<div class="plate">${row('in', 'In')}${row('out', 'Out')}</div>`;
}
const helpText = () => (held ? 'Tap a lit jack to plug in, a crossed one to unplug, or the raised one to let go.' : 'Tap a jack to patch it.');
function portsBox(id, prefix) {
  const m = byId[id]; if (!m) return '';
  const ports = modPorts(m).filter(p => p.id.startsWith(prefix || ''));
  return `<section class="jacks"><div class="jacks-h"><h3>Jacks</h3><button class="btn small ghost" data-act="open-patch">All cables</button></div>` +
    (ports.length ? faceplate(id, ports) : '<p class="note">This module has no jacks.</p>') + `<p class="jhelp">${helpText()}</p></section>`;
}

function countTargets(modId) {
  if (!held) return 0; let n = 0;
  const m = byId[modId]; if (!m) return 0;
  for (const p of modPorts(m)) if (relation(modId + '.' + p.id, p) === 'ok') n++;
  return n;
}
function paintJacks() {
  document.querySelectorAll('.jack[data-jack]').forEach(el => {
    const f = findPort(el.dataset.jack); if (f) el.className = jackClass(el.dataset.jack, f.p);
  });
  document.querySelectorAll('.jhelp').forEach(el => { el.textContent = helpText(); });
  document.body.classList.toggle('holding', !!held);
  paintTabs(); renderTray();
}
function paintTabs() {
  document.querySelectorAll('#tabs a').forEach(a => {
    let b = a.querySelector('.tab-n'); const n = countTargets(a.dataset.view);
    if (n) { if (!b) { b = document.createElement('span'); b.className = 'tab-n'; a.appendChild(b); } b.textContent = n; b.title = n + ' jacks to plug into'; }
    else if (b) b.remove();
  });
}
function renderTray() {
  const tray = $('#tray');
  if (!held) { tray.hidden = true; return; }
  const f = findPort(held.full); if (!f) { held = null; tray.hidden = true; return; }
  tray.hidden = false;
  $('#trayHeld').innerHTML = `<span class="jack held t-${held.type}" aria-hidden="true"><span class="socket"></span></span><span>${esc(portLabel(held.full))}</span>`;
  $('#trayMsg').textContent = held.dir === 'out' ? 'Where should it go? Tap a lit jack on any page, or pick one here.' : 'Where should it come from? Tap a lit jack on any page, or pick one here.';
  const opp = allPorts(held.dir === 'out' ? 'in' : 'out').filter(p => p.full !== held.full);
  const chip = (p, cls, label) => `<button class="tchip t-${p.type} ${cls}" data-jack="${esc(p.full)}" title="${cls === 'linked' ? 'Unplug' : 'Plug in'}">${esc(label)}</button>`;
  const linked = opp.filter(p => relation(p.full, p) === 'linked');
  let html = linked.length ? `<div class="tg"><span class="tg-name">Plugged in</span>${linked.map(p => chip(p, 'linked', portLabel(p.full))).join('')}</div>` : '';
  for (const m of mods) {
    const l = opp.filter(p => p.mod === m.id && relation(p.full, p) === 'ok');
    if (l.length) html += `<div class="tg"><span class="tg-name">${esc(m.def.name)}</span>${l.map(p => chip(p, 'ok', p.label)).join('')}</div>`;
  }
  $('#trayList').innerHTML = html || '<span class="note">Nothing on the rack can take this signal.</span>';
}
function hold(full) {
  const f = findPort(full); if (!f) return;
  held = { full, dir: f.p.dir, type: f.p.type };
  paintJacks();
}
function drop() { if (!held) return; held = null; paintJacks(); }
function connect(from, to) {
  const c = { from, to }; S.cables.push(c); save();
  held = null; refresh();
  toast('Connected ' + portLabel(from) + ' → ' + portLabel(to), {
    label: 'Undo', fn() { const k = S.cables.indexOf(c); if (k >= 0) { S.cables.splice(k, 1); save(); refresh(); } },
  });
}
function unplug(i, keepHolding) {
  const c = S.cables.splice(i, 1)[0]; if (!c) return; save();
  if (!keepHolding) held = null;
  refresh();
  toast('Unplugged ' + portLabel(c.from) + ' → ' + portLabel(c.to), {
    label: 'Undo', fn() { if (!S.cables.some(x => x.from === c.from && x.to === c.to)) { S.cables.splice(Math.min(i, S.cables.length), 0, c); save(); refresh(); } },
  });
}
function pick(full) {
  const f = findPort(full);
  if (!f) { toast('That jack belongs to a module that is not loaded.'); return; }
  if (!held) { hold(full); return; }
  if (held.full === full) { drop(); return; }
  if (f.p.dir === held.dir) { hold(full); return; }          // changed your mind: pick up this one instead
  const [from, to] = endsWith(full);
  const i = S.cables.findIndex(c => c.from === from && c.to === to);
  if (i >= 0) { unplug(i, true); return; }
  if (!compatible(portType(from), portType(to))) { toast(whyNot(portType(from), portType(to))); return; }
  connect(from, to);
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
  held = null;
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

/* ---------- chrome and the patch sheet ---------- */
let sheetTab = 'cables';
let dirMod = null;
function renderChrome() {
  $('#tabs').innerHTML = mods.map(m => `<a href="#${m.id}" data-view="${m.id}" class="${m.source === 'local' ? 'local' : ''}">${esc(m.def.name)}</a>`).join('');
  $('#leds').innerHTML = mods.map(m => `<span><i class="led" id="led-${m.id}"></i>${esc(m.def.short || m.def.name)}</span>`).join('');
}
function parts(m) {               // group a module's ports by the part before the last dot: t1., pink., …
  const out = [];
  for (const p of modPorts(m)) {
    const pre = p.id.includes('.') ? p.id.slice(0, p.id.lastIndexOf('.') + 1) : '';
    let g = out.find(x => x.pre === pre);
    if (!g) { const i = p.label.lastIndexOf(' · '); out.push(g = { pre, name: pre && i > 0 ? p.label.slice(0, i) : m.def.name, ports: [] }); }
    g.ports.push(p);
  }
  return out;
}
function renderCables() {
  const n = S.cables.length;
  $('#cableCount').textContent = n ? n + ' cable' + (n === 1 ? '' : 's') : 'Cables';
  const list = $('#p-list');
  if (!n) { list.innerHTML = '<p class="empty">No cables yet. Each module still plays on its own. Tap any jack to start one.</p>'; return; }
  const groups = [];
  S.cables.forEach((c, i) => {
    const mid = modOf(c.from); let g = groups.find(x => x.mid === mid);
    if (!g) groups.push(g = { mid, name: byId[mid] ? byId[mid].def.name : mid + ' (not loaded)', rows: [] });
    g.rows.push({ c, i });
  });
  list.innerHTML = '';
  for (const g of groups) {
    const h = document.createElement('h4'); h.className = 'cgroup'; h.textContent = 'From ' + g.name; list.appendChild(h);
    const ul = document.createElement('ul'); ul.className = 'cables';
    for (const { c, i } of g.rows) {
      const li = document.createElement('li'); const f = findPort(c.from);
      li.className = 't-' + portType(c.from);
      li.innerHTML = `<button class="cab" data-jack="${esc(c.from)}" title="Pick up this jack">${esc(f ? f.p.label : portLabel(c.from))}</button><span class="arr" aria-hidden="true">→</span>` +
        `<button class="cab" data-jack="${esc(c.to)}" title="Pick up this jack">${esc(portLabel(c.to))}</button><button class="x" data-act="rm-cable" data-i="${i}" aria-label="Unplug ${esc(portLabel(c.from))} to ${esc(portLabel(c.to))}">×</button>`;
      ul.appendChild(li); cableEls.set(c, li);
    }
    list.appendChild(ul);
  }
}
function renderDirectory() {
  if (!byId[dirMod]) dirMod = byId[cur] ? cur : (mods[0] && mods[0].id);
  $('#dirMods').innerHTML = mods.map(m => `<button class="chip ${m.id === dirMod ? 'on' : ''}" data-act="dir-mod" data-id="${m.id}">${esc(m.def.name)}</button>`).join('');
  const m = byId[dirMod];
  $('#dirJacks').innerHTML = m ? parts(m).map(g => `<div class="part"><h4>${esc(g.name)}</h4>${faceplate(m.id, g.ports)}</div>`).join('') : '';
}
function renderSheet() {
  document.querySelectorAll('.sheet-tabs .seg').forEach(b => { const on = b.dataset.tab === sheetTab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  for (const t of ['cables', 'mix', 'patches', 'modules']) $('#tab-' + t).hidden = t !== sheetTab;
  if (sheetTab === 'cables') { renderCables(); renderDirectory(); }
  else if (sheetTab === 'mix') {
    $('#p-mix').innerHTML = mods.map(m => { const mx = mixFor(m.id); return `<span>${esc(m.def.name)}</span><input type="range" data-mixvol="${m.id}" min="0" max="1" step="0.01" value="${mx.vol}" aria-label="${esc(m.def.name)} volume"><button class="chip ${mx.mute ? 'on' : ''}" data-act="mute" data-mod="${m.id}">${mx.mute ? 'Muted' : 'Mute'}</button>`; }).join('');
  } else if (sheetTab === 'patches') {
    const names = Object.keys(S.patches || {});
    $('#patchList').innerHTML = names.length ? names.map(n => `<li><span class="grow">${esc(n)}<small>${S.patches[n].cables.length} cables</small></span><button class="btn small" data-act="load-patch" data-name="${esc(n)}" data-confirm="Tap again">Load</button><button class="btn small ghost" data-act="del-patch" data-name="${esc(n)}" data-confirm="Delete?" aria-label="Delete ${esc(n)}">×</button></li>`).join('') : '<p class="empty">Saved patches appear here.</p>';
  } else {
    $('#modList').innerHTML = mods.map(m => `<li><span class="grow">${esc(m.def.name)}<small>${m.id}.js · v${esc(m.def.version || 1)} · ${m.source === 'local' ? 'this browser only' : 'from the repo'}</small></span>${m.source === 'local' ? `<button class="btn small ghost" data-act="rm-local" data-id="${m.id}" data-confirm="Remove?">Remove</button>` : ''}</li>`).join('');
  }
}
function refresh() {
  if (held && !findPort(held.full)) held = null;
  for (const m of mods) { try { m.inst.render && m.inst.render(); } catch (e) { console.error(e); } }
  $('#patchBtn').textContent = 'Patch · ' + S.cables.length + ' cable' + (S.cables.length === 1 ? '' : 's');
  paintJacks();
  if (!$('#sheet').hidden) renderSheet();
}
function openPatch(tab) { if (typeof tab === 'string') sheetTab = tab; $('#sheet').hidden = false; renderSheet(); }
function closePatch() { $('#sheet').hidden = true; }

/* ---------- routing, drawing, scheduling ---------- */
function route() {
  let v = location.hash.slice(1);
  if (!byId[v]) v = byId[S.view] ? S.view : (mods[0] && mods[0].id);
  cur = v; S.view = v; save();
  for (const m of mods) m.el.view.hidden = m.id !== v;
  document.querySelectorAll('#tabs a').forEach(a => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (held) requestAnimationFrame(revealJacks);
}
// With a cable in hand, bring the page's jacks into view inside its panel.
function revealJacks() {
  const m = byId[cur]; if (!m) return;
  const panel = m.el.panel, box = panel.querySelector('.jacks'); if (!box) return;
  const pr = panel.getBoundingClientRect(), br = box.getBoundingClientRect();
  if (br.top >= pr.top && br.bottom <= pr.bottom) return;
  const top = panel.scrollTop + br.top - pr.top - 8;
  panel.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
async function keepAwake() { try { if (navigator.wakeLock && !document.hidden) await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed */ } }
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

/* ---------- toast, with an optional action such as Undo ---------- */
let toastT;
function toast(msg, action) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.innerHTML = ''; const s = document.createElement('span'); s.textContent = msg; t.appendChild(s);
  if (action) {
    const b = document.createElement('button'); b.textContent = action.label;
    b.addEventListener('click', () => { t.hidden = true; action.fn(); }); t.appendChild(b);
  }
  const anchor = $('#tray').hidden ? $('.patchbar') : $('#tray');
  t.style.bottom = Math.max(16, innerHeight - anchor.getBoundingClientRect().top + 10) + 'px';
  t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, action ? 5000 : 3400);
}

/* ---------- interactions ---------- */
function download(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const ACTIONS = {
  'open-patch'() { openPatch('cables'); },
  'close-patch'() { closePatch(); },
  'drop-cable'() { drop(); },
  'sheet-tab'(b) { sheetTab = b.dataset.tab; renderSheet(); },
  'dir-mod'(b) { dirMod = b.dataset.id; renderDirectory(); },
  'rm-cable'(b) { unplug(+b.dataset.i, false); },
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
  const j = e.target.closest('[data-jack]');
  if (j) {
    e.preventDefault();
    const fromSheet = !!j.closest('#sheet');
    if (fromSheet) closePatch();             // jacks in the sheet hand over to the tray
    pick(j.dataset.jack);
    if (fromSheet && held) requestAnimationFrame(revealJacks);
    return;
  }
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const f = ACTIONS[b.dataset.act]; if (f) { e.preventDefault(); f(b, e); }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'masterVol') { S.mix.master = parseFloat(el.value); applyMix(); save(); }
  else if (el.dataset && el.dataset.mixvol) { mixFor(el.dataset.mixvol).vol = parseFloat(el.value); applyMix(); save(); }
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
    renderChrome(); closePatch(); location.hash = m.id; route(); refresh(); toast('Added ' + def.name + ' to this browser');
  } catch (err) { console.error(err); toast('Could not load that module: ' + err.message); }
});
addEventListener('hashchange', route);
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#sheet').hidden) closePatch(); else if (held) drop();
});
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

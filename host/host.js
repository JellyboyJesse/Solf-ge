// Patchwork host.
// Reads the module catalogue (modules/index.json), builds the rack the person has chosen,
// runs one shared audio engine and clock, and routes messages between module jacks along
// the cables in the patch. The module contract is described in MODULES.md.

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
const RESERVED = new Set(['matrix', 'utilities', 'rack']);

/* ---------- state ---------- */
const LS = 'patchwork-v1';
const LS_LOCAL = 'patchwork-local-modules-v1';
const clone = o => JSON.parse(JSON.stringify(o));
function blankState() { return { v: 1, view: null, rack: null, modules: {}, cables: [], mix: { master: 0.8, mods: {} }, patches: {}, seen: null, ui: {} }; }
function loadSaved() { try { const j = JSON.parse(localStorage.getItem(LS)); if (j && j.v === 1) return j; } catch (e) { /* none saved */ } return null; }
let S = blankState();
let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { toast('This browser would not save the patch.'); } }, 400); }
function mixFor(id) { if (!S.mix.mods) S.mix.mods = {}; return S.mix.mods[id] || (S.mix.mods[id] = { vol: 0.8, mute: false }); }
function localModules() { try { return JSON.parse(localStorage.getItem(LS_LOCAL)) || []; } catch (e) { return []; } }
function setLocalModules(list) { try { localStorage.setItem(LS_LOCAL, JSON.stringify(list)); } catch (e) { toast('This browser would not store the module.'); } }
const ui = () => S.ui || (S.ui = {});

/* ---------- catalogue and rack ----------
   The catalogue is every module type that can be used (modules/index.json plus any tried from a file).
   The rack is the person's chosen instances, in order. An instance's id is its type id, or
   type-2, type-3… for extra copies of modules that allow several. */
const types = {};       // type id -> { def, source: 'repo' | 'local' }
let catalogue = [];     // type ids in catalogue order
const mods = [];        // rack instances in rack order: { id, type, def, kind, name, short, source, inst, api, el, out }
const byId = {};
const isUtility = m => m.kind === 'utility';
const kindOfType = t => (types[t] && types[t].def.kind === 'utility' ? 'utility' : 'instrument');
const viewOf = m => (isUtility(m) ? 'utilities' : m.id);

function checkDef(def) {
  if (!def || typeof def !== 'object') throw new Error('The file must `export default` a module object.');
  if (!def.id || !def.name || typeof def.create !== 'function') throw new Error('A module needs id, name and create().');
  if (!/^[a-z0-9-]+$/.test(def.id)) throw new Error('Module id must use only a–z, 0–9 and hyphens.');
  if (RESERVED.has(def.id)) throw new Error(`"${def.id}" is a reserved name.`);
}
function addType(def, source) { checkDef(def); types[def.id] = { def, source }; if (!catalogue.includes(def.id)) catalogue.push(def.id); }
const normRack = list => (list || []).map(e => (typeof e === 'string' ? { id: e, type: e } : { id: e.id, type: e.type || e.id })).filter(e => e.id && e.type);

/* ---------- engine ---------- */
const E = { ctx: null, master: null, out: null, depth: 0, timer: null, noise: null };
let repoIds = [];
let cur = null;
let C = {};
const now = () => (E.ctx ? E.ctx.currentTime : 0);
const isPatched = full => S.cables.some(c => c.to === full);
const isOutPatched = full => S.cables.some(c => c.from === full);
const cableEls = new WeakMap();
const modOf = full => full.slice(0, full.indexOf('.'));
const isVisible = m => !!m && cur === viewOf(m) && !document.hidden;

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
function ledFlash(id, time) { const m = byId[id]; const el = m && document.getElementById('led-' + viewOf(m)); if (el) later(time || now(), () => blink(el, 'on', 90)); }
function cableFlash(c, time) {
  if (cur === 'matrix' && !document.hidden) {
    later(time || now(), () => { const el = document.querySelector(`#mxWrap .hole[data-from="${c.from}"][data-to="${c.to}"]`); if (el) blink(el, 'flash', 130); });
  }
  const el = cableEls.get(c); if (el && !$('#sheet').hidden) later(time || now(), () => blink(el, 'flash', 120));
}
function jackFlash(full, time) {
  const m = byId[modOf(full)]; if (!isVisible(m)) return;
  later(time || now(), () => { m.el.root.querySelectorAll(`.jack[data-jack="${full}"]`).forEach(el => blink(el, 'flash', 110)); });
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
function portLabel(full) { const f = findPort(full); return f ? f.m.short + ' · ' + f.p.label : full + ' (missing)'; }
function portType(full) { const f = findPort(full); return f ? f.p.type : 'trigger'; }
function shortLabel(label) { const i = label.lastIndexOf(' · '); return i < 0 ? label : label.slice(i + 3); }
function allAudioSources() {
  const out = [];
  for (const m of mods) {
    if (m.def.sound === false) continue;
    out.push({ id: m.id, label: m.name + ' · all', module: m.id, moduleName: m.name });
    let parts = []; try { parts = m.inst.audioSources ? m.inst.audioSources() : []; } catch (e) { console.error(e); }
    for (const s of parts) out.push({ id: m.id + '.' + s.id, label: m.short + ' · ' + s.label, module: m.id, moduleName: m.name });
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
  try { m.inst.audioInit && m.inst.audioInit(); } catch (e) { console.error(e); toast(m.name + ' could not start its sound.'); }
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
  const head = isUtility(m) ? '' : `<div class="jacks-h"><h3>Jacks</h3><button class="btn small ghost" data-act="open-matrix">Matrix</button></div>`;
  return `<section class="jacks">${head}` + (ports.length ? faceplate(id, ports) : '<p class="note">This module has no jacks.</p>') +
    (isUtility(m) ? '' : `<p class="jhelp">${helpText()}</p>`) + '</section>';
}

function countTargets(view) {
  if (!held) return 0; let n = 0;
  for (const m of mods) if (viewOf(m) === view) for (const p of modPorts(m)) if (relation(m.id + '.' + p.id, p) === 'ok') n++;
  return n;
}
function paintJacks() {
  document.querySelectorAll('.jack[data-jack]').forEach(el => {
    const f = findPort(el.dataset.jack); if (f) el.className = jackClass(el.dataset.jack, f.p);
  });
  document.querySelectorAll('.jhelp').forEach(el => { el.textContent = helpText(); });
  document.body.classList.toggle('holding', !!held);
  paintTabs(); renderTray();
  if (cur === 'matrix') paintMatrixHeld();
}
function paintTabs() {
  document.querySelectorAll('.navrow a[data-view]').forEach(a => {
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
    if (l.length) html += `<div class="tg"><span class="tg-name">${esc(m.name)}</span>${l.map(p => chip(p, 'ok', p.label)).join('')}</div>`;
  }
  $('#trayList').innerHTML = html || '<span class="note">Nothing in the rack can take this signal.</span>';
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
  if (!f) { toast('That jack belongs to a module that is not in the rack.'); return; }
  if (!held) { hold(full); return; }
  if (held.full === full) { drop(); return; }
  if (f.p.dir === held.dir) { hold(full); return; }          // changed your mind: pick up this one instead
  const [from, to] = endsWith(full);
  const i = S.cables.findIndex(c => c.from === from && c.to === to);
  if (i >= 0) { unplug(i, true); return; }
  if (!compatible(portType(from), portType(to))) { toast(whyNot(portType(from), portType(to))); return; }
  connect(from, to);
}

/* ---------- the pin matrix ----------
   Outputs are rows, inputs are columns, like the pin panel on an EMS synth. A hole appears
   wherever a cable is allowed; a pin is a cable. Module groups fold to a single row or column. */
const MX_FILTERS = {
  all: { out: () => true, in: () => true },
  events: { out: t => t !== 'control', in: t => t === 'trigger' || t === 'clock' },
  notes: { out: t => t === 'note', in: t => t === 'note' },
  control: { out: t => t === 'control', in: t => t === 'control' },
};
function mxGroups(ports, folds) {
  const groups = [];
  for (const m of mods) { const ps = ports.filter(p => p.mod === m.id); if (ps.length) groups.push({ m, ports: ps, folded: folds.includes(m.id) }); }
  return groups;
}
function mxCell(r, c, ri, ci) {
  if (r.fold || c.fold) {
    const outs = r.fold ? r.fold.ports : [r.p], ins = c.fold ? c.fold.ports : [c.p];
    let n = 0, any = false;
    for (const o of outs) for (const i of ins) { if (compatible(o.type, i.type)) any = true; if (S.cables.some(x => x.from === o.full && x.to === i.full)) n++; }
    if (!any) return '<td class="nx"></td>';
    const label = `${r.fold ? r.fold.m.name : portLabel(r.p.full)} to ${c.fold ? c.fold.m.name : portLabel(c.p.full)}: ${n} cable${n === 1 ? '' : 's'}. Tap to unfold.`;
    return `<td><button class="fcell${n ? ' has' : ''}" data-act="mx-unfold" data-rows="${r.fold ? r.fold.m.id : ''}" data-cols="${c.fold ? c.fold.m.id : ''}" data-r="${ri}" data-c="${ci}" data-read="${esc(label)}" aria-label="${esc(label)}">${n || ''}</button></td>`;
  }
  const o = r.p, i = c.p;
  if (!compatible(o.type, i.type)) return '<td class="nx"></td>';
  const on = S.cables.some(x => x.from === o.full && x.to === i.full);
  const label = `${portLabel(o.full)} → ${portLabel(i.full)}`;
  return `<td><button class="hole t-${o.type}${on ? ' pin' : ''}" data-act="mx-pin" data-from="${o.full}" data-to="${i.full}" data-r="${ri}" data-c="${ci}" aria-pressed="${on}" aria-label="${esc(label)}" data-read="${esc(label + (on ? ' · pinned, tap to remove' : ' · tap to pin'))}"></button></td>`;
}
function renderMatrix() {
  const wrap = $('#mxWrap'); const u = ui(); const fk = MX_FILTERS[u.mxFilter] ? u.mxFilter : 'all'; const flt = MX_FILTERS[fk];
  document.querySelectorAll('#mxFilters .seg').forEach(b => { const on = b.dataset.f === fk; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $('#mxPatched').checked = !!u.mxPatched;
  let outs = allPorts('out').filter(p => flt.out(p.type)), ins = allPorts('in').filter(p => flt.in(p.type));
  if (u.mxPatched) { outs = outs.filter(p => isOutPatched(p.full)); ins = ins.filter(p => isPatched(p.full)); }
  const rowG = mxGroups(outs, u.mxFoldRows || []), colG = mxGroups(ins, u.mxFoldCols || []);
  $('#mxCount').textContent = `${S.cables.length} pin${S.cables.length === 1 ? '' : 's'} · ${outs.length} outputs × ${ins.length} inputs`;
  if (!rowG.length || !colG.length) { wrap.innerHTML = `<p class="empty mx-empty">${u.mxPatched ? 'No cables match. Turn off “Patched only” to see every hole.' : 'Nothing to show with this filter.'}</p>`; return; }
  const cols = []; for (const g of colG) { cols.push(...(g.folded ? [{ fold: g }] : g.ports.map(p => ({ p })))); cols[cols.length - (g.folded ? 1 : g.ports.length)].gs = true; }
  const sl = wrap.scrollLeft, st = wrap.scrollTop;
  let h = '<table class="mx"><thead><tr class="mx-gr"><th class="mx-corner" rowspan="2"><span>Outputs ↓</span><span>Inputs →</span></th>';
  for (const g of colG) h += `<th class="mx-gh" colspan="${g.folded ? 1 : g.ports.length}"><button data-act="mx-fold" data-axis="cols" data-id="${g.m.id}" aria-expanded="${!g.folded}" title="${g.folded ? 'Unfold' : 'Fold'} ${esc(g.m.name)}">${esc(g.folded ? g.m.short : g.m.name)}</button></th>`;
  h += '</tr><tr class="mx-labels">';
  cols.forEach((c, ci) => {
    const gs = c.gs ? ' gs' : '';
    h += c.fold ? `<th class="mx-ch fold${gs}" data-c="${ci}"><span>${c.fold.ports.length} folded</span></th>`
      : `<th class="mx-ch t-${c.p.type}${gs}" data-c="${ci}" data-full="${c.p.full}" title="${esc(portLabel(c.p.full))}"><span><i></i>${esc(c.p.label)}</span></th>`;
  });
  h += '</tr></thead><tbody>';
  let ri = 0;
  for (const g of rowG) {
    h += `<tr class="mx-rg"><th class="mx-rgh"><button data-act="mx-fold" data-axis="rows" data-id="${g.m.id}" aria-expanded="${!g.folded}" title="${g.folded ? 'Unfold' : 'Fold'} ${esc(g.m.name)}">${esc(g.m.name)}</button></th><td class="mx-rgfill" colspan="${cols.length}"></td></tr>`;
    const rows = g.folded ? [{ fold: g }] : g.ports.map(p => ({ p }));
    for (const r of rows) {
      h += '<tr>' + (r.fold ? `<th class="mx-rh fold" data-r="${ri}">${r.fold.ports.length} outputs folded</th>`
        : `<th class="mx-rh t-${r.p.type}" data-r="${ri}" data-full="${r.p.full}" title="${esc(portLabel(r.p.full))}"><i></i>${esc(r.p.label)}</th>`);
      cols.forEach((c, ci) => { const td = mxCell(r, c, ri, ci); h += c.gs ? td.replace('<td', '<td data-gs') : td; });
      h += '</tr>'; ri++;
    }
  }
  wrap.innerHTML = h + '</tbody></table>';
  wrap.scrollLeft = sl; wrap.scrollTop = st;
  paintMatrixHeld();
}
function paintMatrixHeld() {
  document.querySelectorAll('#mxWrap th.held').forEach(el => el.classList.remove('held'));
  if (held) document.querySelectorAll(`#mxWrap th[data-full="${held.full}"]`).forEach(el => el.classList.add('held'));
}
let mxHl = [];
function mxHighlight(b) {
  for (const el of mxHl) el.classList.remove('hl'); mxHl = [];
  if (!b || !b.dataset.r) { $('#mxRead').textContent = 'Rows are outputs, columns are inputs. Tap a hole to put a pin in.'; return; }
  mxHl = [...document.querySelectorAll(`#mxWrap th[data-r="${b.dataset.r}"], #mxWrap th[data-c="${b.dataset.c}"]`)];
  for (const el of mxHl) el.classList.add('hl');
  $('#mxRead').textContent = b.dataset.read || '';
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
    get name() { return m.name; },
    get state() { return S.modules[id]; },
    save,
    now,
    get ctx() { return E.ctx; },
    get output() { return m.out ? m.out.tap : null; },
    get mainOut() { return E.out; },
    get visible() { return isVisible(m); },
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

/* ---------- building the rack ---------- */
function instantiate(entry) {
  const t = types[entry.type]; if (!t) throw new Error(`No module called "${entry.type}" in the catalogue.`);
  const def = t.def, id = entry.id;
  if (!S.modules[id]) S.modules[id] = def.defaults ? def.defaults() : {};
  const n = id === def.id ? '' : ' ' + id.slice(def.id.length + 1);
  const m = { id, type: def.id, def, source: t.source, kind: def.kind === 'utility' ? 'utility' : 'instrument', name: def.name + n, short: (def.short || def.name) + n };
  m.api = makeApi(m);
  m.inst = def.create(m.api) || {};
  if (isUtility(m)) {
    const strip = document.createElement('section'); strip.className = 'strip'; strip.dataset.mod = id; strip.setAttribute('aria-label', m.name);
    strip.innerHTML = `<header class="strip-h"><i class="screw" aria-hidden="true"></i><h3>${esc(m.name)}</h3><button class="strip-x" data-act="rack-remove" data-id="${id}" aria-label="Remove ${esc(m.name)} from the rack" title="Remove from the rack">×</button></header>`;
    const body = document.createElement('div'); body.className = 'strip-body'; strip.appendChild(body);
    $('#utilGrid').appendChild(strip);
    m.el = { root: strip, stage: null, panel: body };
  } else {
    const view = document.createElement('section'); view.className = 'view'; view.id = 'view-' + id; view.hidden = true; view.setAttribute('aria-label', m.name);
    const stage = document.createElement('div'); stage.className = 'stage';
    const panel = document.createElement('aside'); panel.className = 'panel';
    view.append(stage, panel); $('#views').appendChild(view);
    m.el = { root: view, stage, panel };
  }
  mods.push(m); byId[id] = m;
  try { m.inst.mount && m.inst.mount(m.el.stage, m.el.panel); } catch (e) { console.error(e); m.el.panel.innerHTML = `<p class="note">${esc(m.name)} failed to draw: ${esc(e.message)}</p>`; }
  if (E.ctx) startModuleAudio(m);
  return m;
}
function unregister(m) {
  try { m.inst.destroy && m.inst.destroy(); } catch (e) { console.error(e); }
  if (m.out) { try { m.out.vol.disconnect(); } catch (e) { /* already gone */ } }
  m.el.root.remove();
  mods.splice(mods.indexOf(m), 1); delete byId[m.id];
}
function layout() {
  const order = id => S.rack.findIndex(e => e.id === id);
  mods.sort((a, b) => order(a.id) - order(b.id));
  const grid = $('#utilGrid'); for (const m of mods) if (isUtility(m)) grid.appendChild(m.el.root);
  renderChrome();
}
function buildRack(list, failed) {
  for (const m of [...mods]) unregister(m);
  S.rack = [];
  for (const e of normRack(list)) {
    if (S.rack.some(x => x.id === e.id)) continue;
    S.rack.push(e);   // kept even if it fails to load, so a module missing for a moment isn't lost from the rack
    try { instantiate(e); } catch (err) { console.error(err); if (failed) failed.push(e.id); }
  }
  layout();
}
function newInstanceId(type) {
  const taken = id => byId[id] || S.rack.some(e => e.id === id);
  if (!taken(type)) return type;
  let n = 2; while (taken(type + '-' + n)) n++;
  return type + '-' + n;
}
function addModule(type, quiet) {
  const t = types[type]; if (!t) return null;
  if (!t.def.multiple && mods.some(m => m.type === type)) { toast(t.def.name + ' is already in the rack.'); return null; }
  const id = newInstanceId(type);
  S.modules[id] = t.def.defaults ? t.def.defaults() : {};
  const entry = { id, type };
  const m = instantiate(entry); S.rack.push(entry);
  layout(); route(); save(); refresh();
  if (!quiet) toast('Added ' + m.name + (isUtility(m) ? ' to Utilities' : ''), { label: 'Show', fn: () => showModule(id) });
  return m;
}
function showModule(id) {
  const m = byId[id]; if (!m) return;
  closePatch(); location.hash = viewOf(m); route();
  if (isUtility(m)) requestAnimationFrame(() => m.el.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}
function removeModule(id) {
  const m = byId[id]; if (!m) return;
  const idx = S.rack.findIndex(e => e.id === id), entry = S.rack[idx];
  const state = S.modules[id] ? clone(S.modules[id]) : null;
  const cables = S.cables.filter(c => modOf(c.from) === id || modOf(c.to) === id);
  S.cables = S.cables.filter(c => !cables.includes(c));
  S.rack.splice(idx, 1); delete S.modules[id];
  if (held && modOf(held.full) === id) held = null;
  unregister(m); layout(); route(); save(); refresh();
  toast(`Removed ${m.name}` + (cables.length ? ` and ${cables.length} cable${cables.length === 1 ? '' : 's'}` : ''), {
    label: 'Undo',
    fn() {
      if (byId[id] || !types[entry.type]) return;
      if (state) S.modules[id] = state;
      instantiate(entry); S.rack.splice(Math.min(idx, S.rack.length), 0, entry);
      S.cables.push(...cables.filter(c => findPort(c.from) && findPort(c.to)));
      layout(); route(); save(); refresh();
    },
  });
}
function moveModule(id, d) {
  const i = S.rack.findIndex(e => e.id === id); if (i < 0) return; const k = kindOfType(S.rack[i].type);
  let j = i + d; while (j >= 0 && j < S.rack.length && kindOfType(S.rack[j].type) !== k) j += d;
  if (j < 0 || j >= S.rack.length) return;
  [S.rack[i], S.rack[j]] = [S.rack[j], S.rack[i]];
  layout(); route(); save(); renderSheet();
}
async function importSource(src) {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try { return (await import(url)).default; } finally { URL.revokeObjectURL(url); }
}
async function loadRepoType(id) { const mod = await import(`../modules/${id}.js`); addType(mod.default, 'repo'); return mod.default; }
function reinstantiateType(type) {     // swap running instances of a type for a newly loaded definition
  for (const m of mods.filter(x => x.type === type)) { const entry = S.rack.find(e => e.id === m.id); unregister(m); instantiate(entry); }
  layout();
}

/* ---------- patches ---------- */
function snapshot() { return clone({ rack: S.rack, modules: S.modules, cables: S.cables, mix: S.mix }); }
function applyPatch(p) {
  held = null;
  const rack = Array.isArray(p.rack) ? p.rack : S.rack;
  S.modules = clone(p.modules || {});
  const failed = [];
  buildRack(rack, failed);
  S.cables = (p.cables || []).filter(c => c && c.from && c.to).map(c => ({ from: c.from, to: c.to }));
  if (p.mix) { S.mix = clone(p.mix); if (!S.mix.mods) S.mix.mods = {}; if (typeof S.mix.master !== 'number') S.mix.master = 0.8; }
  applyMix(); $('#masterVol').value = S.mix.master; route(); save(); refresh();
  if (failed.length) toast('Not in the catalogue, so left out: ' + failed.join(', '));
}
let defaultPatchCache = null;
async function defaultPatch() {
  if (defaultPatchCache) return defaultPatchCache;
  try { const r = await fetch('patches/default.json', { cache: 'no-cache' }); if (r.ok) return (defaultPatchCache = await r.json()); } catch (e) { /* no default */ }
  return { cables: [] };
}

/* ---------- chrome and the patch sheet ---------- */
let sheetTab = 'cables';
const hasNew = () => catalogue.some(id => S.seen && !S.seen.includes(id));
function renderChrome() {
  const inst = mods.filter(m => !isUtility(m)), utils = mods.filter(isUtility);
  let h = inst.map(m => `<a href="#${m.id}" data-view="${m.id}" class="${m.source === 'local' ? 'local' : ''}">${esc(m.name)}</a>`).join('');
  if (utils.length) h += `<a href="#utilities" data-view="utilities">Utilities</a>`;
  $('#tabs').innerHTML = h;
  $('#tabsFixed').innerHTML = `<a href="#matrix" data-view="matrix" class="tab-mx">Matrix</a>` +
    `<button class="tab-add${hasNew() ? ' has-new' : ''}" data-act="open-rack" aria-label="Add or remove modules" title="Add or remove modules">+</button>`;
  let leds = inst.map(m => `<span><i class="led" id="led-${m.id}"></i>${esc(m.short)}</span>`).join('');
  if (utils.length) leds += `<span><i class="led" id="led-utilities"></i>Utilities</span>`;
  $('#leds').innerHTML = leds;
  $('#utilEmpty').hidden = utils.length > 0;
  paintTabs();
  document.querySelectorAll('.navrow a').forEach(a => { if (a.dataset.view === cur) a.setAttribute('aria-current', 'page'); });
}
function renderCables() {
  const n = S.cables.length;
  $('#cableCount').textContent = n ? n + ' cable' + (n === 1 ? '' : 's') : 'Cables';
  const list = $('#p-list');
  if (!n) { list.innerHTML = '<p class="empty">No cables yet. Each module still plays on its own. Tap any jack, or open the matrix, to start one.</p>'; return; }
  const groups = [];
  S.cables.forEach((c, i) => {
    const mid = modOf(c.from); let g = groups.find(x => x.mid === mid);
    if (!g) groups.push(g = { mid, name: byId[mid] ? byId[mid].name : mid + ' (not in rack)', rows: [] });
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
function renderRack() {
  const row = (m, list, k) => {
    const t = types[m.type];
    return `<li><span class="grow">${esc(m.name)}<small>${m.type}.js · v${esc(m.def.version || 1)}${t && t.source === 'local' ? ' · this browser only' : ''}</small></span>` +
      `<button class="btn small ghost" data-act="rack-move" data-id="${m.id}" data-d="-1" ${k === 0 ? 'disabled' : ''} aria-label="Move ${esc(m.name)} earlier">↑</button>` +
      `<button class="btn small ghost" data-act="rack-move" data-id="${m.id}" data-d="1" ${k === list.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(m.name)} later">↓</button>` +
      `<button class="btn small ghost" data-act="rack-remove" data-id="${m.id}">Remove</button></li>`;
  };
  const inst = mods.filter(m => !isUtility(m)), utils = mods.filter(isUtility);
  $('#rackInst').innerHTML = inst.length ? inst.map((m, k) => row(m, inst, k)).join('') : '<p class="empty">No instruments in the rack.</p>';
  $('#rackUtil').innerHTML = utils.length ? utils.map((m, k) => row(m, utils, k)).join('') : '<p class="empty">No utilities in the rack.</p>';
  const missing = S.rack.filter(e => !byId[e.id]);
  $('#rackMissing').hidden = !missing.length;
  $('#rackMissingList').innerHTML = missing.map(e => `<li><span class="grow">${esc(e.id)}<small>${esc(e.type)}.js could not be loaded</small></span><button class="btn small ghost" data-act="rack-forget" data-id="${esc(e.id)}">Remove</button></li>`).join('');
  const card = id => {
    const { def, source } = types[id]; const count = mods.filter(m => m.type === id).length;
    const full = count && !def.multiple; const isNew = S.seen && !S.seen.includes(id);
    return `<div class="libcard"><div class="grow"><b>${esc(def.name)}</b>${isNew ? '<span class="newtag">new</span>' : ''}${source === 'local' ? '<span class="newtag local">local</span>' : ''}` +
      `<p>${esc(def.description || '')}</p>${count ? `<small>${count} in the rack${def.multiple ? ' · you can add more' : ''}</small>` : ''}</div>` +
      `<div class="libbtns"><button class="btn small ${full ? 'ghost' : 'primary'}" data-act="rack-add" data-type="${id}" ${full ? 'disabled' : ''}>${full ? 'In rack' : 'Add'}</button>` +
      (source === 'local' ? `<button class="btn small ghost" data-act="rm-local" data-id="${id}" data-confirm="Forget?">Forget file</button>` : '') + '</div></div>';
  };
  $('#libInst').innerHTML = catalogue.filter(id => kindOfType(id) !== 'utility').map(card).join('') || '<p class="empty">None in the catalogue.</p>';
  $('#libUtil').innerHTML = catalogue.filter(id => kindOfType(id) === 'utility').map(card).join('') || '<p class="empty">None in the catalogue.</p>';
  if (hasNew()) { S.seen = [...catalogue]; save(); renderChrome(); }
}
function renderSheet() {
  document.querySelectorAll('.sheet-tabs .seg').forEach(b => { const on = b.dataset.tab === sheetTab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  for (const t of ['cables', 'mix', 'patches', 'rack']) $('#tab-' + t).hidden = t !== sheetTab;
  if (sheetTab === 'cables') renderCables();
  else if (sheetTab === 'mix') {
    const list = mods.filter(m => m.def.sound !== false);
    $('#p-mix').innerHTML = list.map(m => { const mx = mixFor(m.id); return `<span>${esc(m.name)}</span><input type="range" data-mixvol="${m.id}" min="0" max="1" step="0.01" value="${mx.vol}" aria-label="${esc(m.name)} volume"><button class="chip ${mx.mute ? 'on' : ''}" data-act="mute" data-mod="${m.id}">${mx.mute ? 'Muted' : 'Mute'}</button>`; }).join('');
  } else if (sheetTab === 'patches') {
    const names = Object.keys(S.patches || {});
    $('#patchList').innerHTML = names.length ? names.map(n => `<li><span class="grow">${esc(n)}<small>${(S.patches[n].rack || []).length || '—'} modules · ${S.patches[n].cables.length} cables</small></span><button class="btn small" data-act="load-patch" data-name="${esc(n)}" data-confirm="Tap again">Load</button><button class="btn small ghost" data-act="del-patch" data-name="${esc(n)}" data-confirm="Delete?" aria-label="Delete ${esc(n)}">×</button></li>`).join('') : '<p class="empty">Saved patches appear here.</p>';
  } else renderRack();
}
function refresh() {
  if (held && !findPort(held.full)) held = null;
  for (const m of mods) { try { m.inst.render && m.inst.render(); } catch (e) { console.error(e); } }
  $('#patchBtn').textContent = 'Patch · ' + S.cables.length + ' cable' + (S.cables.length === 1 ? '' : 's');
  paintJacks();
  if (cur === 'matrix') renderMatrix();
  if (!$('#sheet').hidden) renderSheet();
}
function openPatch(tab) { if (typeof tab === 'string') sheetTab = tab; $('#sheet').hidden = false; renderSheet(); }
function closePatch() { $('#sheet').hidden = true; }

/* ---------- routing, drawing, scheduling ---------- */
function views() { const v = mods.filter(m => !isUtility(m)).map(m => m.id); if (mods.some(isUtility)) v.push('utilities'); v.push('matrix'); return v; }
function route() {
  let v = location.hash.slice(1); const vs = views();
  if (byId[v] && isUtility(byId[v])) { const m = byId[v]; v = 'utilities'; requestAnimationFrame(() => m.el.root.scrollIntoView({ block: 'nearest' })); }
  if (!vs.includes(v)) v = vs.includes(S.view) ? S.view : vs[0];
  cur = v; S.view = v; save();
  for (const m of mods) if (!isUtility(m)) m.el.root.hidden = m.id !== v;
  $('#view-utilities').hidden = v !== 'utilities';
  $('#view-matrix').hidden = v !== 'matrix';
  document.querySelectorAll('.navrow a').forEach(a => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (v === 'matrix') renderMatrix();
  const a = $(`#tabs a[data-view="${v}"]`);   // keep the current tab visible in a scrolled tab row
  if (a) { const t = $('#tabs'), ar = a.getBoundingClientRect(), tr = t.getBoundingClientRect(); if (ar.left < tr.left || ar.right > tr.right) t.scrollLeft += ar.left - tr.left - 8; }
  if (held) requestAnimationFrame(revealJacks);
}
// With a cable in hand, bring the page's jacks into view inside its panel.
function revealJacks() {
  const m = byId[cur]; if (!m || isUtility(m)) return;
  const panel = m.el.panel, box = panel.querySelector('.jacks'); if (!box) return;
  const pr = panel.getBoundingClientRect(), br = box.getBoundingClientRect();
  if (br.top >= pr.top && br.bottom <= pr.bottom) return;
  const top = panel.scrollTop + br.top - pr.top - 8;
  panel.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function frame() {
  const T = now();
  if (cur === 'utilities') { for (const m of mods) if (isUtility(m) && m.inst.draw) { try { m.inst.draw(T); } catch (e) { console.error(e); } } }
  else { const m = byId[cur]; if (m && m.inst.draw) { try { m.inst.draw(T); } catch (e) { console.error(e); } } }
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
  E.out = E.ctx.createDynamicsCompressor(); E.out.threshold.value = -14; E.out.ratio.value = 4; E.out.connect(E.ctx.destination);
  E.master = E.ctx.createGain(); E.master.gain.value = S.mix.master; E.master.connect(E.out);
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
const toggleIn = (list, id) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
const ACTIONS = {
  'open-patch'() { openPatch('cables'); },
  'open-rack'() { openPatch('rack'); },
  'open-matrix'() { closePatch(); location.hash = 'matrix'; route(); },
  'close-patch'() { closePatch(); },
  'drop-cable'() { drop(); },
  'sheet-tab'(b) { sheetTab = b.dataset.tab; renderSheet(); },
  'rm-cable'(b) { unplug(+b.dataset.i, false); },
  'mute'(b) { const mx = mixFor(b.dataset.mod); mx.mute = !mx.mute; applyMix(); save(); renderSheet(); },
  'load-patch'(b) { if (!util.armed(b)) return; const p = S.patches[b.dataset.name]; if (p) { applyPatch(p); toast('Loaded ' + b.dataset.name); } },
  'del-patch'(b) { if (!util.armed(b)) return; delete S.patches[b.dataset.name]; save(); renderSheet(); },
  'rack-add'(b) { addModule(b.dataset.type); },
  'rack-remove'(b) { removeModule(b.dataset.id); },
  'rack-move'(b) { moveModule(b.dataset.id, +b.dataset.d); },
  'rack-forget'(b) { S.rack = S.rack.filter(e => e.id !== b.dataset.id); delete S.modules[b.dataset.id]; save(); renderSheet(); },
  'mx-pin'(b) {
    const { from, to } = b.dataset; const i = S.cables.findIndex(c => c.from === from && c.to === to);
    if (i >= 0) unplug(i, !!held); else connect(from, to);
  },
  'mx-fold'(b) { const u = ui(); const k = b.dataset.axis === 'rows' ? 'mxFoldRows' : 'mxFoldCols'; u[k] = toggleIn(u[k] || [], b.dataset.id); save(); renderMatrix(); },
  'mx-unfold'(b) { const u = ui(); u.mxFoldRows = (u.mxFoldRows || []).filter(x => x !== b.dataset.rows); u.mxFoldCols = (u.mxFoldCols || []).filter(x => x !== b.dataset.cols); save(); renderMatrix(); },
  'mx-filter'(b) { ui().mxFilter = b.dataset.f; save(); renderMatrix(); },
  async 'rm-local'(b) {
    if (!util.armed(b)) return; const id = b.dataset.id;
    setLocalModules(localModules().filter(x => x.id !== id));
    if (repoIds.includes(id)) { try { await loadRepoType(id); reinstantiateType(id); } catch (e) { console.error(e); } }
    else { for (const m of mods.filter(x => x.type === id)) removeModule(m.id); delete types[id]; catalogue = catalogue.filter(x => x !== id); }
    route(); refresh(); toast('Forgot the local copy of ' + id);
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
$('#mxPatched').addEventListener('change', e => { ui().mxPatched = e.target.checked; save(); renderMatrix(); });
$('#mxWrap').addEventListener('pointerover', e => mxHighlight(e.target.closest('[data-r][data-c]')));
$('#mxWrap').addEventListener('focusin', e => mxHighlight(e.target.closest('[data-r][data-c]')));
$('#mxWrap').addEventListener('pointerleave', () => mxHighlight(null));
$('#startBtn').addEventListener('click', startSound);
$('#p-reset').addEventListener('click', async e => {
  const b = e.currentTarget; if (!util.armed(b)) return; b.dataset.armed = ''; b.textContent = b.dataset.orig;
  const p = await defaultPatch(); applyPatch({ modules: {}, rack: p.rack || S.rack, cables: p.cables || [], mix: p.mix }); toast('Example patch restored');
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
    addType(def, 'local');
    setLocalModules([...localModules().filter(x => x.id !== def.id), { id: def.id, source: src }]);
    if (mods.some(m => m.type === def.id)) { reinstantiateType(def.id); route(); refresh(); toast('Updated ' + def.name + ' from the file'); }
    else { const m = addModule(def.id, true); if (m) { showModule(m.id); toast('Added ' + m.name + ' to this browser'); } }
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
  if (saved) { S = saved; if (!S.patches) S.patches = {}; if (!S.mix || !S.mix.mods) S.mix = { master: 0.8, mods: {} }; if (!S.ui) S.ui = {}; }
  const failed = [];
  try { const r = await fetch('modules/index.json', { cache: 'no-cache' }); repoIds = await r.json(); }
  catch (e) { toast('Could not read modules/index.json.'); }
  for (const id of repoIds) { try { await loadRepoType(id); } catch (e) { console.error(e); failed.push(id); } }
  for (const lm of localModules()) { try { addType(await importSource(lm.source), 'local'); } catch (e) { console.error(e); failed.push(lm.id + ' (local)'); } }
  const dp = await defaultPatch();
  if (!S.seen) S.seen = [...catalogue];
  if (!saved) S.cables = (dp.cables || []).map(c => ({ from: c.from, to: c.to }));
  const rack = S.rack || dp.rack || catalogue.filter(id => kindOfType(id) !== 'utility');
  buildRack(rack, failed);
  $('#loading').remove();
  $('#masterVol').value = S.mix.master;
  route(); refresh(); requestAnimationFrame(frame);
  if (failed.length) toast('Could not load: ' + failed.join(', '));
}
boot();

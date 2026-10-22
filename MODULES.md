# Writing a Patchwork module

A module is one JavaScript file in `modules/`. The host loads it, gives it a place on screen and a share of the audio engine, and makes its ports patchable to every other module: with jacks on its own page, and as rows and columns on the Matrix page.

There are two kinds:

- **Instruments** get a page of their own (a tab) with a large stage and a control panel. Examples: `bell-towers.js`, `solfege-pulses.js`, `line-score.js`.
- **Utilities** are small helpers. They share the Utilities page as narrow strips, and can allow several copies in the rack. Examples: `clock.js`, `lfo.js`, `gate.js`, `delay.js`, `quantise.js`, `scaler.js`, `recorder.js`.

## Adding a module to the site

1. Put the file in `modules/`.
2. Add its name (without `.js`) to `modules/index.json`. That file is the **catalogue**: every module anyone can add.
3. Commit. On the site the module shows up under **+** (Add or remove modules), marked **new**, and the **+** gets a dot until it has been seen.

People choose what is in their **rack** with **+**: add, remove (with Undo) and reorder. A saved patch remembers its rack. To try a module before committing it, use **+ → Try a module file**. It stays in that browser only.

To start a new utility, copy `modules/clock.js`. To start a new instrument, copy `modules/solfege-pulses.js`.

## The rules that keep modules swappable

1. **No imports.** Everything a module needs comes through the `host` object. This is what lets a module be tried from a local file.
2. **Talk only through ports.** A module never reaches into another module. It sends messages out of its own output ports and reacts to messages on its own inputs.
3. **Settings live in `host.state`.** Read it every time through `host.state`; don't keep a copy of the object, because loading a patch replaces it. Call `host.save()` after changing it. Settings must be plain JSON.
4. **Schedule ahead, by audio time.** Events carry a `time` in audio-clock seconds, usually a little in the future. Sounds start at `msg.time`, not "now".
5. **More than one may exist.** Use `host.id` for your own instance id, never a hard-coded one. Look up elements with `panel.querySelector(…)`, never `document.getElementById`, and use classes rather than ids inside your panel.
6. **Ids are a public API.** Once a module id, port id or settings key has shipped, never rename or remove it, because saved patches refer to them. Add new ones instead, and give new settings keys a fallback when reading.

## File shape

```js
export default {
  id: 'my-module',        // matches the file name; a–z, 0–9 and hyphens only
  name: 'My Module',      // tab or strip name
  short: 'Mine',          // short name for activity lights and cable labels
  version: 1,
  kind: 'utility',        // 'instrument' (default) or 'utility'
  multiple: true,         // utilities only: allow several copies (my-module, my-module-2, …)
  sound: false,           // false if it makes no sound: leaves it out of the mixer and the sampler's sources
  description: 'One sentence shown when adding it to the rack.',
  defaults() { return { /* settings for a new instance */ }; },
  create(host) {
    // runtime variables here
    return { /* instance methods, below */ };
  },
};
```

## Instance methods

All are optional.

| Method | Called when | What it does |
|---|---|---|
| `ports()` | often | Returns the port list (see below). It can change over time, e.g. when a tower is added; call `host.portsChanged()` after a change. |
| `mount(stage, panel)` | once | Builds the module's place on screen. An instrument gets `stage` (the large left area) and `panel` (the control column). A utility gets `stage = null` and `panel` = its strip. |
| `render()` | after cable or patch changes | Rebuilds the controls, including the jacks (`host.portsBox`). Keep anything that animates outside the part you rebuild. |
| `draw(time)` | every frame while the module is on screen | Animates. `time` is the audio clock. |
| `audioInit()` | once, when the person presses Start sound (or when added after that) | Create long-lived audio nodes. Connect them to `host.output`. |
| `schedule(now, until)` | every 25 ms while sound runs | Plan everything that happens before `until`. Runs whichever page is showing. |
| `input(portId, msg)` | a message arrives on an input port | React to it. |
| `audioSources()` | when a sampler lists sources | Extra sampleable parts, as `[{ id, label }]`. The whole module is always listed automatically. |
| `getBus(id)` | a sampler records one of those parts | Returns the audio node for that part. |
| `reset()` | rarely | Clear runtime state. |
| `themeChanged()` | light/dark switch | Redraw anything cached with colours. |
| `sourceRenamed(from, to)` | another module removed a sampleable part | Update any setting that pointed at `from`. |
| `destroy()` | the module is removed from the rack, or a patch is loaded | Stop timers, release resources. |

## Ports and messages

```js
{ id: 't2.strike', label: 'Tower 3 · strike', dir: 'out', type: 'trigger' }
```

Port ids are local to the module. The host adds the instance id, so the patch stores `bell-towers.t2.strike`. Port ids may contain dots; module ids may not.

**Labels.** When a module has repeated parts (towers, inks), give the port id a part prefix (`t2.`, `pink.`) and the label the form `Part · name`. The jack shows only the name; the matrix and cable lists show the full label.

| Type | Message | Meaning |
|---|---|---|
| `clock` | `{ kind: 'clock', time }` | A regular timing pulse. |
| `trigger` | `{ kind: 'trigger', time, vel }` | Something happened. `vel` is 0–1. |
| `note` | `{ kind: 'note', time, midi, vel, dur }` | A pitched event. `dur` in seconds. |
| `control` | `{ kind: 'control', time, value }` | A smooth value from 0 to 1, sent often (each `schedule` call is fine). |

Which outputs can feed which inputs:

- clock, trigger or note → **clock** or **trigger** inputs (any event can fire them)
- note → **note** inputs only
- control → **control** inputs only

Audio does not travel along cables. A module that wants another module's sound samples it with `host.getBus(sourceId)`; see `line-score.js`.

Send with `host.emit(portId, msg)`. A control input should fall back to its normal value when nothing is patched to it: check `host.isPatched(portId)` inside `schedule`. Events meant for later (echoes, say) should wait in the module and be sent from `schedule` when they are about to happen; see `delay.js`.

Patching is done by the host. People tap a jack to pick up a cable and a lit jack to plug it in, or put pins in the Matrix. A module never needs its own patching UI.

## The `host` object

| Member | Use |
|---|---|
| `host.id`, `host.name` | This instance's id (`gate`, `gate-2`, …) and display name. |
| `host.state`, `host.save()` | This instance's saved settings. |
| `host.ctx` | The shared `AudioContext`, or `null` before Start sound. |
| `host.output` | Gain node to connect this module's audio to. `null` before Start sound. |
| `host.mainOut` | The final mix, for recording it. `null` before Start sound. |
| `host.now()` | Current audio time. |
| `host.emit(portId, msg)` | Send from an output port. |
| `host.isPatched(portId)`, `host.isOutPatched(portId)` | Is a cable plugged into this input / output? |
| `host.portsChanged()` | Tell the host the port list changed. |
| `host.removeCables(prefix)` | Remove cables on ports starting with `prefix`, e.g. a deleted tower. |
| `host.renameSource(from, to)` | Tell samplers a sampleable part is gone (`to` = `null` points them at the whole module). |
| `host.portsBox(prefix)` | HTML for this module's jacks (ports whose id starts with `prefix`). Put it at the end of the controls you rebuild in `render()`. |
| `host.audioSources()`, `host.getBus(id)` | List and fetch every module's sampleable audio. |
| `host.makeCanvas(el, onResize)` | A canvas that fills `el` and stays sized to it (in device pixels). For utilities, give it a `<div class="scope">`. |
| `host.colours()` | Current theme colours: `paper`, `panel`, `ink`, `muted`, `rule`, the inks `pink`, `blue`, `yellow`, `teal`, `orange`, and `blend` (`multiply` or `screen`). |
| `host.noise()` | A short shared white-noise `AudioBuffer`. |
| `host.toast(text)` | A short message at the bottom of the screen. |
| `host.openPatch(tab)` | Open the patch sheet (`'cables'`, `'mix'`, `'patches'` or `'rack'`). |
| `host.visible` | Whether this module is on screen. |
| `host.util` | `clamp`, `mtof`, `hzToMidi`, `noteName`, `NOTE_NAMES`, `esc`, `r1`, `armed`. |

## Panel kit

The host stylesheet has classes for module panels:

- Layout and text: `ph` + `lede` for a heading, `group` (a fieldset with a `legend`), `field`, `row` (`row spread` pushes ends apart), `status`, `note`, `mono`, `big`.
- Controls: `toggle`, `btn` (`primary`, `ghost`, `small`), `chips`/`chip`, `segs`/`seg`, `stepper`.
- Displays: `wave`, `hint` for a caption on an instrument's stage, and for utilities `lamps`/`lamp` (add class `on` to light one; give it a type class like `t-trigger` for its colour), `meter` (an `<i>` for the bar and a `<b>` for a marker), `scope` (a box for `host.makeCanvas`) and `keys` (12 note boxes, `in` and `on` classes).
- Buttons with `data-confirm="Tap again…"` work with `host.util.armed(button)` for two-tap confirmation.

Prefix your own class names and `data-` attributes with a short module tag (`bt-`, `sp-`, `ls-`, `ck-`) so they never collide with another module's.

## Checklist for a new module

- [ ] `export default` with `id`, `name`, `kind`, `description`, `create`
- [ ] No `import` lines
- [ ] Settings in `defaults()`, read through `host.state`
- [ ] Works with several copies on the page (if `multiple`): `host.id`, panel-scoped lookups, no element ids
- [ ] Audio connected to `host.output`, created in `audioInit()` or later
- [ ] Sounds and emits scheduled at `msg.time` / scheduled times
- [ ] Added to `modules/index.json`

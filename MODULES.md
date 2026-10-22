# Writing a Patchwork module

A module is one JavaScript file in `modules/`. The host loads it, gives it a page (a tab), a share of the audio engine, and ports that can be patched to any other module.

To install a module, put the file in `modules/` and add its name (without `.js`) to `modules/index.json`. To try one first, open **Patch → Modules → Choose a module file** and pick the file. It stays in that browser only.

`modules/clock.js` is the smallest complete module. Copy it to start a new one.

## The rules that keep modules swappable

1. **No imports.** Everything a module needs comes through the `host` object. This is what lets a module be tried from a local file.
2. **Talk only through ports.** A module never reaches into another module. It sends messages out of its own output ports and reacts to messages on its own inputs.
3. **Settings live in `host.state`.** Read it every time through `host.state`; don't keep a copy of the object, because loading a patch replaces it. Call `host.save()` after changing it. Settings must be plain JSON.
4. **Schedule ahead, by audio time.** Events carry a `time` in audio-clock seconds, usually a little in the future. Sounds start at `msg.time`, not "now".

## File shape

```js
export default {
  id: 'my-module',        // matches the file name; a–z, 0–9 and hyphens only
  name: 'My Module',      // tab name
  short: 'Mine',          // short name for activity lights and cable labels
  version: 1,
  defaults() { return { /* first-run settings */ }; },
  create(host) {
    // runtime variables here
    return { /* instance methods, below */ };
  },
};
```

## Instance methods

All are optional except where noted.

| Method | Called when | What it does |
|---|---|---|
| `ports()` | often | Returns the port list (see below). It can change over time, e.g. when a tower is added; call `host.portsChanged()` after a change. |
| `mount(stage, panel)` | once | Builds the page. `stage` is the large left area, `panel` the control column. |
| `render()` | after cable or patch changes, and when a cable is picked up or put down | Rebuilds the panel, including its jacks (`host.portsBox`). |
| `draw(time)` | every frame while the page is visible | Animates the stage. `time` is the audio clock. |
| `audioInit()` | once, when the person presses Start sound | Create long-lived audio nodes. Connect them to `host.output`. |
| `schedule(now, until)` | every 25 ms while sound runs | Plan everything that happens before `until`. Also runs while other pages are showing. |
| `input(portId, msg)` | a message arrives on an input port | React to it. |
| `audioSources()` | when a sampler lists sources | Extra sampleable parts, as `[{ id, label }]`. The whole module is always listed automatically. |
| `getBus(id)` | a sampler records one of those parts | Returns the audio node for that part. |
| `reset()` | after a patch is loaded or the rack is reset | Clear runtime state. |
| `themeChanged()` | light/dark switch | Redraw anything cached with colours. |
| `sourceRenamed(from, to)` | another module removed a sampleable part | Update any setting that pointed at `from`. |
| `destroy()` | a local module is removed | Tidy up. |

## Ports and messages

```js
{ id: 't2.strike', label: 'Tower 3 · strike', dir: 'out', type: 'trigger' }
```

Port ids are local to the module (the host adds the module id, so the patch stores `bell-towers.t2.strike`). Port ids may contain dots; module ids may not.

**Once a port id has shipped, never rename or remove it.** Saved patches refer to it. Add a new port instead.

**Labels.** When a module has repeated parts (towers, inks), give the port id a part prefix (`t2.`, `pink.`) and the label the form `Part · name`. The jack shows only the name, the patch sheet groups jacks by part, and cable lists show the full label.

| Type | Message | Meaning |
|---|---|---|
| `clock` | `{ kind: 'clock', time }` | A regular timing pulse. |
| `trigger` | `{ kind: 'trigger', time, vel }` | Something happened. `vel` is 0–1. |
| `note` | `{ kind: 'note', time, midi, vel, dur }` | A pitched event. `dur` in seconds. |
| `control` | `{ kind: 'control', time, value }` | A smooth value from 0 to 1, sent often. |

Which outputs can feed which inputs:

- clock, trigger or note → **clock** or **trigger** inputs (any event can fire them)
- note → **note** inputs only
- control → **control** inputs only

Audio does not travel along cables. A module that wants another module's sound samples it with `host.getBus(sourceId)`; see `line-score.js`.

Send with `host.emit(portId, msg)`. A control input should fall back to its normal value when nothing is patched to it: check `host.isPatched(portId)` inside `schedule`.

## The `host` object

| Member | Use |
|---|---|
| `host.state`, `host.save()` | This module's saved settings. |
| `host.ctx` | The shared `AudioContext`, or `null` before Start sound. |
| `host.output` | Gain node to connect this module's audio to. `null` before Start sound. |
| `host.now()` | Current audio time. |
| `host.emit(portId, msg)` | Send from an output port. |
| `host.isPatched(portId)`, `host.isOutPatched(portId)` | Is a cable plugged into this input / output? |
| `host.portsChanged()` | Tell the host the port list changed. |
| `host.removeCables(prefix)` | Remove cables on ports starting with `prefix`, e.g. a deleted tower. |
| `host.renameSource(from, to)` | Tell samplers a sampleable part is gone (`to` = `null` points them at the whole module). |
| `host.portsBox(prefix)` | HTML for this module's jacks (ports whose id starts with `prefix`), for the panel. Put it at the end of the panel and re-render it in `render()`. Tapping a jack is handled by the host. |
| `host.audioSources()`, `host.getBus(id)` | List and fetch every module's sampleable audio. |
| `host.makeCanvas(stage, onResize)` | A canvas that fills the stage and stays sized to it (in device pixels). |
| `host.colours()` | Current theme colours: `paper`, `panel`, `ink`, `muted`, `rule`, the inks `pink`, `blue`, `yellow`, `teal`, `orange`, and `blend` (`multiply` or `screen`). |
| `host.noise()` | A short shared white-noise `AudioBuffer`. |
| `host.toast(text)` | A short message at the bottom of the screen. |
| `host.openPatch()` | Open the patch sheet. |

Patching itself is done by the host: a person taps a jack to pick up a cable and taps a lit jack (on any page, or in the tray) to plug it in. A module never needs its own patching UI.
| `host.visible` | Whether this module's page is showing. |
| `host.util` | `clamp`, `mtof`, `hzToMidi`, `noteName`, `NOTE_NAMES`, `esc`, `r1`, `armed`. |

## Panel kit

The host stylesheet has classes for module panels: `ph` + `lede` for the heading, `group` (a fieldset with a `legend`), `field`, `status`, `note`, `toggle`, `btn` (`primary`, `ghost`, `small`), `chips`/`chip`, `segs`/`seg`, `row`, `stepper`, `wave`, `mono`, and `hint` for a caption on the stage. Buttons with `data-confirm="Tap again…"` work with `host.util.armed(button)` for two-tap confirmation.

Prefix your own `data-act` names and element ids with a short module tag (`bt-`, `sp-`, `ls-`) so they never collide with another module's.

## Checklist for a new module

- [ ] `export default` with `id`, `name`, `create`
- [ ] No `import` lines
- [ ] Settings in `defaults()`, read through `host.state`
- [ ] Audio connected to `host.output`, created in `audioInit()` or later
- [ ] Sounds and emits scheduled at `msg.time` / scheduled times
- [ ] Added to `modules/index.json`

# Patchwork

A web-based modular rack. Each instrument is a module with its own page; modules are patched together with four kinds of signal: clock, trigger, note and control. Everything runs in the browser, and keeps playing while you switch pages.

**Live site:** https://jellyboyjesse.github.io/Solf-ge/ (once GitHub Pages is turned on, see below)

## Modules

**Instruments** have a page each:

| Module | File | What it does |
|---|---|---|
| Bell Towers | `modules/bell-towers.js` | Bells swinging at speeds set by their size. Each tower sends strikes and a swing clock, and can be rung or have its size modulated. |
| Solfège Pulses | `modules/solfege-pulses.js` | do, re, mi… each sung every so many pulses. Follows its own tempo or an external clock, and sings incoming notes. |
| Line Score | `modules/line-score.js` | Drawn ink lines played by moving players. Crossings bend the sound and send notes; each ink can sample any other module. |

**Utilities** share the Utilities page as strips, and you can add several of most:

| Module | File | What it does |
|---|---|---|
| Clock | `modules/clock.js` | Steady beat with two dividers and a chance gate. Also the template for new utilities. |
| LFO | `modules/lfo.js` | Slow wave (sine, triangle, ramp, square, random steps, drift) as a control signal, plus a trigger every cycle. |
| Gate | `modules/gate.js` | Coin toss per trigger: out of A with the set chance, otherwise out of B. |
| Delay | `modules/delay.js` | Echoes triggers and notes a set number of times, softer each time. |
| Quantise | `modules/quantise.js` | Snaps notes to a scale; turns a control signal (or chance) into notes on each trigger. |
| Scaler | `modules/scaler.js` | Scales, offsets, inverts and smooths control; fires triggers when it crosses a threshold. |
| Recorder | `modules/recorder.js` | Records everything you hear to a WAV file, by hand or on a trigger. |

## Your rack

**+** at the end of the tabs opens the rack: add instruments and utilities, remove them (with Undo) and change their order. Modules newly added to the repo show up there marked **new**.

## Patching

There are two ways to patch, and they always agree.

**Jacks.** Every module has jacks: inputs and outputs, ringed in the colour of their signal (blue trigger, green clock, pink note, orange control).

1. Tap a jack to pick up a cable.
2. Every jack it can plug into lights up, on every page. The tabs show how many each page has, and the tray lists them all.
3. Tap a lit jack, or a name in the tray, to plug in. A jack with a × is already plugged into the held one: tap it to unplug. **Let go** or Escape puts the cable down.

**Matrix.** The Matrix page is a pin board like the one on an EMS synth: outputs are rows, inputs are columns. Tap a hole to put a pin in, tap a pin to take it out.

- Holes only appear where a cable is allowed.
- Module names fold their rows or columns away.
- The filter shows only events, notes or control.
- **Patched only** hides everything without a cable.
- Pins flash as signals pass.

## Adding a module

1. Write it to the contract in [MODULES.md](MODULES.md), or ask Claude for one "as a Patchwork module".
2. Put the file in `modules/`.
3. Add its name to `modules/index.json`.
4. Commit. The site updates within a minute or two, and the module appears under **+** marked new.

To try a module before committing it, use **+ → Try a module file**. It stays in that browser only.

## Patches

A saved patch keeps the rack, every module's settings and the cables. Patches are stored in your browser, and can be exported and imported as `.json` files. `patches/default.json` is the example patch a new visitor starts with, and what **Reset** goes back to.

## Turning on GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → Save.

## Running it locally

The site uses JavaScript modules, so it must be served over http rather than opened as a file:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

## Files

```
index.html              the page
host/host.js            catalogue and rack, audio engine, jacks, matrix, saved patches
host/style.css          look and panel kit
modules/index.json      the catalogue: every module that can be added
modules/*.js            one file per module
patches/default.json    the example rack and cables
MODULES.md              how to write a module
CLAUDE.md               working notes for Claude: ground rules, decisions, roadmap
```

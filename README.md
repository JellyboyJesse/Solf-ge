# Patchwork

A web-based modular rack. Each instrument is a module with its own page; modules are patched together with four kinds of signal: clock, trigger, note and control. Everything runs in the browser, and keeps playing while you switch pages.

**Live site:** https://jellyboyjesse.github.io/Solf-ge/ (once GitHub Pages is turned on, see below)

## Modules

| Module | File | What it does |
|---|---|---|
| Bell Towers | `modules/bell-towers.js` | Bells swinging at speeds set by their size. Each tower sends strikes and a swing clock, and can be rung or have its size modulated. |
| Solfège Pulses | `modules/solfege-pulses.js` | do, re, mi… each sung every so many pulses. Follows its own tempo or an external clock, and sings incoming notes. |
| Line Score | `modules/line-score.js` | Drawn ink lines played by moving players. Crossings bend the sound and send notes; each ink can sample any other module. |
| Clock | `modules/clock.js` | Master clock with two dividers and a chance gate. Also the template for new modules. |

## Patching

Every module page has a row of **jacks**: inputs and outputs, ringed in the colour of their signal (blue trigger, green clock, pink note, orange control).

1. Tap a jack to pick up a cable from it.
2. Every jack it can plug into lights up, on every page. The tabs show how many each page has, and the tray at the bottom lists them all.
3. Tap a lit jack (or a name in the tray) to plug in. Undo is in the message that appears.

While holding a cable, a jack with a × is already plugged into it: tap it to unplug. **Let go** or Escape puts the cable down. The **Patch** sheet lists every cable and every jack of every module.

## Adding a module

1. Write it to the contract in [MODULES.md](MODULES.md), or ask Claude for one "as a Patchwork module".
2. Put the file in `modules/`.
3. Add its name to `modules/index.json`.
4. Commit. The site updates within a minute or two.

To try a module before committing it, open **Patch → Modules → Choose a module file** on the site. It stays in that browser only.

## Patches

The patch sheet has saved patches (stored in your browser), plus export and import as `.json` files. `patches/default.json` is the example patch a new visitor starts with, and what **Reset** goes back to.

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
host/host.js            module loader, audio engine, clock, patch bay, saved patches
host/style.css          look and panel kit
modules/index.json      which modules load, in tab order
modules/*.js            one file per module
patches/default.json    the example patch
MODULES.md              how to write a module
CLAUDE.md               working notes for Claude: ground rules, decisions, roadmap
```

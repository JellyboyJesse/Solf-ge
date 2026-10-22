# Patchwork: notes for Claude

Patchwork is Jesse's web-based modular rack. Each instrument is a **module** with its own page; modules are patched together with cables carrying four signal types. It is served by GitHub Pages straight from `main` at https://jellyboyjesse.github.io/Solf-ge/, with no build step.

Read `MODULES.md` before writing or changing a module. It is the contract.

## Working in this repo

- When Jesse asks for a change, commit and push it to `main` (he asked for direct pushes). Don't push changes he hasn't asked for.
- Plain HTML, CSS and ES modules only. No frameworks, bundlers, npm packages or build step. Everything must work as static files on GitHub Pages and on an Android phone.
- New instruments are new modules: one file in `modules/`, its name added to `modules/index.json`. Start from a copy of `modules/clock.js`. Modules have no `import` lines; everything comes through the `host` object.
- The host (`index.html`, `host/`) is shared by every module and changes rarely. Put module-specific features in the module.
- Commit messages: a short summary line, then what changed and why.

## Things that must not break

- **Port ids, module ids and settings keys are a public API.** Saved patches (in browsers and exported files) refer to `module-id.port-id`, and saved settings live under `state` keys. Never rename or remove them in an existing module. Add new ones instead, and give new settings keys a fallback when reading, because old saved state won't have them.
- Every module must play on its own with nothing patched, and must work when opened as the first page.
- Both light and dark themes: use the CSS tokens / `host.colours()`, never hard-coded colours.
- Phone width (about 390 px) must not scroll sideways.

## Design decisions so far

- Signals are **clock, trigger, note and control** only. Any event (clock, trigger, note) can fire a trigger or clock input; notes only go to note inputs; control only to control inputs.
- Audio never travels on cables. It moves by **sampling**, and audio processing lives in **Line Score** (each ink can sample any module or part of one).
- Each module is its own page (tab), but all modules run in one shared audio engine, so switching pages never stops the sound.
- Patching: tap a jack to pick up a cable; every jack it can plug into lights up on every page, the tray lists them, and tabs show counts. Tap a lit jack to plug in, a crossed one to unplug.
- Local first. "Rooms" (several devices sharing a patch over a small relay, e.g. a Cloudflare Worker) may come later, so keep messages small and serialisable.
- Jesse does **not** want MIDI out. A full visual patch-graph view is not wanted for now.

## Agreed roadmap

1. Bring modules up to their full versions:
   - Line Score: the four play modes (together, sequence, scanner, chained), pinch-to-zoom, the per-line notes window, long wavetables.
   - Bell Towers: Jesse's pixel-art landscape, zooming into a tower to edit its bell.
   - Solfège Pulses: real sung vocal sounds.
2. Sturdier platform: keep sampled takes across reloads (IndexedDB), move the sampler from ScriptProcessor to an AudioWorklet, module versions with patch migrations, installable/offline (manifest + service worker).
3. Utility modules: Recorder (WAV of the master output), probability gate, trigger delay, quantiser, control scaler/inverter.
4. Later: rooms.

## Checking work before pushing

1. Syntax-check each changed script: copy it to a `.mjs` file and run `node --check` on it.
2. Serve the repo (`python3 -m http.server 8765`) and load it in headless Chromium with Playwright. Check that:
   - every tab loads with no page errors
   - Start sound works
   - picking up a jack and plugging it into another module works, and undo works
   - the patch survives a reload
   - a 390 px-wide view has no sideways scroll, in light and dark
3. Look at a screenshot of anything visual you changed.
4. Tell Jesse what was not checked by ear. Headless tests can't judge sound or levels.

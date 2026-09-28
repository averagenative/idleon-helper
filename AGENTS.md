# AGENTS.md

A userscript for Legends of IdleOn that reads the game's in-memory state
(game attributes, engine geometry) rather than pixels. Plain ES2020, single
file, no build step, no dependencies - same spirit as the sibling
`idleon-clicker` project, different data source.

## The rules that matter

**Writes are limited to transient UI requests the game itself would make,
copied exactly from a specific game caller, and never saved state.** The
item card feature is the model: it writes precisely the gameAttributes
`_event_ChestItem` writes to open its own card (never a game array like
`ChestOrder`/`ChestQuantity`/`ChestMap` - those get saved, and are read-only
here always), and closes only a card this script opened, the same way the
game's own click-on-card handler closes one. A feature that needs more than
that - writing something that gets saved, or acting on state this script
didn't create - is a different, bigger decision: it needs its own line in
`README.md`'s "What it writes" section naming exactly what and why, a comment
at the call site citing the game caller it's copied from (see `NOTES.md`'s
"item card protocol" section for the level of detail expected), and it isn't
something to do quietly in passing while building something else. This is
the same hard line `idleon-clicker` draws at "only draw, never click" -
except here the line is drawn per-write, not per-script, because this
project's whole premise is reading state the clicker never touches.

**Provenance comments name the N.js handler, not a measurement.** This
project doesn't calibrate against footage the way the pixel-reading helpers
do - a constant here is either a game-attribute name (survives rebuilds) or a
geometry number read out of a specific handler in the client's compiled
source (may drift on a client update). Say which: e.g. "from the
`_event_Chest` click handler" or "from `ItemDefinitionsGET`'s `displayName`
field", not "measured on 2026-09-26" (there's nothing to measure - it's
either literally there in the source or it isn't). Update `NOTES.md` in the
same commit as any change to what a constant means.

**Never reload or navigate the live game tab.** A lost run costs an
ever-growing real-time cooldown on whatever minigame is running. `tools/cdp.mjs`
enforces this by construction - it has no `Page.navigate`/`Page.reload` call,
and no command should add one. Hot-swap instead (see dev loop below).

**Bump `@version` when you change `idleon-helper.user.js`.** Tampermonkey
uses it to offer updates: `@updateURL` points at raw `main` on
github.com/averagenative/idleon-helper, so a change ships when it is pushed
to `main`, and only if the version went up. Never lower it; a version that
compares lower is never offered.

## Dev loop

There is no test runner and no way to launch the game headlessly - it's a
live web page behind a login. Verification is against the one real running
session:

    node --check idleon-helper.user.js         # syntax
    node tools/cdp.mjs grab                    # once per browser session: stash the engine on window.__ihE
    node tools/cdp.mjs inject idleon-helper.user.js   # after every edit: drop the old panel, load the new one

`inject` removes anything already on the page marked `data-ih` before
evaluating the new script, so repeated injects don't stack up duplicate
panels or duplicate `window` listeners - the userscript's own rAF loop
notices its old host is gone and tears down what `inject` couldn't reach
(see the `loop` section in `idleon-helper.user.js`). `grab` only needs
running once per browser session, right after the game has loaded and its
Engine exists; `inject` works off whatever `window.__ihE` already holds after
that.

Never run `tools/cdp.mjs` (or anything that touches port 9222/whatever
`--port` was given) against a game tab someone else is actively using without
asking first - `grab` pauses the whole page for a moment, which is felt if
timed badly during play.

## Conventions

- Config lives in `localStorage['ih_cfg']`, one JSON blob, `Object.assign`ed
  over defaults so old saved configs keep working across changes to the
  shape.
- `// ---------- name ----------` section headers, matching the sibling
  project. This project has no generated build to keep them stable for, but
  keep them anyway - they're what makes the file skimmable.
- Panel lives in a closed shadow DOM, appended to `document.documentElement`
  (never inside the game's own container - see NOTES.md's Input Safety
  section for why). No control other than the search field keeps keyboard
  focus; the search field itself stops propagation on every key event so
  typing a query never reaches the game.
- All coordinates the game itself would recognize (mouse position, slot
  rects) are computed in the game's own screen-unit space and converted to
  CSS px only at the point of drawing (`toCss()`), never the other way
  around - that keeps hit-testing agreeing with the game regardless of
  window size or zoom.

## Things that will bite you

- **Window mouse listeners must be capture-phase.** The game calls
  `stopPropagation()` on `mouseup` at its own container, so a bubble-phase
  `window` listener silently misses every release over the canvas. See
  `NOTES.md`'s "Input safety" section.

- **Local variable names in `cache/N.js` are not stable across a client
  rebuild; field/behaviour/event names are.** See `NOTES.md`'s "how to find
  things" section before writing a new lookup against the client source.
- **`cache/N.js` is gitignored and ~26 MB.** Fetch it with
  `tools/fetch-client.sh` rather than committing it or assuming it's already
  there.
- **The engine-capture trap is on the class-registry key
  `"com.stencyl.Engine"`, not on any Engine field.** Haxe declares every
  instance field as `name:null` in the prototype literal, so an
  `Object.prototype` accessor for an instance field like `gameAttributes`
  is shadowed by the prototype's own data property and never fires - that is
  exactly how 0.2.1 shipped a trap that could not work, which the `cdp.mjs
  grab`/`inject` dev loop never noticed because it bypasses the trap. Before
  trapping any other name, check that nothing between the assigned object
  and `Object.prototype` already has it (`NOTES.md`'s "Engine capture"
  section), and remember that only a real page load with the installed
  script exercises this path.

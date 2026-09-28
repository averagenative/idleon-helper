# NOTES.md

Reverse-engineering map for `idleon-helper.user.js`. Every fact below says
what it came from and whether it has been checked against the live game or
only against the static client code in `cache/N.js` (gitignored; fetch it
with `tools/fetch-client.sh`). "Verified live" means confirmed against a
running game session, not just the source. Everything else here was checked
against `cache/N.js` on 2026-09-26 and is internally consistent, but has not
yet been watched happen in a real browser tab.

## How to find things in N.js

This is Closure-compiled Haxe/OpenFL (via Stencyl/Lime) output, one big
bundle. Two kinds of names behave very differently across a client rebuild:

- **Survive a rebuild:** Haxe class and field names, because they are read
  back *by name* elsewhere (`getGameAttribute("ChestOrder")`,
  `.h.displayName`) or because Haxe's reflection needs the literal string
  (`__name__`, `__class__`). Behaviour/event method names like `_event_Chest`
  and `_event_STORAGECHEST` are declared the same way and also survive.
  Grepping for one of these strings should keep working after IdleOn updates.
- **Do NOT survive a rebuild:** every local class variable - the single- and
  double-letter names like `a`, `c`, `z`, `fa`, `h` scattered through this
  file. Closure reassigns these fresh on every build. In this snapshot
  (2026-09-26), `a` happens to be the `com.stencyl.Engine` class itself
  (confirmed via `a.__name__="com.stencyl.Engine"`), `c` is the Actor/API
  facade class (`c.getMouseX`, `c.engine`, ...), `z` is the class registry
  object Haxe populates for every class (`z["com.stencyl.Engine"]`), and `fa`
  is `com.stencyl.Input`. None of that is safe to hardcode into a patch -
  which is why the engine-capture trap below keys off a class-name *string*
  (the registry key `"com.stencyl.Engine"`) instead of any of these.

To re-verify anything here after a client update: `grep -n '<name>'
cache/N.js` for the event/attribute name in question, not for any of the
single-letter variables in the surrounding code.

## Engine capture

- `com.stencyl.Engine`'s constructor does `a.engine=this;c.engine=this;...
  this.gameAttributes=new l;` - N.js line ~1589744 area (search
  `a.__name__="com.stencyl.Engine"`). Verified in cache/N.js.
- `getGameAttribute:function(a){return this.gameAttributes.h[a]}` is defined
  exactly once in the whole bundle, on the Engine prototype, which ends
  `...,__class__:a}` (line 784-785 in the 2026-09-26 snapshot). This is what
  `pollEngine()` checks before adopting an instance, and what
  `E.__class__` uses to reach the Engine class's static fields (`SCALE`,
  `screenScaleX/Y`, `screenOffsetX/Y`, `stage`) from an instance. Verified in
  cache/N.js.
- The class registry is a plain object, `var z={}` near the top of the
  bundle, and Engine is registered into it exactly once, by an ordinary
  assignment right before the prototype is built:
  `z["com.stencyl.Engine"]=a;a.__name__="com.stencyl.Engine";...;
  a.prototype={...}` (search `["com.stencyl.Engine"]`, one hit). Verified in
  cache/N.js, 2026-09-28.
- `Engine.resetStatics` sets `a.engine=null`; the constructor sets it back
  to the new instance. `pollEngine()` compares against the adopted instance
  every frame rather than reading it once, so it would follow a rebuilt
  Engine. Verified in cache/N.js.
- `Object.prototype` getter/setter trap on the key `"com.stencyl.Engine"`:
  our own hook, not something N.js knows about. It fires on the registry
  assignment above, re-creates the entry as the plain own property the
  assignment would have made, disarms both traps, and keeps the class; the
  instance is read off the class's `engine` static once the constructor has
  run. 0.2.2 attached through this on a real load (the hover card and search
  worked live, 2026-09-28) - the one live confirmation so far.
- **When the registry assignment happens.** N.js wraps the whole Haxe bundle
  as `lime.$scripts.N=function(K,ea){...}`; nothing in it runs when N.js is
  parsed. It runs when `index.html`'s own inline script calls
  `lime.embed("N","openfl-content",960,540,...)`, placed right after the
  blocking `<script src="./N.js">` tag. So the registry trap only works if
  the userscript runs before the parser reaches that inline script. On
  2026-09-28, 0.2.3 (unchanged capture code from 0.2.2) failed to attach on a
  reload with Tampermonkey 5.5 on Chrome 152, while `N.js` hadn't changed
  (same length and `last-modified` as `cache/N.js`). A late injection is the
  likeliest explanation, but it hasn't been confirmed. The debug readout's
  `capture` line now shows which path attached and whether the start was
  late.
- **Late-start detection.** The bundle's inner wrapper passes `window` as its
  global `T` (`..."undefined"!=typeof window?window:...` at the end of the
  `$scripts.N` function), and the static init runs `T.$haxeUID|=0`. So
  `typeof window.$haxeUID === 'number'` at userscript start means the bundle
  has already run. Verified in cache/N.js, 2026-09-28.
- **Bind-helper fallback trap on `hx__closures__`.** Haxe's `$bind`, `v(a,b)`
  in this build, does `null==a.hx__closures__?a.hx__closures__={}:...` the
  first time any method of `a` is bound, and no prototype literal declares
  `hx__closures__` (search `hx__closures__:`, no hits), so the read on a
  fresh object reaches an `Object.prototype` getter with the object as
  `this`. Two fresh objects lead to the Engine:
  - The Engine constructor sets `a.engine=this` and then binds seven of its
    own methods (`v(this,this.onUpdate)`, `onFocusLost`, `onFocus`,
    `onWindowResize`, `onWindowRestore`, `onWindowMaximize`,
    `onWindowFullScreen`), which covers a start after `lime.embed` but
    before the Engine is built.
  - A new actor's behavior scripts. `com.stencyl.behavior.ActorScript` is
    `function(a){c.call(this);this.actor=a}`, the Script base constructor
    binds nothing, and scripts bind their handlers in `init()`. By then the
    Actor constructor has set `this.engine=c`. `loadScene` replaces the
    recycled pool (`this.recycledActorsOfType=new Hb`), so a map change
    builds fresh actors, which covers a start after the Engine exists.
  - Not the Actor's own binds: the Actor constructor
    (`com.stencyl.models.Actor`) binds `updateTweenXY`/`updateTweenAngle`/
    `updateTweenScaleXY` *before* it sets `this.engine`.
  - A candidate is only accepted if `e.__class__.engine === e`. That rules
    out the Script facade class `c`, the only other object with a
    `getGameAttribute` method (a static forwarding to `c.engine`).

  Verified in cache/N.js, 2026-09-28, and checked in a Node replay of four
  injection timings: document-start attaches via the registry trap; after
  embed attaches via bind; after the Engine exists, nothing attaches until a
  map change, then bind does. NOT verified live.
- Why not trap `gameAttributes` (what 0.2.1 and earlier did): the Engine
  prototype literal declares the field itself -
  `...,actorsToCreate:null,gameAttributes:null,savableAttributes:null,...`
  (search `actorsToCreate:null,gameAttributes:null`). The constructor's
  `this.gameAttributes=new l` finds that writable data property on
  `Engine.prototype` first and just creates an own property on the instance,
  so an accessor on `Object.prototype` is never reached and the trap never
  fired - `E` stayed null and the panel never appeared on its own. Haxe
  declares every instance field as `name:null` on the prototype in this
  build, so no Engine *instance* field can be trapped this way. Verified in
  cache/N.js, 2026-09-28, and reproduced in Node.
- Dev hook `window.__ihE`: set by `tools/cdp.mjs grab`, which pauses the
  debugger and evaluates `z["com.stencyl.Engine"].engine` on whichever call
  frame has `z` in scope. This depends on `z` meaning the class registry in
  *this* snapshot; if a rebuild changes which single-letter variable holds it,
  `grab` needs updating (search `z["com.stencyl.Engine"]` again, it's a class
  registry keyed by literal class-name strings, so the search itself keeps
  working even if the variable holding the object doesn't).

## Screen/mouse math

- `c.getMouseX=function(){return fa.mouseX/a.SCALE}` and the equivalent for Y
  - verified in cache/N.js (search `getMouseX=function`).
- `fa.mouseX=(a.stage.get_mouseX()-a.screenOffsetX)/a.screenScaleX` (Input.update)
  - verified in cache/N.js. `gameMouse()` in the userscript reproduces both of
  these divisions (screenScaleX/Y then SCALE) to land on the same value the
  game itself computes, so hit-testing agrees with the game about which slot
  the cursor is over.
- `a.SCALE` (1), `a.screenScaleX/Y` (1), `a.screenOffsetX/Y` (0), and the
  stage's `stageWidth`/`stageHeight` (960x540) are all statics reached via
  `E.__class__` - live values (all defaults, no zoom/letterbox) NOT verified
  live yet; only their existence as fields is confirmed in cache/N.js.
- CSS px conversion (`toCss()`): game canvas backing 960x540 vs CSS rect
  1328x747 (k~=1.383) is a value given in the task brief as measured on a live
  session; NOT re-verified in this pass.

## Game attributes

All of the following attribute names are used with the exact spelling below
by N.js's storage UI code (`ActorEvents_*` behaviour handling `_event_Chest` /
`_event_ChestItem` / `_event_STORAGECHEST`), confirmed by grep on 2026-09-26:

- `ChestOrder` / `ChestQuantity` - parallel arrays, one entry per storage
  slot. `"Blank"` = empty slot, `"LockedInvSpace"` = slot the account hasn't
  unlocked. Both skipped by search and by the tooltip.
- `ChestSlotsOwned` - integer count of unlocked slots; tab count is
  `Math.ceil(ChestSlotsOwned/24)`. Confirmed in the tab-highlighting code
  right next to the click handler.
- `ItemDefinitionsGET` - Haxe StringMap; `.h[id].h.displayName` is the item's
  display name with underscores for spaces (e.g. `"Copper_Ore"`). Confirmed
  via multiple UI strings that build tooltips the same way
  (`h.string(...ItemDefinitionsGET...h.displayName)`).
- `OptionsList[3]` - selected storage tab. Read through `c.asNumber(...)`
  everywhere it's used arithmetically, which is why `selectedTab()` in the
  userscript does the same coercion rather than assuming it's already a
  clean int.
- `OptionsListAccount[343]` - `1` = compact layout, `0` = normal. Confirmed:
  the click handler and both draw loops branch on this exact index.
- `MenuType2 === 6` - storage is open. Confirmed as the guard the chest click
  handler itself checks before doing anything
  (`if(1==this._GeneralINFO[81]&&6==a.engine.getGameAttribute("MenuType2"))`).
  This is a strong signal (the game wouldn't process chest clicks if this
  weren't true while storage is open) but has not been separately watched
  live with the panel's debug readout - do that once, per the plan, to be
  sure nothing else also sets MenuType2 to 6.

## Storage geometry (game screen units)

All four pieces below - normal grid, compact grid, item-index formula, and
tab rects - come from the same function: the chest click handler reached via
`_event_Chest` -> `whenMousePressed`, guarded by `6==...MenuType2`. Verified
by reading that handler directly in cache/N.js on 2026-09-26 (not just cited
from a prior read):

```
if (155<mouseX<594) {
  if (77<mouseY<124)      tab = floor((mouseX-148)/65)
  else if (38<mouseY<78)  tab = floor((mouseX-148)/65) + 7
  else if (0<mouseY<39)   tab = floor((mouseX-148)/35) + 14
  else if (137<mouseY<427) {
    v = compact ? floor((mouseX-154)/37) + 12*floor((mouseY-135)/37)
                : floor((mouseX-154)/74) +  6*floor((mouseY-135)/74)
    index = v + 24*selectedTab
    // only acted on if index < ChestOrder.length and not Locked/Blank
  }
  // any of the tab branches above only take effect if
  // Math.ceil(ChestSlotsOwned/24) > tab
}
```

- Normal layout: 6 columns x 4 rows, cell size 74, origin (154,135).
- Compact layout: 12 columns x 8 rows, cell size 37, same origin.
- **Item index is `24*tab + v` in both layouts**, even though compact shows
  96 cells (not 24) at once. The compact *draw* loop (same handler's redraw,
  confirmed alongside the click code) iterates a 96-wide `v` but still offsets
  by `24*tab` - so incrementing "tab" by one slides the visible 96-cell window
  by one 24-slot page, rather than paging by a full screen's worth. This is
  the game's own behaviour, read directly off the draw loop, not inferred.
- Tab button rects: three rows as in the pseudocode above. Row 1 (`i` 0-6):
  x = 148+65*i, y in (77,124). Row 2 (`i` 7-13): x = 148+65*(i-7), y in
  (38,78). Row 3 (`i` 14+): x = 148+35*(i-14), y in (0,39). A tab is only
  live if `i < Math.ceil(ChestSlotsOwned/24)`.
- Item icon draw positions: the handler's redraw code places item icons at
  two slightly different offsets depending on which of two overlapping images
  it's drawing for the same cell - `159+74*col,140+74*row` for one image
  layer and `155+74*col,136+74*row` for another. Neither matches the click
  hit-rect's own origin (154,135) exactly; they're a few units off for visual
  centering. This script only uses the click-hit-rect origin/cell size (which
  is what determines which slot the game *thinks* was clicked), not either
  drawing offset, since drawing position and hit-testing don't need to agree
  pixel-for-pixel and only hit-testing matters for slotAt()/tabRects().

## Item card protocol

The project's first (and, as of this writing, only) write to game state.
Everything below is the trace it was built from - N.js line-level facts plus
what was confirmed live on 2026-09-26.

- **Opening.** About 20 different callers across N.js request the same item
  card by writing the same handful of gameAttributes; the one this script
  mirrors is the storage one, `_event_ChestItem`, used on a tap when Quick Tap
  (`OptionsListAccount[1]`) is off:
  ```
  ShowItemDescriptionBox = 1
  ItemToDisplayStats = "" + ChestOrder[i]
  ItemMapToDisplayStats = D.copyMap(ChestMap[i])
  PixelHelperActor[0].behaviors.getBehavior("ActorEvents_29")._ScrollCircleINFO[59] = ChestQuantity[i]
  ItemMapToDisplayStats.h.SuperFunItemDisplayType = "Inventory"
  ```
  `D.copyMap` (`D` is one of the unstable per-build class variables - see "how
  to find things" above) does a shallow copy into a **new** StringMap:
  `for(var b=new l,c=Object.keys(a.h),...)`. The copy is not optional to skip:
  the very next line adds `SuperFunItemDisplayType` to that map, and
  `ChestMap` is part of what gets saved to the account - writing the flag onto
  the original would leave UI-only state sitting in a save file. The
  userscript's `copyStringMap()` reproduces this, built off
  `E.gameAttributes.__class__` (confirmed live: its `__name__` is
  `"haxe.ds.StringMap"`) rather than `ChestMap[i].constructor`, because a
  ChestMap entry can report a plain `Object` constructor (verified live) - only
  `E.gameAttributes` is guaranteed to actually be one.
- **Spawning.** `_event_LASTUPDATEitembox` (ActorEvents_29, runs every frame)
  is what actually notices `ShowItemDescriptionBox==1`, flips it to `2`,
  builds the stat list from the attributes above, and creates a type-38 actor
  with `_PixelType` 5 - that's the card itself. While `MenuType2==6` it places
  the card at `x = clamp(mouseX-207, 5, 696)`, `y = clamp(mouseY-48, 5,
  430-(108+18*DummyNumber))`. This script never computes a position - placement
  is left entirely to the game, which is also why nothing here needs to know
  what `DummyNumber` means.
- **Closing.** The card never closes itself on a timer or per-frame check.
  `ActorEvents_38._event_ItemDescriptionBox` runs on `whenMousePressed` and
  recycles the PixelType-5 actor when the card itself is clicked.
  `_event_ScrollingCircle` also runs on `whenMousePressed`; when the flag is
  `2` it sets it back to `0`, but via `runLater(50)` - a 50ms delay, not
  immediately.
- **Engine API used (confirmed live, 2026-09-26):** `E.actorsOfType.h[38]` is
  the live array of type-38 actors (skip any with `.recycled`);
  `actor.behaviors.getBehavior("ActorEvents_38")._PixelType === 5` is how one
  of them is confirmed to be a card and not whatever else shares the type;
  `E.recycleActor(actor)` is the exact call the game's own close path makes;
  `E.setGameAttribute(name, v)` exists and is `this.gameAttributes.h[name]=v`
  (the same object the game's handlers write with `a.engine.gameAttributes.h.X=v`
  directly - both are the same write, `setGameAttribute` is just the public
  spelling of it).
- **The tap hazard, and why the fix is a pre-emptive mousedown close.**
  `_event_ChestItem` only treats a mouse *release* over a slot as a Quick-Tap
  storage tap when, at that moment, `1==_DummyType2Dead && 0==ShowItemDescriptionBox`.
  With our card open, the flag is `2` (or briefly `1`) the whole time it's
  showing, and stays `2` for a further 50ms after whatever closes it (the
  `runLater(50)` above) - so a normal, fast click on a slot while our card
  happens to be hovering over it would land on a release where the flag not
  only isn't `0` yet, it might not even be `0` by the time the release fires.
  The tap would be silently swallowed: no error, just nothing happening. The
  userscript's fix is `onWindowMousedown`, a **capture-phase window mousedown
  listener** that closes any card of ours and clears
  `ShowItemDescriptionBox` back to `0` before the press is even done being
  dispatched - the game's own listener is on its container element, not
  `window`, so a capture-phase window listener always runs first. By the time
  the release the game is waiting for actually happens, the flag has already
  been `0` since before the press.
- **Both tap modes go through that one check.** The full shape of
  `_event_ChestItem` (the handler on the drag actor, `_PixelType` 2.31, that
  a press on a slot creates) for a release on the same slot it was pressed
  on: `if(1==_DummyType2Dead&&0==ShowItemDescriptionBox) if(Quick Tap on
  [OptionsListAccount[1]==1] && MenuType2==6) { move to inventory,
  "ChestToInventory" } else { open the card, as above }`. So a nonzero flag
  at the release swallows a Quick-Tap-on tap (the move to inventory) just
  the same as a Quick-Tap-off one. A release on a *different* slot takes the
  swap/merge branch, which doesn't read the flag. Verified in cache/N.js,
  2026-09-28.
- **The reopen race (fixed in 0.2.3).** Closing the card at mousedown isn't
  enough on its own: the card must also not *reopen* between the DOM
  `mouseup` and the game's next update, which is when Stencyl actually runs
  its `whenMouseReleased` listeners. Up to 0.2.2, `updateCard()` treated the
  hover as "no slot" for the whole press, which cleared the `suppressIndex`
  the press had just set - so the first frame after the release requested a
  new card on the tapped slot (flag `1`). On a real page load that frame
  runs before the game's: the userscript makes its first
  `requestAnimationFrame` call at document-start, before lime's, and both
  re-request at the end of their callbacks (lime's is the last statement of
  `handleApplicationEvent`), so ours is first in every frame. Every tap on a
  hovered slot was swallowed. A copy hot-injected with `cdp.mjs inject`
  starts its loop after lime's, so it runs second and never showed this. Now
  every press sets `suppressIndex` to the slot under the cursor, and it's
  only released once the button is up and the hover has moved off. The
  frame-order claim is read off N.js and the rAF ordering rules. The bug and
  the fix were reproduced in a Node replay of the press/release sequence;
  NOT verified live yet.

## Input safety

- The game's own mouse listeners attach to its own container element, and it
  only adds a *window*-level `mouseup` listener after a `mousedown` lands
  inside that container. Confirmed in cache/N.js. This is why the helper's
  host is appended to `document.documentElement` rather than anywhere inside
  the game's container - a click that starts on a panel control can never be
  mistaken by the game for one that started on itself.
- The game **stops propagation of `mouseup` at its container**
  (`handleMouseEvent`: `case "mouseup": ... a.currentTarget==this.parent.element
  &&a.stopPropagation()`). A bubble-phase `window` mouseup listener never hears
  a release over the game. Every window mouse listener here is capture-phase
  for that reason. v0.2.0 shipped to the live tab with a bubble-phase one first:
  `mouseDown` stuck at true after the first click in the game, and the hover
  card would never have opened again.
- The game's key listeners are `window.addEventListener("keydown"/"keyup", ...,
  false)` - bubble phase. Confirmed in cache/N.js. Anything that must never
  reach the game (the search field's typing) stops propagation at the shadow
  DOM input itself, which is upstream of `window` in the bubble phase, so
  nothing further needs to intercept it.
- Hotkey choice: F4. The sibling project (idleon-clicker) already claims
  F2/F8/F9/F10; F5-F7/F11/F12 are browser-reserved on most setups. F4 was
  free of both.

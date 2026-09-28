// ==UserScript==
// @name         IdleOn Helper
// @namespace    nativerobot
// @version      0.2.2
// @downloadURL  https://raw.githubusercontent.com/averagenative/idleon-helper/main/idleon-helper.user.js
// @updateURL    https://raw.githubusercontent.com/averagenative/idleon-helper/main/idleon-helper.user.js
// @description  Reads Legends of IdleOn's in-memory state (not pixels) to help with storage: hover tooltips, a search overlay, and (optionally) the game's own item card on hover. The card feature writes the same transient UI request a storage tap already makes - see README for exactly what and why.
// @match        https://www.legendsofidleon.com/ytGl5oc/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
(function () {
  'use strict';

  // The game only ever runs in the top frame. Everything below - the engine
  // trap especially - has no reason to exist in an iframe, so bail before any
  // of it runs rather than after.
  if (window.top !== window) return;

  // ---------- engine capture ----------
  // Every readout in this script hangs off one live object: the
  // com.stencyl.Engine instance, which Engine's own constructor publishes as
  // a static on the class (N.js, read 2026-09-26: "...a.engine=this;
  // c.engine=this;..." where `a` is the Engine class itself). The only
  // definition of `getGameAttribute:function` in N.js sits on the Engine
  // prototype (`a.prototype={...,getGameAttribute:function(a){return
  // this.gameAttributes.h[a]},...,__class__:a}`), so it is a reliable way to
  // recognize an Engine instance once we see one.
  //
  // There is no exported "engine created" event to hook, and patching a
  // specific function is fragile here: Closure Compiler renames every local
  // class variable (a, c, z, fa, ...) on each client rebuild, so a patch
  // written against `a.engine=this` today can silently stop matching after
  // the next IdleOn update. Haxe's literal strings on the other hand are not
  // mangled - class names and field names are emitted as-is because Haxe
  // reads them back by name - so those are what this keys off.
  //
  // So: trap the class registry. Haxe registers every class by its full name
  // as the bundle defines it - "z["com.stencyl.Engine"]=a;a.__name__=
  // "com.stencyl.Engine";..." (N.js, read 2026-09-28; the one assignment of
  // that key in the whole bundle, and `z` is a plain `var z={}` near the top
  // of it). That is an ordinary assignment to an ordinary object, so a
  // setter on Object.prototype for that exact key fires once, with the
  // Engine class as the value, while the bundle is still defining classes -
  // long before the game constructs its Engine. The setter re-creates the
  // registry entry as the plain own property the assignment would have
  // made (so the game keeps working exactly as before), removes itself, and
  // keeps the class; pollEngine() then picks the instance up off the
  // class's `engine` static once the constructor has set it.
  //
  // Not `gameAttributes`, the field the constructor assigns on the instance,
  // which is what this script trapped up to 0.2.1 and which never fired: the
  // Engine prototype literal itself declares that field ("...,
  // actorsToCreate:null,gameAttributes:null,savableAttributes:null,..."),
  // and an assignment that finds a writable data property on the prototype
  // chain just makes an own property on the instance - it never reaches an
  // accessor further up on Object.prototype. Haxe declares every instance
  // field that way, so no Engine instance field can be trapped like this; a
  // registry key can, because the registry is a bare object with nothing of
  // its own in the way.
  let E = null;
  let EngineClass = null; // com.stencyl.Engine itself, once the registry trap sees it

  function adopt(engine) {
    E = engine;
  }

  // Called every frame from `loop`. Compared against E rather than read once:
  // Engine.resetStatics sets `a.engine=null` (N.js), so if the game ever
  // builds a new Engine this follows it rather than holding on to the old one.
  function pollEngine() {
    const e = EngineClass && EngineClass.engine;
    if (e && e !== E && typeof e.getGameAttribute === 'function') adopt(e);
  }

  // Dev hook, not part of normal operation: tools/cdp.mjs `grab` pauses a
  // running game on its debugger, evaluates a one-liner on whichever call
  // frame has the Engine class in scope, and stashes the instance on
  // window.__ihE. That lets this script be hot-injected into a tab that is
  // long past the registry assignment the trap below waits for, with no
  // reload - a reload costs whatever minigame cooldown is running. There the
  // trap would never fire, so it isn't installed at all. On an ordinary page
  // load window.__ihE is simply never set.
  const ENGINE_KEY = 'com.stencyl.Engine';
  if (window.__ihE) {
    adopt(window.__ihE);
  } else {
    try {
      Object.defineProperty(Object.prototype, ENGINE_KEY, {
        configurable: true,
        enumerable: false,
        get() { return undefined; },
        set(v) {
          Object.defineProperty(this, ENGINE_KEY, {
            value: v, writable: true, configurable: true, enumerable: true
          });
          delete Object.prototype[ENGINE_KEY];
          if (typeof v === 'function') EngineClass = v;
        }
      });
    } catch (e) {
      // Another script already owns a non-configurable property by this name
      // on Object.prototype. Nothing to do but never attach; the panel says so.
    }
  }

  // If the trap never fires - script installed after the bundle already
  // registered its classes and no dev hook either - say so plainly rather
  // than leaving the panel silently blank forever. Once the class has been
  // seen, a missing instance only means the game is still loading.
  let neverAttached = false;
  setTimeout(() => { if (!E && !EngineClass) neverAttached = true; }, 60000);

  // ---------- config ----------
  const KEY = 'ih_cfg';
  // A hand-edited or half-written-by-a-future-version ih_cfg must not take
  // the whole UI down before a single element exists to show that error in -
  // fall back to defaults instead of letting JSON.parse throw past this point.
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { /* corrupt: use defaults */ }
  const cfg = Object.assign({
    tooltip: true,  // show the hover tooltip over storage slots
    card: true,     // show the game's OWN item card on hover - see `features: item card` for exactly what this writes
    debug: false,   // debug readout + slot/tab rect outlines
    off: false,     // user turned the panel off (F4 or the close button); storage opening still shows it unless this was set WHILE storage was open (see onKeydown)
    x: null, y: null // dragged panel position, viewport px
  }, saved);
  const save = () => localStorage.setItem(KEY, JSON.stringify(cfg));
  // Session-only mirror of "F4 forced the panel open outside of storage" -
  // deliberately never persisted, so quitting and coming back never reopens
  // a panel that was only ever open because of a keypress, not a setting.
  let forced = false;

  // ---------- game ----------
  // Thin reads over the engine's own state, plus the storage geometry read
  // out of N.js's chest click handler and draw code. Everything here is in
  // the game's own screen-unit space (960x540 before any scaling) - see
  // NOTES.md for exactly which line each number came from, and AGENTS.md for
  // why a pixel constant would be wrong the moment the window resizes.

  function ga(name) { return E ? E.getGameAttribute(name) : undefined; }

  // The only write helper in this file. `E.setGameAttribute(name,v)` does
  // exactly `this.gameAttributes.h[name]=v` (confirmed alongside
  // getGameAttribute on the Engine prototype) - the same write path the
  // game's own click handlers use directly. Every call site that uses this
  // is documented in `features: item card` below with the exact game caller
  // it mirrors; nothing else in this file writes anything.
  function sga(name, value) { if (E) E.setGameAttribute(name, value); }

  // Largest <canvas> on the page is the game; the same heuristic the sibling
  // project (idleon-clicker) uses to ignore small UI canvases layered over it.
  function gameCanvas() {
    let best = null, area = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const a = c.clientWidth * c.clientHeight;
      if (a > area) { area = a; best = c; }
    }
    return area > 160000 ? best : null;
  }

  // One bundle of everything the drawing/geometry helpers need off the DOM
  // and the engine's statics, computed once and threaded through instead of
  // each helper fetching its own. Before this, toCss() and gameMouse() each
  // ran their own querySelectorAll('canvas') + getBoundingClientRect, and
  // drawOverlay() calls something like toCss() for both corners of up to 96
  // slots plus every tab rect - close to 200 forced-layout reads a frame for
  // values that cannot change mid-frame. `cls` is Haxe's back-reference from
  // the Engine prototype to the Engine class (verified 2026-09-26: Engine's
  // own prototype literal ends "...,__class__:a}"), which is where SCALE,
  // screenScaleX/Y, screenOffsetX/Y and stage live as statics.
  function computeView() {
    if (!E) return null;
    const cls = E.__class__;
    if (!cls || !cls.stage) return null;
    const cv = gameCanvas();
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    const k = r.width / cls.stage.stageWidth; // backing-canvas-to-CSS-rect ratio (live measurement 2026-09-26: 960x540 backing, 1328x747 CSS rect, k~=1.383)
    return { cv, r, k, cls };
  }

  // The game's own mouse position, in its screen-unit space. This is the
  // exact formula Input.update uses for fa.mouseX/Y (N.js, read 2026-09-26:
  // "fa.mouseX=(a.stage.get_mouseX()-a.screenOffsetX)/a.screenScaleX"), with
  // the further "/a.SCALE" division that c.getMouseX applies on top
  // ("c.getMouseX=function(){return fa.mouseX/a.SCALE}"). Using the game's
  // own computation - not a DOM mousemove listener - is what keeps this in
  // agreement with the game about which slot is under the cursor; the
  // overlay is pointer-events:none anyway, so it would never see one.
  function gameMouse(view) {
    if (!view) return null;
    const cls = view.cls;
    return {
      x: (cls.stage.get_mouseX() - cls.screenOffsetX) / cls.screenScaleX / cls.SCALE,
      y: (cls.stage.get_mouseY() - cls.screenOffsetY) / cls.screenScaleY / cls.SCALE
    };
  }

  // Game screen units -> CSS px, for drawing on the overlay canvas. Undoes
  // the same scale/offset gameMouse() applies, then maps game-canvas pixels
  // to viewport pixels using the same per-frame view gameMouse() used, so the
  // two never disagree about the canvas rect mid-frame.
  function toCss(gx, gy, view) {
    if (!view) return null;
    const { r, k, cls } = view;
    return {
      x: r.left + (gx * cls.SCALE * cls.screenScaleX + cls.screenOffsetX) * k,
      y: r.top + (gy * cls.SCALE * cls.screenScaleY + cls.screenOffsetY) * k
    };
  }

  // MenuType2===6 while storage is open - read off the same guard the click
  // handler itself checks before doing anything with a chest click (N.js,
  // _event_Chest, read 2026-09-26: "if(1==this._GeneralINFO[81]&&6==a.engine.
  // getGameAttribute("MenuType2"))..."). Not independently verified against a
  // live session yet - that is exactly what the panel's debug readout is
  // for.
  function storageOpen() { return ga('MenuType2') === 6; }

  // 1 = compact (12x8 cells of 37 units), 0 = normal (6x4 cells of 74 units).
  // Both grids start at the same origin (154,135) in game screen units - see
  // slotAt() below for where each of those numbers comes from.
  function compactLayout() { return Number(ga('OptionsListAccount')?.[343]) === 1; }

  function selectedTab() {
    // The click handler always reads this through c.asNumber(...) before
    // using it arithmetically, which is Haxe's defensive numeric coercion -
    // kept here for the same reason: OptionsList is a mixed bag read back
    // from a save file, and a stringly-typed "2" would otherwise concatenate
    // instead of adding in `24*tab`.
    return Math.floor(Number(ga('OptionsList')?.[3])) || 0;
  }

  function itemName(id) {
    const defs = ga('ItemDefinitionsGET');
    const def = defs && defs.h[id];
    // displayName uses underscores for spaces ("Copper_Ore") - every one of
    // the 425 filled slots on the account this was checked against resolved
    // this way (2026-09-26).
    return def ? String(def.h.displayName).replace(/_/g, ' ') : String(id);
  }

  // Storage grid geometry, in game screen units. Origin (154,135) and both
  // cell sizes come straight off the chest click handler (N.js, read
  // 2026-09-26): compact branch "Math.floor((mouseX-154)/37)+12*Math.floor(
  // (mouseY-135)/37)", normal branch "Math.floor((mouseX-154)/74)+6*Math.
  // floor((mouseY-135)/74)". Both branches feed into the same
  // "v+24*tab<ChestOrder.length" bound and the same 155<mouseX<594,
  // 137<mouseY<427 outer guard - reproduced here as the bounds slotAt()
  // rejects, not re-derived, so this returns null on exactly the pixels the
  // game itself would ignore.
  //
  // The item index a slot resolves to is 24*tab+v in BOTH layouts, even
  // though compact shows 96 cells (not 24) per screen: the compact draw loop
  // iterates a 96-wide v but still offsets by 24*tab, so switching "tab" by
  // one slides the visible window by one 24-slot page inside a 96-cell view,
  // rather than paging by a full screen. That is the game's own behaviour,
  // not a guess - matched from the same draw loop that places the icons.
  function slotAt(gx, gy) {
    if (!E || gx <= 155 || gx >= 594 || gy <= 137 || gy >= 427) return null;
    const compact = compactLayout();
    const cell = compact ? 37 : 74;
    const cols = compact ? 12 : 6;
    const col = Math.floor((gx - 154) / cell);
    const row = Math.floor((gy - 135) / cell);
    const v = col + cols * row;
    const order = ga('ChestOrder');
    const index = 24 * selectedTab() + v;
    if (!order || index < 0 || index >= order.length) return null;
    return { index, v, col, row, rect: { x: 154 + cell * col, y: 135 + cell * row, w: cell, h: cell } };
  }

  // Tab button hit-rects, in game screen units - the branch of the same
  // click handler just above the slot-click branch. Three rows, each with
  // its own x origin and cell width; only Math.ceil(ChestSlotsOwned/24) of
  // them are ever clickable, so that many are returned.
  function tabRects() {
    if (!E) return [];
    const owned = Number(ga('ChestSlotsOwned')) || 0;
    const count = Math.ceil(owned / 24);
    const rects = [];
    for (let i = 0; i < count; i++) {
      if (i < 7)       rects.push({ tab: i, x: 148 + 65 * i,        y: 77, w: 65, h: 47 });
      else if (i < 14) rects.push({ tab: i, x: 148 + 65 * (i - 7),  y: 38, w: 65, h: 40 });
      else              rects.push({ tab: i, x: 148 + 35 * (i - 14), y: 0,  w: 35, h: 39 });
    }
    return rects;
  }

  // ---------- ui ----------
  // Closed shadow DOM so page scripts can't see or style any of this - the
  // same stealth-host pattern idleon-clicker.user.js uses. Appended to
  // document.documentElement, never inside the game's own container: the
  // game only attaches its window `mouseup` listener after a mousedown
  // *inside* that container (N.js), so keeping this host outside it means a
  // click on a panel control can never be mistaken for one starting on the
  // game.
  const host = document.createElement('div');
  host.dataset.ih = ''; // marks this host so tools/cdp.mjs `inject` can find and remove it on a hot-swap
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(host);

  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font: 12px/1.4 monospace; }
      #p { position: fixed; top: 12px; right: 12px; width: 280px;
           background: #14171c; color: #cdd3da; border: 1px solid #2a2f37;
           border-radius: 8px; pointer-events: auto; user-select: none;
           box-shadow: 0 6px 24px rgba(0,0,0,.5); }
      #hd { display:flex; align-items:center; justify-content:space-between;
            padding: 7px 9px; cursor: move; background:#1b1f26; border-radius:8px 8px 0 0; }
      #hd b { color:#8b95a3; font-weight:600; letter-spacing:.3px; }
      #dot { width:9px; height:9px; border-radius:50%; background:#dc2626; display:inline-block; }
      #dot.on { background:#4ade80; box-shadow:0 0 8px #4ade80; }
      .body { padding: 9px; display:flex; flex-direction:column; gap:8px; max-height:70vh; overflow:auto; }
      .row { display:flex; align-items:center; justify-content:space-between; gap:6px; }
      label { color:#8b95a3; }
      #status { color:#6b7280; font-size:11px; }
      #q { width:100%; background:#0c0e12; color:#cdd3da; border:1px solid #2a2f37;
           border-radius:4px; padding:4px 6px; font:12px monospace; }
      #summary { color:#8b95a3; font-size:11px; }
      #matches { display:flex; flex-direction:column; gap:2px; max-height:220px; overflow:auto; }
      .m { display:flex; justify-content:space-between; gap:6px; padding:2px 4px;
           border-radius:3px; background:#1b1f26; }
      .m .n { color:#cdd3da; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .m .q { color:#4ade80; flex:none; }
      .m .t { color:#6b7280; flex:none; }
      #dbg { display:flex; flex-direction:column; gap:2px; color:#8b95a3; font-size:11px;
             border-top:1px solid #2a2f37; padding-top:6px; }
      .hint { color:#4b5563; font-size:11px; text-align:center; }
      input[type=checkbox] { accent-color: #2563eb; }
      #nub { position: fixed; top: 6px; right: 6px; width: 13px; height: 13px;
             border-radius: 50%; background: #2563eb; opacity: .55; cursor: pointer;
             pointer-events: auto; display: none; }
      #nub:hover { opacity: 1; }
      #close { background: none; border: 0; color: #8b95a3; cursor: pointer;
               font: 14px/1 monospace; padding: 0 2px; }
      #close:hover { color: #cdd3da; }
    </style>
    <div id="nub" title="Show IdleOn Helper"></div>
    <div id="p">
      <div id="hd"><span><span id="dot"></span> <b>IdleOn Helper</b></span><button id="close" title="Hide" tabindex="-1">×</button></div>
      <div class="body">
        <div id="status">attaching...</div>
        <input id="q" type="text" placeholder="search storage..." autocomplete="off" spellcheck="false">
        <div id="summary"></div>
        <div id="matches"></div>
        <div class="row"><label><input type="checkbox" id="ctooltip" tabindex="-1"> Tooltip</label></div>
        <div class="row"><label><input type="checkbox" id="ccard" tabindex="-1"> Item card on hover</label></div>
        <div class="row"><label><input type="checkbox" id="cdebug" tabindex="-1"> Debug</label></div>
        <div id="dbg" style="display:none"></div>
        <div class="hint">F4 toggle</div>
      </div>
    </div>
    <canvas id="ov" style="position:fixed;pointer-events:none"></canvas>
    <div id="tip" style="position:fixed;pointer-events:none;display:none;
         background:rgba(20,20,24,.92);color:#fff;padding:3px 7px;border-radius:4px;
         font:12px monospace;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.5)"></div>`;

  const $ = s => root.querySelector(s);
  const panel = $('#p'), dot = $('#dot'), statusEl = $('#status'), nub = $('#nub'),
        closeBtn = $('#close'), qEl = $('#q'), summaryEl = $('#summary'), matchesEl = $('#matches'),
        ctooltip = $('#ctooltip'), ccard = $('#ccard'), cdebug = $('#cdebug'), dbgEl = $('#dbg'),
        overlayCv = $('#ov'), tipEl = $('#tip');
  const octx = overlayCv.getContext('2d');

  // Remembered panel position, same convention as idleon-clicker: stored in
  // the same config blob everything else lives in, clamped on the way in so
  // a position saved on a wider window never puts the panel off-screen.
  if (cfg.x != null && cfg.y != null) {
    const w = 280, h = 40;
    panel.style.right = 'auto';
    panel.style.left = Math.max(0, Math.min(cfg.x, window.innerWidth - w)) + 'px';
    panel.style.top = Math.max(0, Math.min(cfg.y, window.innerHeight - h)) + 'px';
  }

  // ---------- drag ----------
  // Named (not the anonymous-closure-in-an-IIFE this used to be) so teardown()
  // can remove the two window-level listeners below when a hot-swap replaces
  // this script - see the `loop` section for why that matters.
  let dragDX = 0, dragDY = 0, dragging = false;
  // Whether a mouse button is currently held anywhere on the page - read by
  // the item-card feature below (a card should not pop up mid-press, e.g.
  // while the player is dragging something), reset here because this is
  // already the window `mouseup` listener and a second one would be
  // redundant.
  let mouseDown = false;
  function onDragMove(e) {
    if (!dragging) return;
    panel.style.left = (e.clientX - dragDX) + 'px';
    panel.style.top = (e.clientY - dragDY) + 'px';
  }
  function onDragEnd() {
    mouseDown = false;
    if (!dragging) return;
    dragging = false;
    const r = panel.getBoundingClientRect();
    cfg.x = Math.round(r.left); cfg.y = Math.round(r.top);
    save();
  }
  $('#hd').addEventListener('mousedown', e => {
    dragging = true; const r = panel.getBoundingClientRect();
    dragDX = e.clientX - r.left; dragDY = e.clientY - r.top;
    panel.style.right = 'auto';
  });
  window.addEventListener('mousemove', onDragMove);
  // Capture, not bubble: lime's handleMouseEvent calls stopPropagation() on
  // a mouseup at its own container (N.js: `case "mouseup": ...
  // a.currentTarget==this.parent.element&&a.stopPropagation()`), so a
  // bubble-phase window listener never hears a release over the game. That
  // left mouseDown stuck true after the first click in the game - and with
  // it the item card never opening again - and a panel drag released over
  // the canvas never ending.
  window.addEventListener('mouseup', onDragEnd, true);

  // Every control that isn't the search field stays out of the tab order and
  // drops focus the moment it's released - same rule as idleon-clicker,
  // for the same reason: the minigames are played with the keyboard, and a
  // focused button re-fires on the next Space the player means for the game.
  root.querySelectorAll('input[type=checkbox], button').forEach(el => {
    el.addEventListener('mouseup', () => el.blur());
  });
  // The close button sits inside the draggable title bar; without this its
  // mousedown would bubble to #hd's own listener above and start a drag
  // instead of registering as a click.
  closeBtn.addEventListener('mousedown', e => e.stopPropagation());
  closeBtn.addEventListener('click', () => { cfg.off = true; save(); syncPanelVisibility(); });

  // The search field is the one control that is SUPPOSED to hold focus.
  // Every key that reaches it must never also reach the game - the game's
  // only key listeners are on `window` in the bubble phase (N.js
  // handleKeyEvent), so stopping propagation here at the shadow-internal
  // input is enough; nothing upstream of it ever sees the keystroke.
  qEl.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { if (qEl.value) { qEl.value = ''; onQueryChange(); } else qEl.blur(); }
    else if (e.key === 'Enter') qEl.blur();
  });
  qEl.addEventListener('keyup', e => e.stopPropagation());
  qEl.addEventListener('keypress', e => e.stopPropagation());
  qEl.addEventListener('input', onQueryChange);

  ctooltip.addEventListener('change', () => { cfg.tooltip = ctooltip.checked; save(); });
  ccard.addEventListener('change', () => {
    cfg.card = ccard.checked; save();
    // Turning it off mid-hover must not stand up a card and then never take
    // it down again - closeOurCard() is a no-op when there is nothing to close.
    if (!cfg.card) closeOurCard();
  });
  cdebug.addEventListener('change', () => { cfg.debug = cdebug.checked; save(); syncPanelVisibility(); });

  nub.addEventListener('mouseup', () => nub.blur());
  // A click on the nub is a request to see the panel now, so it forces it the
  // way F4 does - otherwise, with storage closed, the nub would vanish and
  // nothing would appear in its place.
  nub.onclick = () => { cfg.off = false; forced = true; save(); syncPanelVisibility(); };

  // ---------- window-level safety listeners ----------
  // Two unrelated fixes share this one mousedown listener rather than each
  // getting their own, since both need to run before anything else sees the
  // press:
  //
  // 1. Verified in N.js handleMouseEvent: lime calls preventDefault() on a
  //    mousedown whenever the game itself cancels the event, and that
  //    suppresses the browser's normal "move focus to whatever was clicked"
  //    behaviour. So clicking from the search box back into the game can
  //    leave the box focused with no visible sign of it - and because the box
  //    stops key propagation by design (so a query never reaches the game),
  //    the very next Space meant for a minigame goes into the search box
  //    instead of the game. Force the blur ourselves on any mousedown that
  //    didn't land in our own UI. e.target here is already retargeted to
  //    `host` for anything that happened inside the closed shadow root
  //    (composed-event retargeting), so this only ever fires for a click that
  //    actually left it.
  // 2. Verified in N.js: _event_ChestItem only treats a mouse RELEASE as a
  //    Quick-Tap-off storage tap when ShowItemDescriptionBox is already 0 -
  //    and that flag stays 2 until 50ms after whatever closes a card. Left
  //    alone, a press landing on a slot while OUR item card is open would be
  //    silently swallowed instead of registering as a tap. Close it
  //    pre-emptively, here, before the game's own listener (on its container,
  //    not window) ever sees the press - see `features: item card` for
  //    closeOurCard()/suppressIndex.
  function onWindowMousedown(e) {
    mouseDown = true;
    if (e.target !== host && root.activeElement === qEl) qEl.blur();
    if (card) { suppressIndex = card.index; closeOurCard(); }
  }
  window.addEventListener('mousedown', onWindowMousedown, true);

  function onWindowBlur() { mouseDown = false; }
  window.addEventListener('blur', onWindowBlur);

  // gameMouse() reads the game's own idea of the mouse position, which
  // freezes at wherever the pointer last was inside the game canvas - the
  // game has no way to know the pointer left, or moved onto our panel,
  // because our overlay/tooltip are pointer-events:none and our panel lives
  // outside the game's own container. Left unchecked, the tooltip would keep
  // pointing at the last hovered slot forever once the mouse left the canvas.
  // Tracked here from a real DOM mousemove instead, against whichever element
  // is currently the largest canvas (refreshed once a frame in frame() below).
  let overGame = false;
  let gameCv = null;
  function onMousemoveTrack(e) { overGame = e.target === gameCv; }
  window.addEventListener('mousemove', onMousemoveTrack, { capture: true, passive: true });

  // ---------- features: search ----------
  // Recomputed from ChestOrder/ChestQuantity regardless of whether storage
  // is open - the panel's list works any time the engine is attached. Only
  // the overlay drawing (dim/outline on the game canvas) additionally
  // requires storageOpen(), since there is nothing on screen to draw over
  // otherwise.
  let query = '';
  let matches = [];      // [{index, tab, name, qty}]
  let matchSet = new Set(); // indices, for an O(1) check per visible slot while drawing

  // itemName()+toLowerCase() per slot, called from here at up to 10 Hz across
  // (for this account) 480 slots, would be 4800+ string ops/sec for no
  // reason - the display name of a given item id never changes mid-session.
  // Cached by id, and the whole cache is thrown away only if
  // ItemDefinitionsGET itself is ever a different object (a fresh attach, or
  // - in principle - a reload of the item database), not on every query
  // keystroke.
  let nameCache = null, nameCacheDefs = null;
  function cachedName(id) {
    const defs = ga('ItemDefinitionsGET');
    if (defs !== nameCacheDefs) { nameCache = new Map(); nameCacheDefs = defs; }
    let e = nameCache.get(id);
    if (!e) { const name = itemName(id); e = { name, lname: name.toLowerCase() }; nameCache.set(id, e); }
    return e;
  }

  function recomputeMatches() {
    const order = ga('ChestOrder'), qty = ga('ChestQuantity');
    matches = [];
    matchSet = new Set();
    if (!order || !query) return;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      if (id === 'Blank' || id === 'LockedInvSpace') continue;
      const { name, lname } = cachedName(id);
      if (!terms.every(t => lname.includes(t))) continue;
      matches.push({ index: i, tab: Math.floor(i / 24), name, qty: Number(qty && qty[i]) || 0 });
      matchSet.add(i);
    }
  }

  function onQueryChange() {
    query = qEl.value;
    recomputeMatches();
    renderMatches();
  }

  // Recomputed on a timer too, at most ~10x/s: quantities and even
  // ChestOrder itself can change under a static query (picking something up,
  // switching characters mid-session), and re-running the same filter every
  // frame would be pure waste for a list that changes far less often than
  // that. Reference kept so teardown() can stop it on a hot-swap - see `loop`.
  const matchTimer = setInterval(() => { if (query) { recomputeMatches(); renderMatches(); } }, 100);

  function renderMatches() {
    if (!query) { summaryEl.textContent = ''; matchesEl.innerHTML = ''; return; }
    if (!matches.length) { summaryEl.textContent = 'no matches'; matchesEl.innerHTML = ''; return; }
    const tabs = [...new Set(matches.map(m => m.tab + 1))].sort((a, b) => a - b);
    summaryEl.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'} · tab${tabs.length === 1 ? '' : 's'} ${tabs.join(', ')}`;
    matchesEl.innerHTML = matches.slice(0, 15).map(m =>
      `<div class="m"><span class="n">${escapeHtml(m.name)}</span><span class="q">${m.qty.toLocaleString()}</span><span class="t">tab ${m.tab + 1}</span></div>`
    ).join('');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- features: overlay (search dim/outline + debug rects) ----------
  // Dark ink + light halo throughout, never a bright/neon color: this game's
  // backgrounds run light and outdoors, and a neon stroke that reads fine in
  // a screenshot vanishes against them in play.
  function haloRect(ctx, x, y, w, h, darkW, haloW) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = haloW; ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(20,20,24,.9)'; ctx.lineWidth = darkW; ctx.strokeRect(x, y, w, h);
  }

  function haloText(ctx, text, x, y) {
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = 'rgba(20,20,24,.95)'; ctx.fillText(text, x, y);
  }

  function drawOverlay(view) {
    if (!E || !view || !storageOpen()) { octx.clearRect(0, 0, overlayCv.width, overlayCv.height); return; }

    const r = view.r;
    overlayCv.style.left = r.left + 'px'; overlayCv.style.top = r.top + 'px';
    overlayCv.style.width = r.width + 'px'; overlayCv.style.height = r.height + 'px';
    if (overlayCv.width !== Math.round(r.width) || overlayCv.height !== Math.round(r.height)) {
      overlayCv.width = Math.round(r.width); overlayCv.height = Math.round(r.height);
    }
    octx.clearRect(0, 0, overlayCv.width, overlayCv.height);

    const searching = query.length > 0;
    if (!searching && !cfg.debug) return;

    // g2px: a game-screen-unit point to a pixel local to the overlay canvas
    // (toCss() returns viewport px; the overlay is positioned exactly over
    // the game canvas, so subtracting its own rect origin lands in its own
    // pixel space).
    const g2px = (gx, gy) => { const p = toCss(gx, gy, view); return p && { x: p.x - r.left, y: p.y - r.top }; };

    const compact = compactLayout();
    const cell = compact ? 37 : 74, cols = compact ? 12 : 6, rows = compact ? 8 : 4;
    const tab = selectedTab();
    const order = ga('ChestOrder');

    // Debug's thin alignment outline and search's dim/highlight are
    // independent layers - both can be on at once, so debug draws first
    // (thin, low-contrast) and search draws over it (louder), rather than
    // one silently suppressing the other.
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const v = col + cols * row;
        const index = 24 * tab + v;
        if (!order || index >= order.length) continue;
        const a = g2px(154 + cell * col, 135 + cell * row);
        const b = g2px(154 + cell * (col + 1), 135 + cell * (row + 1));
        if (!a || !b) continue;
        const w = b.x - a.x, h = b.y - a.y;
        if (cfg.debug) haloRect(octx, a.x + 1, a.y + 1, w - 2, h - 2, 1, 2); // thin: alignment check only
        if (searching) {
          if (matchSet.has(index)) haloRect(octx, a.x + 2, a.y + 2, w - 4, h - 4, 2, 4);
          else { octx.fillStyle = 'rgba(10,10,14,.55)'; octx.fillRect(a.x, a.y, w, h); }
        }
      }
    }

    const perTab = new Map();
    if (searching) for (const m of matches) perTab.set(m.tab, (perTab.get(m.tab) || 0) + 1);
    for (const tr of tabRects()) {
      const a = g2px(tr.x, tr.y), b = g2px(tr.x + tr.w, tr.y + tr.h);
      if (!a || !b) continue;
      if (cfg.debug) haloRect(octx, a.x, a.y, b.x - a.x, b.y - a.y, 1, 2);
      const n = perTab.get(tr.tab);
      if (n) haloText(octx, String(n), b.x - 8, a.y + 8);
    }
  }

  // ---------- features: tooltip ----------
  function updateTooltip(view) {
    // !overGame: gameMouse() reports the game's own last-known mouse
    // position, which does not update once the pointer has left the canvas
    // or moved onto our panel - see the `onMousemoveTrack` listener above for
    // why that would otherwise leave this tooltip stuck over a stale slot.
    // `card`: our own item card sits right over the cursor once it's open, so
    // the text tooltip would just double up on top of it - hidden only for
    // OUR card, not for one the player opened themselves (this function has
    // no way to tell those apart cheaply, and doesn't need to: `card` is only
    // ever non-null while we're the ones who asked for one).
    if (!cfg.tooltip || !E || !view || !storageOpen() || !overGame || card) { tipEl.style.display = 'none'; return; }
    const gm = gameMouse(view);
    if (!gm) { tipEl.style.display = 'none'; return; }
    const slot = slotAt(gm.x, gm.y);
    const order = ga('ChestOrder'), qty = ga('ChestQuantity');
    if (!slot || !order) { tipEl.style.display = 'none'; return; }
    const id = order[slot.index];
    if (id === 'Blank' || id === 'LockedInvSpace' || id == null) { tipEl.style.display = 'none'; return; }
    const n = Number(qty && qty[slot.index]) || 0;
    tipEl.textContent = `${itemName(id)} ×${n.toLocaleString()}`;
    const cssMouse = toCss(gm.x, gm.y, view);
    if (!cssMouse) { tipEl.style.display = 'none'; return; }
    tipEl.style.display = '';
    let x = cssMouse.x + 14, y = cssMouse.y + 14;
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    if (x + tw > window.innerWidth) x = cssMouse.x - tw - 14;
    if (y + th > window.innerHeight) y = cssMouse.y - th - 14;
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  }

  // ---------- features: item card ----------
  // This is the project's first write to game state. The scope is exactly
  // one thing: the same transient UI request the game's own storage tap
  // handler (`_event_ChestItem`, used when Quick Tap is off) makes to open
  // its OWN item card, reproduced field-for-field - and, symmetrically, the
  // same close the game's own click-on-card handler performs. Nothing here
  // ever touches ChestOrder, ChestQuantity, ChestMap or anything else that
  // gets saved; see README for the exact list and NOTES.md's "item card
  // protocol" section for the full trace through N.js this was built from.
  //
  // `card` is null, or {index, id, actor} for the card WE currently have
  // open - id and index are recorded so a hover that just landed back on the
  // same still-unchanged slot doesn't re-issue the request, and so a change
  // underneath it (the slot's contents changed, or the hover moved off) is
  // noticed even before the game gets around to telling us its own state
  // changed. `suppressIndex` is the one slot we must NOT reopen a card over
  // on the very next hover frame - set whenever WE just closed one, whether
  // because the game beat us to it or because we pre-empted a click - so
  // closing a card by moving the mouse off it, or by clicking it, doesn't
  // instantly spawn a new one on the same hover.
  let card = null, suppressIndex = null;

  // D.copyMap in N.js (`D` is one of the unstable single-letter class
  // variables, so this is our own equivalent, not a call to it - see
  // NOTES.md): a shallow copy into a FRESH StringMap. The copy matters:
  // ChestMap[i] is the account's own saved per-slot metadata, and openCard()
  // below adds a key to whatever map ends up in ItemMapToDisplayStats
  // (SuperFunItemDisplayType) - writing that key onto the original
  // ChestMap[i] instead would leave a UI-only flag sitting in saved state.
  // Built off E.gameAttributes's own class, not src.constructor: ChestMap
  // entries can report a plain `Object` constructor (verified live,
  // 2026-09-26), where E.gameAttributes is always a real StringMap.
  function copyStringMap(src) {
    const StringMap = E.gameAttributes.__class__;
    const dst = new StringMap();
    if (src && src.h) for (const k of Object.keys(src.h)) dst.h[k] = src.h[k];
    return dst;
  }

  // Type-38 actors serve more than one popup in this game; ActorEvents_38's
  // own _PixelType field (read, never written, here) is what the game's own
  // draw code uses to tell the item card (5) apart from anything else that
  // shares the actor type. `.recycled` marks one the game has already torn
  // down but not yet dropped from the array - both verified live, 2026-09-26.
  function findCardActor() {
    const arr = E.actorsOfType && E.actorsOfType.h && E.actorsOfType.h[38];
    if (!arr) return null;
    for (const a of arr) {
      if (!a || a.recycled) continue;
      const beh = a.behaviors && a.behaviors.getBehavior('ActorEvents_38');
      if (beh && beh._PixelType === 5) return a;
    }
    return null;
  }

  // Field-for-field the same write _event_ChestItem makes for a storage tap
  // with Quick Tap off (N.js, read 2026-09-26): ShowItemDescriptionBox=1,
  // ItemToDisplayStats=""+ChestOrder[i], ItemMapToDisplayStats=a copy of
  // ChestMap[i] with SuperFunItemDisplayType="Inventory" added, and the
  // quantity written onto the PixelHelperActor[0]/ActorEvents_29 behavior's
  // own _ScrollCircleINFO[59] - that one is not a gameAttribute at all, so it
  // is written directly rather than through sga(). ShowItemDescriptionBox is
  // set LAST: it's the flag _event_LASTUPDATEitembox polls for every frame to
  // spawn the card, so everything the card will read has to already be in
  // place before the game can ever see it flip to 1.
  function openCard(i) {
    const order = ga('ChestOrder'), qty = ga('ChestQuantity'), map = ga('ChestMap');
    if (!order || i < 0 || i >= order.length) return;
    const beh = ga('PixelHelperActor')?.[0]?.behaviors?.getBehavior('ActorEvents_29');
    if (!beh || !beh._ScrollCircleINFO) return; // can't place the quantity - don't open a half-built card
    const copy = copyStringMap(map && map[i]);
    copy.h.SuperFunItemDisplayType = 'Inventory';
    sga('ItemToDisplayStats', '' + order[i]);
    sga('ItemMapToDisplayStats', copy);
    beh._ScrollCircleINFO[59] = qty ? qty[i] : 0;
    sga('ShowItemDescriptionBox', 1);
    card = { index: i, id: order[i], actor: null };
  }

  // The mirror of openCard(): only ever closes a card THIS script opened.
  // Recycling the actor ourselves (E.recycleActor is the same call the
  // game's own close path makes) and zeroing the flag covers both a card
  // that has already spawned (flag 2) and one still pending from the same
  // frame it was requested (flag 1, no actor yet) - either way, nothing is
  // left for the game to spawn a moment later off a request we no longer
  // want honored.
  function closeOurCard() {
    if (!card) return;
    let actor = card.actor;
    if (!actor && ga('ShowItemDescriptionBox') === 2) actor = findCardActor();
    if (actor && !actor.recycled) E.recycleActor(actor);
    sga('ShowItemDescriptionBox', 0);
    card = null;
  }

  // Runs once a frame, BEFORE updateTooltip - so on the very frame a card
  // opens or closes, updateTooltip's own `card` check already sees this
  // frame's result instead of last frame's, which is what keeps the two from
  // both being visible at once for a frame. `!mouseDown`: a card should not
  // pop up mid-press (set and cleared by the window mousedown/mouseup/blur
  // listeners above); a press already pre-empts and closes any card of ours
  // regardless, via onWindowMousedown, so this only prevents opening a NEW
  // one before the release.
  function updateCard(view) {
    const gm = cfg.card && storageOpen() && overGame && !mouseDown && view ? gameMouse(view) : null;
    const slot = gm && slotAt(gm.x, gm.y);
    const order = ga('ChestOrder');
    let target = null;
    if (slot && order) {
      const id = order[slot.index];
      if (id !== 'Blank' && id !== 'LockedInvSpace' && id != null) target = slot.index;
    }
    if (target !== suppressIndex) suppressIndex = null;

    if (card) {
      const flag = ga('ShowItemDescriptionBox');
      if ((card.actor && card.actor.recycled) || (flag !== 1 && flag !== 2)) {
        // The game closed it on its own (a click on the card, or anywhere
        // else that ends up clearing the flag) - just catch up our
        // bookkeeping. Never write ShowItemDescriptionBox here: by the time
        // this runs it may already be a DIFFERENT request the player made
        // themselves.
        suppressIndex = card.index;
        card = null;
      } else if (target !== card.index || !order || order[card.index] !== card.id) {
        closeOurCard();
      } else if (!card.actor && flag === 2) {
        card.actor = findCardActor();
      }
    }

    // Only ever opens when the flag is exactly 0 - i.e. nothing else, ours or
    // the player's own click, currently has a request in flight - so this
    // never stomps a card the player opened themselves (an inventory item,
    // say, which shares the same flag).
    if (!card && target != null && target !== suppressIndex && ga('ShowItemDescriptionBox') === 0) {
      openCard(target);
    }
  }

  // ---------- panel sync ----------
  // `forced`: F4 asked for the panel outside of storage being open (session-
  // only, see its declaration in `config`). `cfg.off`: the user's own
  // standing preference, and it beats everything - while it is set only the
  // nub shows, storage open or not. See onKeydown for how each gets set.
  function syncPanelVisibility() {
    const show = !cfg.off && (storageOpen() || forced);
    panel.style.display = show ? '' : 'none';
    nub.style.display = cfg.off ? '' : 'none';
  }

  function syncStatus() {
    dot.classList.toggle('on', !!E);
    statusEl.textContent = E ? 'attached'
      : neverAttached ? 'not attached — install at document-start and reload the game'
      : 'attaching...';
  }

  function syncDebug(view) {
    dbgEl.style.display = cfg.debug ? '' : 'none';
    if (!cfg.debug) return;
    const gm = view && gameMouse(view);
    const slot = gm && slotAt(gm.x, gm.y);
    dbgEl.innerHTML = [
      `MenuType ${ga('MenuType')}`,
      `MenuType2 ${ga('MenuType2')}`,
      `tab ${selectedTab()} compact ${compactLayout() ? 1 : 0}`,
      `mouse ${gm ? gm.x.toFixed(1) + ', ' + gm.y.toFixed(1) : '-'}`,
      `hovered index ${slot ? slot.index : '-'}`
    ].map(s => `<div>${escapeHtml(s)}</div>`).join('');
  }

  ctooltip.checked = cfg.tooltip;
  ccard.checked = cfg.card;
  cdebug.checked = cfg.debug;

  // ---------- hotkeys ----------
  // F4 forces the panel open (and focuses search) or hides it again. Capture
  // phase, same as idleon-clicker's F8/F9/F10, so it works even while some
  // other element in the page happens to have focus.
  //
  // If storage is open, the panel is already showing itself regardless of
  // `off` - so hiding it here has to mean something: set `off` so it stays
  // hidden until the user asks for it again, even across storage
  // closing/reopening. If storage is closed, the panel was only showing
  // because a previous F4 set `forced`; toggling that back off is enough to
  // hide it again, with nothing persisted (there was never a standing
  // preference to record - just "show it right now").
  function onKeydown(e) {
    if (e.key !== 'F4') return;
    e.preventDefault();
    const shown = !cfg.off && (storageOpen() || forced);
    if (shown) {
      if (storageOpen()) cfg.off = true;
      forced = false;
    } else {
      cfg.off = false;
      forced = true;
    }
    save();
    syncPanelVisibility();
    if (!cfg.off && (storageOpen() || forced)) qEl.focus();
  }
  window.addEventListener('keydown', onKeydown, true);

  // ---------- loop ----------
  // A hot-swap (tools/cdp.mjs `inject`) replaces this whole script by
  // removing every [data-ih] element and evaluating a fresh copy - but
  // removing the DOM node does nothing on its own to the previous copy's
  // rAF loop, its window-level listeners, its match-search timer, or an item
  // card it left open, all of which would otherwise keep running (or sitting
  // open) forever underneath the new one. So the loop polices its own host:
  // the first frame after `host` is no longer in the document, it tears down
  // everything this script attached outside its own shadow root and stops
  // rescheduling itself. After that only the newest generation of the script
  // is doing anything.
  function teardown() {
    closeOurCard(); // never leave a card open behind a generation that's gone
    window.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd, true);
    window.removeEventListener('mousedown', onWindowMousedown, true);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('mousemove', onMousemoveTrack, true);
    clearInterval(matchTimer);
  }

  function frame() {
    if (!host.isConnected) { teardown(); return; }
    pollEngine();
    const view = computeView();
    gameCv = view ? view.cv : null; // refresh what onMousemoveTrack compares against
    syncStatus();
    syncPanelVisibility();
    syncDebug(view);
    drawOverlay(view);
    updateCard(view);
    updateTooltip(view);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

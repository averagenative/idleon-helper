# IdleOn Helper

A Tampermonkey/Violentmonkey userscript for the browser version of
[Legends of IdleOn](https://www.legendsofidleon.com/). Unlike the sibling
[idleon-clicker](https://github.com/averagenative/idleon-userscripts)
project, this one doesn't look at pixels - it reads the game's own in-memory
state directly, so it always knows exactly what the game knows.

It's read-only except for one optional feature (the item card, below), which
writes nothing but a transient UI request the game already makes on its own -
see "What it writes" for exactly what that means and doesn't mean.

## What it does

- **Storage tooltip**: hover an item in your storage chest and see its name
  and exact quantity next to the cursor.
- **Item card on hover** (togglable, on by default): hover a slot and the
  game's own item card - the same one a tap normally opens - appears without
  you having to click. Moving off, or clicking anything, closes it exactly
  like a normal tap would.
- **Storage search**: type in the panel and it dims every non-matching slot,
  outlines every match, and badges each tab that has one - across your whole
  storage, not just the tab you're looking at. Works even with storage
  closed; only the on-screen highlighting needs it open.
- A small debug readout (togglable) for confirming the game's own menu-state
  and coordinate values match what this script assumes.

## Using it

- The panel appears by itself while storage is open, and goes away when you
  close it.
- **F4** opens the panel anywhere and puts the cursor in the search box, so you
  can look something up without walking to storage. Press it again to hide.
- **×** in the panel's title bar turns it off entirely, storage included.
  A small blue dot stays in the top-right corner; click it (or press F4) to
  bring the panel back.
- In the search box, **Esc** clears the text (a second Esc leaves the box) and
  **Enter** leaves the box. Keys you type there never reach the game, and
  clicking back into the game always takes the cursor out of the box.

## What it reads

Only `Engine.getGameAttribute(...)` (`ChestOrder`, `ChestQuantity`,
`ChestSlotsOwned`, `ItemDefinitionsGET`, `OptionsList`, `OptionsListAccount`,
`MenuType`/`MenuType2`) and mouse/canvas geometry off the Engine's own static
fields. See `NOTES.md` for exactly which line of the game's client code each
value and constant came from.

## What it writes

Everything except the item card feature writes nothing to the game.

The item card writes exactly the request the game's own storage-tap handler
(`_event_ChestItem`, used when Quick Tap is off) makes to open its own item
card - five values, all transient UI state, none of it saved: `ShowItemDescriptionBox`,
`ItemToDisplayStats`, `ItemMapToDisplayStats` (a *copy* of the slot's own
metadata, with one added display flag - the original is never touched), and
the quantity, written onto a UI actor's own field the same way the game's
handler does. Turning the feature's hover off, moving off the slot, or
clicking anywhere closes the card by clearing the same flag and removing the
card actor - the same way clicking an open card does. It never writes
`ChestOrder`, `ChestQuantity`, `ChestMap`, or anything else the game saves,
and it never closes a card you opened yourself by clicking it normally.

It also writes one `localStorage` key (`ih_cfg`) on your own browser, holding
panel position and your tooltip/card/debug toggles.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open
   [idleon-helper.user.js](https://raw.githubusercontent.com/averagenative/idleon-helper/main/idleon-helper.user.js)
   and the extension offers to install it. Updates come from the same URL.
3. The script runs at `document-start`, so it only takes effect from the
   *next* time the game page loads - install it between runs, not while a
   minigame is in progress, since reloading the tab to pick up a change costs
   whatever cooldown that minigame is on.

## Warning

This reads values out of the running game client's memory that the game
itself doesn't expose through any normal UI, and it hooks the page before the
game loads in order to do so. Doing this, and modifying a game client in
general, may violate IdleOn's terms of service. Use at your own risk.

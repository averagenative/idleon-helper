#!/usr/bin/env bash
# Pulls the game's own compiled client source down for reading - this is how
# cache/N.js (gitignored; ~26 MB, Closure-compiled Haxe/OpenFL output) gets
# populated. Never write to it, never eval it: it is reference material for
# finding attribute names, event handlers and geometry constants, nothing
# more. Re-run this after an IdleOn update if a lookup in NOTES.md stops
# matching what's live - local var names (a, c, z, fa, ...) get reshuffled by
# every rebuild, but field names and event/behaviour names like
# "_event_Chest" do not, so most of NOTES.md should still apply; re-grep to
# confirm the line numbers.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p cache
curl -fsSL 'https://www.legendsofidleon.com/ytGl5oc/N.js' -o cache/N.js
echo "wrote cache/N.js ($(wc -c < cache/N.js) bytes)"

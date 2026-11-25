---
"@moonshot-ai/pi-tui": minor
---

Sync with upstream v1.6.1 plus main commit `b882d08f3` (2026-11-25): return read-only line arrays from component rendering and reuse cached layout output on scroll-only fullscreen frames, add viewport input capture for focused non-overlay components such as selection lists and autocomplete menus, add block-level markdown render caching, strip HTML comments, and fall back to raw source when rendered display math exceeds content width, preserve Kitty images across fullscreen redraws and hide images under overlays, add an opt-in SIGTSTP suspend-signal hook while the terminal is owned, deduplicate non-consecutive editor history entries, keep Enter from submitting inside path and argument completion menus, support Kitty F1–F12 keys and `ESC+CR` Shift+Enter, and skip duplicate synthetic right-click paste in Tabby on Windows while retaining all local patches.

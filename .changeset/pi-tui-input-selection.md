---
"@moonshot-ai/pi-tui": patch
---

Add an optional shared selection-editing contract for editors, single-line inputs, and fullscreen search. Map logical UTF-16 offsets to visual columns and back so normal and out-of-bounds drags, triple clicks, and select-all use complete logical text, with highlights reprojected as horizontal scroll changes. Share copying, deletion, replacement by printable input or Kitty/bracketed paste, and drag caret tracking across editors and search inputs. Clear selections immediately on single click or arrow-key movement.

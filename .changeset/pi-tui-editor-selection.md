---
"@moonshot-ai/pi-tui": minor
---

Add optional editor selection editing that maps rendered rows to logical text offsets for triple-click line selection, select-all, and container-provided copy, deletion, and replacement. Keep it disabled by default, follow the active drag endpoint only in the focused editor, and retain clamped logical selections outside the editor. Clamp selection visuals to padding and borders, and fix select-all scrolling at the endpoint. Exit history navigation and refresh autocomplete when dragging moves the caret. Preserve undo through selection edits, and clean up and renumber the paste registry when paste markers are deleted.

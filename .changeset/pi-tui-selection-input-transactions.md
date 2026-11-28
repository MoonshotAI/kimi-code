---
"@moonshot-ai/pi-tui": patch
---

Commit selection edits through a shared component transaction that decodes complete input blocks, preserves explicit keybindings, and records one undo step for typing and bracketed paste. Expand partial paste-marker selections to atomic ranges and retain registry entries referenced by surviving markers.

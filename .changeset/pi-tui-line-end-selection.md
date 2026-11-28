---
"@moonshot-ai/pi-tui": patch
---

Clamp mouse selection endpoints beyond rendered line content to the content boundary, using soft-wrap metadata, the last visible non-whitespace cell, search input visibility, or editor visual-line layout, and clip every selected row to that boundary so unselected virtual padding cannot create selections or highlights. Render one virtual cell for each selected logical editor newline and for an active endpoint at the next line's content start without changing copied or deleted offsets.

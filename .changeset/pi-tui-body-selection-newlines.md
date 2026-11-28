---
"@moonshot-ai/pi-tui": patch
---

Read-only body selections render hard newlines and selected blank lines as one highlighted cell at the real line end or first selectable content column. Marker placement uses the same soft-wrap boundary decisions as copying, accounts for scroll-view coordinates and decoration exclusions, and is suppressed where a visible scrollbar or scroll-to-end prompt occupies the cell so UI is never highlighted. Dragging from virtual blank space adds only the real line-end cell; copied text, focus, the bottom editor, and hardware cursor behavior remain unchanged.

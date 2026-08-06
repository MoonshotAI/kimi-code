---
"@moonshot-ai/pi-tui": patch
---

fix(pi-tui): avoid spurious viewport scroll jumps from idle cursor repositioning

Prevent unnecessary ANSI cursor sequence writes when the cursor hasn't moved,
fixing viewport scroll jumps on Kitty keyboard protocol terminals.

---
"@moonshot-ai/pi-tui": patch
---

Reuse the processed output of unchanged lines across frames so a steady-state frame only pays for the lines that actually changed, instead of re-processing the whole transcript on every spinner tick and streaming flush.

---
"@moonshot-ai/kimi-code": patch
---

TUI: detect external wire-journal appends even when a turn's response or tool output exceeds 64 KiB. `readWireTurnBoundaryTime` now scans backward past the tail read window to locate the newest `turn.prompt` boundary, so the staleness guard no longer fails open for large external appends.

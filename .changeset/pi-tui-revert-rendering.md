---
"@moonshot-ai/pi-tui": patch
---

Revert the fork's viewport and scrollback rendering patches, restoring the upstream differential-rendering behavior. The narrow-terminal fixes (width clamping, overwide-line truncation) are kept.

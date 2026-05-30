---
"@moonshot-ai/kimi-code": patch
---

Fix a crash in the `/sessions` picker on very narrow terminals (`Rendered line exceeds terminal width`). Long session ids, the inline time / `(current)` badge, and long prompts could be drawn past the terminal edge; every rendered line is now clamped to the terminal width so the picker degrades gracefully instead of crashing.

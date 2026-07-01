---
"@moonshot-ai/kimi-code": patch
---

fix(tui): prevent viewport jump when thinking finalizes above viewport

When ThinkingComponent transitions from live to finalized above the viewport, its line count change triggers pi-tui's destructive fullRender path, clearing the screen. Introduces stable transition mode that keeps line count constant across the live→finalized boundary, deferring compaction to a safe render cycle.

Fixes #981

---
"@moonshot-ai/kimi-code": patch
---

Fix the TUI getting laggy and CPU-bound in long sessions: frames now skip unchanged transcript lines, and grouping or removing tool entries no longer forces a full transcript re-render.

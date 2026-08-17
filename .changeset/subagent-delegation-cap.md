---
"@moonshot-ai/kimi-code": patch
---

Fix unbounded recursive subagent spawning by capping default agent delegation at a single level; custom agent profiles can still declare their own delegation allowlists (including `*`).

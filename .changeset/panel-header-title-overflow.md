---
"@moonshot-ai/kimi-code": patch
---

Fix the web task detail panel header overflowing on long auto-generated titles: a background Bash task named `Bash: <command…>` pushed the status badge, copy control and close button out of the 460px preview column, leaving the panel impossible to close. The panel title now shrinks with an ellipsis instead.

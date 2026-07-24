---
"@moonshot-ai/kimi-code": patch
---

web: Fix finished foreground subagents remaining stuck as running after turn boundaries or reconnects — reconcile live rows from the authoritative snapshot roster, and never let a late/replayed progress frame downgrade a terminal subagent row back to running.

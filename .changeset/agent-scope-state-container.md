---
"@moonshot-ai/kimi-code": patch
---

Hold per-agent runtime state of the experimental engine in the agent-scope state container, so it is observable in one place and disposed with the agent; state snapshots collapse class instances to name markers so resource graphs cannot exhaust memory during export.

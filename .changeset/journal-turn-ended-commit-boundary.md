---
'@moonshot-ai/core': patch
'@moonshot-ai/agent-core-v2': patch
---

Converge step-hook terminal outcomes in the core loop and commit turn-ended records through the loop journal, publishing the core turn-ended event at the in-memory commit boundary before disk flush.

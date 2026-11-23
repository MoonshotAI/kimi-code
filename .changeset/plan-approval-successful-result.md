---
'@moonshot-ai/agent-core-v2': patch
---

Fix approved plan reviews being reported as rejected tool calls: an approved plan now exits plan mode through normal tool execution and returns the approved plan as a successful result, instead of an error-marked rejection.

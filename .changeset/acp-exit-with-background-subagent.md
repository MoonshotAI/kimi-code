---
'@moonshot-ai/kimi-code': patch
---

`kimi acp` no longer crashes with exit code 1 when the editor closes it while a background subagent is still running, and the agent is no longer told "Reason: [object Object]" about that subagent after the session is reopened.

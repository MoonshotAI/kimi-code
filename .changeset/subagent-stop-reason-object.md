---
'@moonshot-ai/agent-core-v2': patch
---

Stop a background subagent cleanly when its session shuts down: the task notification no longer reports "[object Object]" as the stop reason, and stopping its child tasks no longer looks up services on the subagent scope after that scope was disposed.

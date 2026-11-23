---
'@moonshot-ai/kimi-code': patch
---

Fix ACP clients missing turns the agent starts on its own, such as background-task follow-ups, and silently losing prompts sent while those turns run. Queued prompts now wait for their own turn.

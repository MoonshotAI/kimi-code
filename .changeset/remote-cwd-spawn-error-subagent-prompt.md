---
"@moonshot-ai/kimi-code": patch
---

In remote environments, tool calls and subagent prompts now use the environment's working directory instead of the host's, and a nonexistent working directory fails with an error naming that directory.

---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Re-export the kernel file lock binding hook from the agent engine so the CLI no longer depends on the internal lock package directly.

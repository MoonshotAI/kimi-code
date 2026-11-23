---
"@moonshot-ai/agent-core-v2": patch
---

Preserve the raw tool call argument bytes in recorded loop events so resumed sessions rebuild assistant messages identical to the live ones, including malformed or empty arguments.

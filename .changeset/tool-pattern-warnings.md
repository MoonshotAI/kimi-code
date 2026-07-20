---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Warn when an entry in a tool allow/deny list (an agent file or the `[tools]` config) can never match any tool — for example a misspelled or wrongly-cased name (v2 engine only).

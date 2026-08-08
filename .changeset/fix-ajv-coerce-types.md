---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
---

fix: coerce stringified tool args (numbers, booleans, JSON arrays/objects) before validation instead of rejecting them

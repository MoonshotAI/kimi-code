---
"@moonshot-ai/agent-core-v2": patch
---

Fix Read tool calls being rejected with "must NOT have additional property 'offset'" when a model emits the common `offset`/`limit` aliases instead of `line_offset`/`n_lines`.

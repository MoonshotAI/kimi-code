---
"@moonshot-ai/kimi-code": minor
---

Rework conversation compaction:

- Keep only recent user prompts plus a single user-role summary; drop assistant and tool messages.
- Repair tool_use/tool_result adjacency before sending, fixing a strict-provider HTTP 400 when a tool call and its result became non-adjacent.
- Micro-compaction now defaults off.

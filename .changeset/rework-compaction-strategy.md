---
"@moonshot-ai/kimi-code": minor
---

Rework conversation compaction:

- Keep only recent user prompts plus a single user-role summary; drop assistant and tool messages.
- Repair tool_use/tool_result adjacency before sending, fixing a strict-provider HTTP 400 when a tool call and its result became non-adjacent.
- Merge consecutive user turns for strict providers (Gemini/Vertex), fixing an HTTP 400 ("roles must alternate") after compaction or when a turn is steered in right after a tool result.
- Micro-compaction now defaults off.

---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-agent": patch
---

Goal snapshots on the session surface: the standalone agent's `session.goal.updated` event now carries the full goal snapshot (objective, status, turns/tokens used, budget report, terminal reason) in addition to the bare status string, so a thin client can render goal state — not just a status word. The engine emits its serde form (snake_case fields, PascalCase status); `SessionEventTranslator` maps it onto the SDK `goal.updated` event (camelCase fields, snake_case status values, budget nulls preserved), with a cleared goal mapping to a null snapshot. The bare `status` string is retained for host diagnostics (the print pilot's `[goal]` line and existing integration assertions), so nothing on the status-only path regresses.

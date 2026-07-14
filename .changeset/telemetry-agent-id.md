---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Emit `turn_id` and `agent_id` on turn, tool, and agent-level settings telemetry events (model/thinking/skill/permission toggles) so activity can be attributed to the main agent or a specific subagent within a session.

Extend the same linkage across the rest of the v2 event surface: `parent_tool_call_id` on `subagent_created`; `agent_id`/`turn_id`/`tool_call_id` on permission decisions and approvals; `agent_id` on plan, compaction, context-projection repair, and cron schedule/delete events; `turn_id`/`request_kind` on `api_error` so compaction request failures are distinguishable from turn request failures; `agent_id`/`turn_id` on `tool_call_repeat` while `tool_call_dedup_detected` stops fabricating `turn_id: 0` outside a turn; and `task_id` on background task created/completed events with a unified `kind` vocabulary (`process` replaces the legacy `bash` alias on `background_task_created`). Auto-assigned subagent ids (`agent-N`) now skip ids persisted from previous runs, so a resumed session cannot reissue `agent-0` and collide with earlier telemetry.

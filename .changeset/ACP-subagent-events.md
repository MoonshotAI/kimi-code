---
'@moonshot-ai/kimi-code': patch
---

ACP: forward subagent lifecycle and streams. `subagent.spawned/started/suspended/completed/failed` events are now emitted as ordinary `tool_call`/`tool_call_update` session updates carrying a `_meta.kimiCode.subagent` payload (subagentId, parentToolCallId, summary/usage on completion), and the subagent's own assistant/thinking/tool frames are forwarded with `_meta.kimiCode.subagentId` instead of being dropped at the main-agent guard. Clients that ignore `_meta` see a flat but complete tool stream; the capability is advertised as `agentCapabilities._meta.kimiCode.subagentEvents`.

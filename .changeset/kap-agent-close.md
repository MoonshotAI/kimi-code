---
"@moonshot-ai/kap-server": patch
"@moonshot-ai/agent-core-v2": patch
---

Add `POST /api/v1/sessions/{session_id}/agents/{agent_id}:close` (advertised via `meta.capabilities.agent_close`) backed by `ISessionBtwService.close`, `IAgentLifecycleService.removeById`, and `ISessionMetadata.unregisterAgent` to abort and remove side-channel (`btw`) agents.

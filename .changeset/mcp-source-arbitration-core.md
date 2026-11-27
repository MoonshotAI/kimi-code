---
"@moonshot-ai/agent-core-v2": patch
---

Manage MCP sources per session with priority-ordered registration and per-source enable/disable controls (`disabledMcpSources` on session create/resume), support partial project overrides restricted to `enabled`, `deferred`, `enabledTools`, and `disabledTools`, elect a single winning source per server before connecting with ref-counted shared project connections, and freeze the MCP baseline from startup configs so runtime-registered sources never alter the tool set inherited by fork and btw agents.

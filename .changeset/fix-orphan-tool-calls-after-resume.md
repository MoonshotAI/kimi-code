---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Prevent orphaned tool calls from causing provider errors after resume or compaction, and stop deferred messages from getting stuck when an open tool exchange is compacted away.

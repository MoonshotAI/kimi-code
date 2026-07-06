---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kosong": minor
---

Record a request trace in each agent's `wire.jsonl`: content-addressed snapshots of the tool schemas sent to the model, one record per model request (including retries, strict resends, and compaction rounds) with the effective request parameters, and the raw MCP tool listing per server, so sessions carry enough data to reconstruct every model request for debugging. Chat providers now expose the effective completion-token cap they send on the wire, so the trace records the provider-clamped value rather than the requested budget.

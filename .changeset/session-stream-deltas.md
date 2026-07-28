---
"@moonshot-ai/kimi-agent": patch
---

Streaming deltas for the session-owned agent surface: in native-LLM mode the standalone agent now attaches the `NativeHttpLlm` event sink (previously only the napi bridge did), so `llm.step.begin` / `llm.delta` / `llm.step.end` flow over `host/event`, stamped with the owning `session_id` for multi-session routing. Host-proxy mode intentionally has no sink — the host executes `host/llm_chat` itself and already owns the token stream. `contract.ts` gained the matching `SessionStreamEvent` wire type.

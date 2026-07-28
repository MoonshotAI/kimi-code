---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-agent": patch
---

Print-mode thin-client pilot: `KIMI_SESSION_ENGINE=1 kimi -p "..."` routes the prompt through the engine's session-owned surface — the Rust engine owns the loop, context, goal driving, and persistence, talks to the provider directly over the native-LLM transport, and runs its native toolset; the CLI process only parses arguments and renders streamed `llm.delta`/goal events. Falls back to the normal harness (with a notice) when the pilot is off, no native-LLM-capable provider is configured, or the stdio engine is unavailable. `createSessionClient` gained tool-lifecycle handler passthrough (the print pilot auto-allows, matching permission `auto`), and a new e2e test drives the native-LLM path against a local mock OpenAI SSE server, asserting token-by-token deltas arrive stamped with the owning session id.

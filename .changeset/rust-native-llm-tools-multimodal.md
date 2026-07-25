---
"@moonshot-ai/kimi-code": minor
---

Rust engine: native LLM HTTP transport with SSE streaming (OpenAI-compatible and Anthropic, `agent.nativeLlmProvider`), in-process sandboxed execution of read-only tools Read/Grep/Glob (`agent.nativeTools`), and multimodal (text/image) message content blocks on the Rust wire. Adds a fire-and-forget `host/event` channel so streaming deltas, step boundaries, and natively-executed tool results are still recorded in the host transcript.

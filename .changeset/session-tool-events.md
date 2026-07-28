---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-agent": patch
---

Tool render channel for the session surface (the TUI-integration groundwork): a `ToolEventInterceptor` sits outermost on the standalone agent's callback chain and reports every tool call — wherever it settles (engine-native, goal, MCP, knowledge, or host) — as `session.tool.started` / `session.tool.settled` over `host/event`, with event payloads capped at 2k chars. The CLI gained `SessionEventTranslator`, a stateful bridge from the engine's wire events (`session.*`, `llm.delta`) onto the SDK `Event` union (`turn.started/ended`, `assistant.delta`, `thinking.delta`, `tool.call.started`, `tool.result`) that the existing TUI transcript pipeline consumes — streaming deltas carry no turn id on the wire, so the translator tracks the open turn. Covered by a translator unit test and an extended stdio e2e asserting host-settled tool calls surface as started/settled events.

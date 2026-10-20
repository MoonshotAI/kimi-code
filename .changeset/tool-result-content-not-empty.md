---
"@moonshot-ai/kimi-code": patch
---

Fix sessions permanently failing with HTTP 400 (`tool_result.content: Field required`, or missing tool message content on strict OpenAI-compatible validators such as LiteLLM) when an empty persisted tool result is replayed. A tool result that serialized to empty content was re-lowered into every subsequent request and rejected, so `/compact` and resume kept failing the same way. Empty tool results now lower to a non-empty placeholder text (`Tool output is empty.`) across the Anthropic, OpenAI, OpenAI legacy, and OpenAI Responses request paths, so already-affected sessions self-heal without any migration.

---
"@moonshot-ai/kimi-code": patch
---

Fix sessions getting permanently stuck with HTTP 400 after reading a local video with ReadMediaFile on Anthropic-protocol gateways that reject media inside `tool_result` blocks (e.g. `tool_result.content: Field required`). Since the rejected history is re-lowered into every subsequent request, `/compact` and resume kept failing the same way. Two layers of defense, both self-healing for already-affected sessions with no migration: an empty tool result now lowers to a non-empty placeholder (`Tool output is empty.`) across the Anthropic, OpenAI, and OpenAI Responses request paths; and a gateway rejecting media in a tool result now triggers the media recovery ladder — older media are degraded to placeholders first, and if the rejection persists the rejected media are stripped and the request is retried.

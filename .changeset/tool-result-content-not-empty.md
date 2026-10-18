---
"@moonshot-ai/kimi-code": patch
---

Fix sessions getting permanently stuck with HTTP 400 (`tool_result.content: Field required`) after reading a local video with ReadMediaFile on Anthropic-protocol endpoints. A tool result that serialized to empty content (e.g. a persisted `tool.result` wire record whose output was neither a string nor a part array) was re-lowered into every subsequent request, so `/compact` and resume kept failing. Tool results now lower with a non-empty placeholder (`Tool output is empty.`) when they would otherwise be empty, across the Anthropic, OpenAI, and OpenAI Responses request paths, so already-corrupted sessions self-heal without any migration.

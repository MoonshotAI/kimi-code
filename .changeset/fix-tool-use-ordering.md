---
"@moonshot-ai/kimi-code": patch
---

Fix a strict-provider HTTP 400 caused by a tool call and its result becoming non-adjacent in history (for example a background-task notification or flushed steer landing between them, or a delayed/interrupted result). The projector now repairs tool_use/tool_result adjacency before the conversation is sent to the model, and the compaction summary request closes any still-open tool call with a placeholder result so it stays well-formed. Micro-compaction — which only exposed this latent ordering by busting the prompt cache — now defaults off.

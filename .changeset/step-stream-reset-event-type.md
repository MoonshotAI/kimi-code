---
"@moonshot-ai/agent-core-v2": patch
---

Include the `turn.step.stream_reset` event in the public agent event type. The engine already published it whenever a retried model request discarded a partly streamed response.

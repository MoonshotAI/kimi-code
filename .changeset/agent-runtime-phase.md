---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/protocol": minor
---

Track the agent's live phase (idle, running, streaming, tool call, retrying, awaiting approval, interrupted, ended) as a single model field driven by the existing turn events, and carry it on the status update channel for downstream consumers.

---
"@moonshot-ai/agent-core-v2": patch
---

Fix the v2 messages API serving broken history after resume: restored `blobref:` media URLs are rehydrated to inline `data:` URIs from the agent's blob store (matching live emissions), tool results carrying media (e.g. ReadMediaFile) pass their content parts through instead of being flattened to empty text, and `created_at` uses the wire record time instead of a synthesized session-start offset.

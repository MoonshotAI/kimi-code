---
"@moonshot-ai/agent-core-v2": patch
---

Unify model and provider configuration, catalog queries, protocol metadata, and requester creation into a single app-scoped provider catalog service. Run normal turns and side requests such as prompt prediction and compaction through the loop's shared LLM requester, policies, and run observation hooks instead of requester decorators.

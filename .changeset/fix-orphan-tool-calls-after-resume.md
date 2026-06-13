---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Prevent orphaned tool calls from causing provider errors after resume, compaction, or any projected context that ends with an unclosed tool exchange.

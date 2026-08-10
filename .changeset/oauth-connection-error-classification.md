---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/agent-core-v2": patch
---

Classify OAuth connection failures during a running task as retryable connection errors instead of generic internal errors, so the session pauses with the correct reason rather than breaking on a transient auth-host outage.

---
"@moonshot-ai/kimi-code": patch
---

Isolate workspace-supplied baseline context (AGENTS.md, directory listings, skill listings, session time) in request-time user fragments with untrusted envelopes so it cannot live in the trusted system prompt or override host rules.

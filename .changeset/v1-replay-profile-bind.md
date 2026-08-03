---
"@moonshot-ai/kimi-code-sdk": patch
---

Fix v1 replay ignoring v2 `profile.bind` records, which made sessions resumed from CLI-created wires lose their tool allowlist and send requests without `tools`.

---
"@moonshot-ai/kimi-code": patch
---

Rework the model wire layer in the experimental v2 engine into a small set of protocol bases plus declarative provider trait definitions, so adding a provider no longer means copying adapter code, and per-turn request intent (cache key, thinking effort, sampling) flows as request parameters instead of cloned model objects. The never-functional `[platforms]` config section and the `provider.platformId` field are removed; credential resolution is now a two-layer model → provider lookup.

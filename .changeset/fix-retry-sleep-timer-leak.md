---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
---

fix(core): clear retry sleep timer upon signal cancellation to prevent leaked timers (#4522)

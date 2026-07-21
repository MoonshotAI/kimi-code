---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix config env overrides (such as KIMI_IMAGE_MAX_EDGE_PX or KIMI_LOOP_MAX_STEPS_PER_TURN) sticking after the env var is changed to an invalid value or removed: reads now recompute from the on-disk config, so the value falls back immediately instead of keeping the previous override until the next config reload.

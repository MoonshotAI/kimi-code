---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix environment override values (such as KIMI_IMAGE_MAX_EDGE_PX, KIMI_SUBAGENT_TIMEOUT_MS, KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT) being persisted into config.toml when a config update is written through the server config API while the env var is set.

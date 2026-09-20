---
"@moonshot-ai/kimi-code": patch
---

The SDK config API (`getConfig`, `setConfig`, `parseConfigString`) now reads and validates the `[environments]` section instead of silently dropping it.

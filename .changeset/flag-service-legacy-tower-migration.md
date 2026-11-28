---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kap-server": patch
"@moonshot-ai/acp-server": patch
---

Move legacy `KIMI_CODE_EXPERIMENTAL_FLAG=1` startup migration for `tower` into engine flag initialization backed by the configuration store instead of pre-bootstrap host environment wrappers; symlinked user config files are now left untouched on disk while keeping `tower` active in memory when `KIMI_CODE_EXPERIMENTAL_FLAG=1` is set.

---
"@moonshot-ai/agent-core-v2": patch
---

Fix `getCoreVersion()` to dynamically read the version from `package.json` instead of returning a hardcoded `'0.0.0'`.

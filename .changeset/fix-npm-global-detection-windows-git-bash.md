---
"@moonshot-ai/kimi-code": patch
---

Fix npm-global install source detection when npm prefix fails. The path-based fallback now uses a Windows-specific `npm/node_modules/` pattern (guarded by platform) instead of a broad `node_modules/` suffix, preventing false matches on project-local installs.

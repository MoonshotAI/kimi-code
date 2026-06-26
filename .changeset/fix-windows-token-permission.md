---
"@moonshot-ai/server": patch
"@moonshot-ai/kimi-code": patch
---

Fix the local server failing to start on Windows after the first run because the persistent token file's synthesized mode was rejected as too permissive.

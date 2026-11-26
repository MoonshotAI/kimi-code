---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
---

Add `POST /api/v1/capabilities/{capability_id}:request-permissions` to reopen the macOS Computer Use permission prompt and return refreshed permission status without running capability installation.

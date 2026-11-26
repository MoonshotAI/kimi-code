---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kap-server": minor
---

Add `POST /api/v1/capabilities/{capability_id}:request-permissions` to reopen the macOS Computer Use permission prompt and return refreshed permission status without running capability installation. Explicit requests wait up to 240 seconds for the user, coalesce concurrent calls for the same capability, and treat wait timeouts as unfinished permission state rather than execution errors.

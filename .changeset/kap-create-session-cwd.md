---
"@moonshot-ai/kap-server": patch
---

Report the session's own `cwd` in the `POST /api/v1/sessions` response and the pushed session-created frame, matching `GET`, the session list, and `:wait`, instead of the registered workspace root.

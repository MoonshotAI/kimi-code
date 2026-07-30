---
"@moonshot-ai/kap-server": minor
---

Require a `hostIdentity` when starting the server and derive the default outbound identity headers (User-Agent + `X-Msh-*`) from it, replacing the hardcoded CLI fallback. The `version` option is renamed to `serverVersion`, and session export manifests now record the host product version — plus an optional desktop version for desktop exports — instead of the engine version.

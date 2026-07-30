---
"@moonshot-ai/agent-core-v2": minor
---

Replace the bootstrap `clientVersion` with a required `clientIdentity` host identity object: the OAuth device-flow endpoints now send the full `X-Msh-*` device headers on every host, telemetry reads the client version from the same source, and the session export manifest gains an optional desktop version field.

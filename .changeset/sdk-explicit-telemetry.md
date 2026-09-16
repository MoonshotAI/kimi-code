---
"@moonshot-ai/kimi-code-sdk": minor
---

Require hosts to explicitly pass `telemetry` (a TelemetryClient, or `false` to opt out) when creating a harness — omitting it is now a compile-time type error instead of silently falling back to a no-op client. `TelemetryClient.withContext` is now required as part of the contract, so scoped forwarding never silently drops session/model context for track-only clients.

---
"@moonshot-ai/kimi-code-sdk": minor
---

Require hosts to explicitly pass `telemetry` (a TelemetryClient, or `false` to opt out) when creating a harness — omitting it is now a compile-time type error instead of silently falling back to a no-op client.

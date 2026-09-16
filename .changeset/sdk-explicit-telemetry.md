---
"@moonshot-ai/kimi-code-sdk": minor
---

Require hosts to explicitly pass `telemetry` (a TelemetryClient with `withContext`, or `false` to opt out) when creating a harness, so an omitted option or context-incapable client fails at compile time instead of silently dropping events.
